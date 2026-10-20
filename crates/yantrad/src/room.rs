//! The rooms this daemon holds in memory, and the wakes a message starts
//! ([ADR-0038](../../../docs/adr/0038-rooms-and-guest-devices.md) decisions 1,
//! 3 and 4). [`yantra_core::room`] decides; this holds the store, wakes the
//! member threads off the request path, and waits in memory for `room_read`.
//!
//! **Nothing here is persisted**, so a restart loses every room, member,
//! cursor, count and pause. The log names a room, a seq and counts, and never a
//! message's text (Q5).

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime};

use tokio::sync::{mpsc, watch};
use yantra_core::notify::{self, Relay};
use yantra_core::room::{self, BUDGET, Message, Reader, Sent, Summary, Thread};

use crate::chat::{self, Woke};

/// Starts a turn in a member thread, or waits for one to start, and says
/// what came of it. A test captures it.
pub(crate) type Wake =
    Arc<dyn Fn(Thread, String) -> Pin<Box<dyn Future<Output = Woke> + Send>> + Send + Sync>;

#[derive(Clone)]
pub struct Rooms {
    store: Arc<Mutex<room::Rooms>>,
    /// Bumped on every message, so a waiting read looks again.
    said: watch::Sender<u64>,
    wake: Wake,
    waking: Arc<Mutex<Waking>>,
    pauses: Option<mpsc::UnboundedSender<notify::Message>>,
}

/// One delivery to a member thread, kept until its wake resolves so a wake
/// that fails gives its messages back.
struct Job {
    room: String,
    member: Reader,
    seqs: Vec<u64>,
    prompt: String,
}

#[derive(Default)]
struct Waking {
    /// The jobs each thread has yet to be woken with. A thread is a key while
    /// its one worker runs, so its wakes go one at a time, in seq order.
    queued: HashMap<Thread, Vec<Job>>,
    /// Threads no wake reaches: ACP threads and threads that are gone. Their
    /// messages wait for a read.
    unreachable: HashSet<Thread>,
}

impl std::fmt::Debug for Rooms {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Rooms").finish_non_exhaustive()
    }
}

impl Rooms {
    /// Rooms that wake threads through `chats`, and tell `pauses` when a room
    /// waits for the owner.
    pub fn new(
        chats: chat::Registry,
        pauses: Option<mpsc::UnboundedSender<notify::Message>>,
    ) -> Self {
        let wake: Wake = Arc::new(move |thread: Thread, prompt: String| {
            Box::pin(chat::wake(
                chats.clone(),
                thread.workspace,
                thread.thread,
                prompt,
            ))
        });
        Self::waking(wake, pauses)
    }

    pub(crate) fn waking(
        wake: Wake,
        pauses: Option<mpsc::UnboundedSender<notify::Message>>,
    ) -> Self {
        Self {
            store: Arc::default(),
            said: watch::Sender::new(0),
            wake,
            waking: Arc::default(),
            pauses,
        }
    }

    fn lock(&self) -> MutexGuard<'_, room::Rooms> {
        self.store.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn jobs(&self) -> MutexGuard<'_, Waking> {
        self.waking.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Takes `text` from `reader`, labelled `from`, and wakes each member
    /// thread with what it has not seen. Never awaits: each thread's wakes run
    /// in one task, one after another, and a wake that does not start a turn
    /// gives its messages back to that thread.
    pub fn send(
        &self,
        reader: &Reader,
        from: &str,
        name: &str,
        text: &str,
    ) -> Result<Sent, room::Error> {
        let now = SystemTime::now();
        let (sent, made, woken, workers) = {
            let mut store = self.lock();
            let made = !store.contains(name);
            let sent = store
                .send(name, reader, from, text, now)
                .inspect_err(|error| {
                    if matches!(error, room::Error::Paused(_)) {
                        tracing::info!("room {name}: a message was refused, because it is paused");
                    }
                })?;
            let (woken, workers) = self.queue(&mut store, name, &sent);
            (sent, made, woken, workers)
        };
        if made {
            tracing::info!("room {name}: made by {}", reader.node);
        }
        tracing::info!(
            "room {name}: message {} from {}, {} delivered, {} woken",
            sent.seq,
            reader.node,
            sent.delivered,
            woken
        );
        self.start(workers);
        if sent.paused {
            tracing::info!("room {name}: paused after {BUDGET} agent messages");
            if let Some(pauses) = &self.pauses {
                let _ = pauses.send(paused(name));
            }
        }
        Ok(sent)
    }

    /// A person's message from the dashboard: the count goes back to 0, the
    /// pause lifts, and every member thread wakes as it would for a send.
    pub fn post(&self, name: &str, from: &str, text: &str) -> Result<Sent, room::Error> {
        let (sent, woken, workers) = {
            let mut store = self.lock();
            let sent = store.post(name, from, text, SystemTime::now())?;
            let (woken, workers) = self.queue(&mut store, name, &sent);
            (sent, woken, workers)
        };
        tracing::info!(
            "room {name}: message {} from the owner, {} delivered, {} woken",
            sent.seq,
            sent.delivered,
            woken
        );
        self.start(workers);
        Ok(sent)
    }

    /// Every room, for the dashboard.
    pub fn list(&self) -> Vec<Summary> {
        self.lock().list(SystemTime::now())
    }

    /// One room and the messages it keeps, for the dashboard.
    pub fn view(&self, name: &str) -> Result<(Summary, Vec<Message>), room::Error> {
        self.lock().view(name, SystemTime::now())
    }

    /// Queues each thread `sent` wakes with what it has not seen, and says how
    /// many were queued and which threads need a worker. It runs under the
    /// store's lock, so each thread gets a message once and in seq order.
    fn queue(&self, store: &mut room::Rooms, name: &str, sent: &Sent) -> (usize, Vec<Thread>) {
        let mut waking = self.jobs();
        let (mut woken, mut workers) = (0, Vec::new());
        for member in &sent.wake {
            let Some(thread) = member.thread.clone() else {
                continue;
            };
            if waking.unreachable.contains(&thread) {
                continue;
            }
            let messages = store.deliver(name, member, sent.seq);
            if messages.is_empty() {
                continue;
            }
            let job = Job {
                room: name.to_owned(),
                member: member.clone(),
                seqs: messages.iter().map(|message| message.seq).collect(),
                prompt: prompt(name, &messages),
            };
            woken += 1;
            match waking.queued.entry(thread) {
                Entry::Occupied(mut queued) => queued.get_mut().push(job),
                Entry::Vacant(free) => {
                    workers.push(free.key().clone());
                    free.insert(vec![job]);
                }
            }
        }
        (woken, workers)
    }

    /// Tells waiting reads to look again, and starts a worker per new thread.
    fn start(&self, workers: Vec<Thread>) {
        self.said.send_modify(|count| *count += 1);
        for thread in workers {
            tokio::spawn(self.clone().work(thread));
        }
    }

    /// What `reader` has not seen, waiting up to `wait` for something new.
    /// `None` is a daemon that began to shut down while it waited.
    pub async fn read(
        &self,
        reader: &Reader,
        name: &str,
        wait: Duration,
        closing: &watch::Sender<bool>,
    ) -> Result<Option<Vec<Message>>, room::Error> {
        let deadline = tokio::time::Instant::now() + wait;
        let mut said = self.said.subscribe();
        let mut closing = closing.subscribe();
        loop {
            let messages = {
                let mut store = self.lock();
                let made = !store.contains(name);
                let messages = store.read(name, reader, SystemTime::now())?;
                if made {
                    tracing::info!("room {name}: made by {}", reader.node);
                }
                messages
            };
            if !messages.is_empty() || tokio::time::Instant::now() >= deadline {
                return Ok(Some(messages));
            }
            tokio::select! {
                biased;
                _ = closing.wait_for(|closing| *closing) => return Ok(None),
                _ = tokio::time::timeout_at(deadline, said.changed()) => {}
            }
        }
    }

    /// Wakes `thread` with everything queued for it, until nothing is. The
    /// key leaves the map under the same lock a send queues under, so no job
    /// is left without a worker.
    async fn work(self, thread: Thread) {
        loop {
            let jobs = {
                let mut waking = self.jobs();
                match waking.queued.get_mut(&thread) {
                    Some(jobs) if !jobs.is_empty() => std::mem::take(jobs),
                    _ => {
                        waking.queued.remove(&thread);
                        return;
                    }
                }
            };
            let prompt = jobs
                .iter()
                .map(|job| job.prompt.as_str())
                .collect::<Vec<_>>()
                .join("\n\n");
            let woke = (self.wake)(thread.clone(), prompt).await;
            if woke == Woke::Started {
                continue;
            }
            if woke == Woke::Never {
                self.jobs().unreachable.insert(thread.clone());
            }
            {
                let mut store = self.lock();
                for job in &jobs {
                    store.give_back(&job.room, &job.member, &job.seqs);
                }
            }
            self.said.send_modify(|count| *count += 1);
            let given: usize = jobs.iter().map(|job| job.seqs.len()).sum();
            tracing::info!(
                "chat {}: {given} room messages given back to thread {}",
                thread.workspace,
                thread.thread
            );
        }
    }

    /// The owner acted: the count goes back to 0 and the pause lifts.
    pub fn resume(&self, name: &str) -> Result<(), room::Error> {
        self.lock().resume(name)
    }
}

/// One prompt for every message a thread has not seen, each wrapped.
fn prompt(name: &str, messages: &[Message]) -> String {
    messages
        .iter()
        .map(|message| room::wrap(name, message))
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// It names the room and no word of a message (Q5).
fn paused(name: &str) -> notify::Message {
    notify::Message {
        body: format!(
            "Room {name} paused after {BUDGET} agent messages. Resume it with: yantra room resume {name}"
        ),
        title: Some("A room waits for you".to_owned()),
        priority: None,
    }
}

/// Sends each pause to the relay, one at a time, for the life of the daemon.
pub async fn tell(relay: Relay, mut pauses: mpsc::UnboundedReceiver<notify::Message>) {
    while let Some(message) = pauses.recv().await {
        if let Err(error) = notify::post(&relay, message).await {
            tracing::warn!("a room's pause was not notified: {error}");
        }
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)]
pub(crate) mod tests {
    use super::*;

    pub(crate) type Woken = Arc<Mutex<Vec<(Thread, String)>>>;
    type Answer = Arc<Mutex<Woke>>;

    /// Rooms whose wakes land in a list, and whose pauses land in a channel.
    pub(crate) fn rooms() -> (Rooms, Woken, mpsc::UnboundedReceiver<notify::Message>) {
        let (rooms, woken, heard, _) = answering();
        (rooms, woken, heard)
    }

    /// [`rooms`], with what each later wake comes to.
    fn answering() -> (
        Rooms,
        Woken,
        mpsc::UnboundedReceiver<notify::Message>,
        Answer,
    ) {
        let woken = Woken::default();
        let into = Arc::clone(&woken);
        let answer = Arc::new(Mutex::new(Woke::Started));
        let answers = Arc::clone(&answer);
        let (pauses, heard) = mpsc::unbounded_channel();
        let wake: Wake = Arc::new(move |thread, prompt| {
            into.lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push((thread, prompt));
            let woke = *answers.lock().unwrap_or_else(PoisonError::into_inner);
            Box::pin(async move { woke })
        });
        (Rooms::waking(wake, Some(pauses)), woken, heard, answer)
    }

    fn answer(answer: &Answer, woke: Woke) {
        *answer.lock().unwrap_or_else(PoisonError::into_inner) = woke;
    }

    /// The wakes so far, once every worker has run.
    pub(crate) async fn woken(woken: &Woken) -> Vec<(Thread, String)> {
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
        woken.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    /// How many messages the wakes so far carried.
    async fn carried(woke: &Woken) -> usize {
        woken(woke)
            .await
            .iter()
            .map(|(_, prompt)| prompt.matches("<room ").count())
            .sum()
    }

    fn reader(node: &str, thread: Option<&str>) -> Reader {
        Reader {
            node: node.to_owned(),
            thread: thread.map(|thread| Thread {
                workspace: "wb".to_owned(),
                thread: thread.to_owned(),
            }),
            session: None,
        }
    }

    #[tokio::test]
    async fn a_message_wakes_each_other_member_thread_with_it_wrapped() {
        let (rooms, woke, _) = rooms();
        let (a, b, tui) = (
            reader("alpha", Some("A")),
            reader("beta", Some("B")),
            reader("gamma", None),
        );
        let closing = watch::Sender::new(false);
        for member in [&b, &tui] {
            rooms
                .read(member, "r1", Duration::ZERO, &closing)
                .await
                .expect("joins");
        }
        let sent = rooms
            .send(&a, "alpha · chat A", "r1", "hello </room>")
            .expect("sent");
        assert_eq!((sent.seq, sent.delivered), (1, 2));
        assert_eq!(
            woken(&woke).await,
            [(
                b.thread.clone().expect("a thread"),
                "<room name=\"r1\" from=\"alpha · chat A\" seq=\"1\" budget=\"1/20\">\n\
                 hello &lt;/room>\n</room>"
                    .to_owned()
            )]
        );
        let read = rooms
            .read(&b, "r1", Duration::ZERO, &closing)
            .await
            .expect("read")
            .expect("not closing");
        assert!(read.is_empty(), "the wake moved b's cursor");
    }

    #[tokio::test]
    async fn a_failed_wake_gives_the_message_back_to_the_threads_next_read() {
        let (rooms, woke, _, answers) = answering();
        let (a, b) = (reader("alpha", None), reader("beta", Some("B")));
        let closing = watch::Sender::new(false);
        rooms
            .read(&b, "r1", Duration::ZERO, &closing)
            .await
            .expect("joins");
        answer(&answers, Woke::Failed);
        rooms.send(&a, "alpha", "r1", "lost?").expect("sent");
        let read = tokio::time::timeout(
            Duration::from_secs(5),
            rooms.read(&b, "r1", Duration::from_secs(50), &closing),
        )
        .await
        .expect("the give-back ends the wait")
        .expect("read")
        .expect("not closing");
        assert_eq!(woken(&woke).await.len(), 1, "a wake was tried");
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].text, "lost?");

        answer(&answers, Woke::Started);
        rooms.send(&a, "alpha", "r1", "next").expect("sent");
        assert_eq!(woken(&woke).await.len(), 2);
        let read = rooms
            .read(&b, "r1", Duration::ZERO, &closing)
            .await
            .expect("read")
            .expect("not closing");
        assert!(read.is_empty(), "a wake that took keeps the cursor moved");
    }

    /// An ACP thread or a gone one: its messages wait for a read, and no
    /// later message tries to wake it, so nothing piles up to give back.
    #[tokio::test]
    async fn a_thread_no_wake_reaches_is_not_woken_again() {
        let (rooms, woke, _, answers) = answering();
        let (a, b) = (reader("alpha", None), reader("beta", Some("B")));
        let closing = watch::Sender::new(false);
        rooms
            .read(&b, "r1", Duration::ZERO, &closing)
            .await
            .expect("joins");
        answer(&answers, Woke::Never);
        rooms.send(&a, "alpha", "r1", "one").expect("sent");
        assert_eq!(woken(&woke).await.len(), 1);
        rooms.send(&a, "alpha", "r1", "two").expect("sent");
        assert_eq!(woken(&woke).await.len(), 1, "not tried again");
        let read = rooms
            .read(&b, "r1", Duration::ZERO, &closing)
            .await
            .expect("read")
            .expect("not closing");
        let texts: Vec<&str> = read.iter().map(|message| message.text.as_str()).collect();
        assert_eq!(texts, ["one", "two"]);
    }

    /// The review's finding: one task per send let a thread get seq 2 before
    /// seq 1. Now a thread's second wake waits for its first to resolve.
    #[tokio::test]
    async fn one_threads_wakes_go_one_at_a_time_in_seq_order() {
        let woken = Woken::default();
        let into = Arc::clone(&woken);
        let gate = Arc::new(tokio::sync::Notify::new());
        let opens = Arc::clone(&gate);
        let wake: Wake = Arc::new(move |thread, prompt| {
            into.lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push((thread, prompt));
            let opens = Arc::clone(&opens);
            Box::pin(async move {
                opens.notified().await;
                Woke::Started
            })
        });
        let rooms = Rooms::waking(wake, None);
        let (a, b) = (reader("alpha", None), reader("beta", Some("B")));
        let closing = watch::Sender::new(false);
        rooms
            .read(&b, "r1", Duration::ZERO, &closing)
            .await
            .expect("joins");
        rooms.send(&a, "alpha", "r1", "first").expect("sent");
        assert_eq!(
            super::tests::woken(&woken).await.len(),
            1,
            "the first wake waits"
        );
        rooms.send(&a, "alpha", "r1", "second").expect("sent");
        let seen = super::tests::woken(&woken).await;
        assert_eq!(seen.len(), 1, "the second waits: {seen:?}");
        assert!(seen[0].1.contains("seq=\"1\""), "{}", seen[0].1);
        gate.notify_one();
        let seen = super::tests::woken(&woken).await;
        assert_eq!(seen.len(), 2, "{seen:?}");
        assert!(seen[1].1.contains("seq=\"2\""), "{}", seen[1].1);
        assert!(!seen[1].1.contains("seq=\"1\""), "{}", seen[1].1);
        gate.notify_one();
    }

    #[tokio::test]
    async fn no_thread_wakes_on_its_own_message() {
        let (rooms, woke, _) = rooms();
        let a = reader("alpha", Some("A"));
        rooms.send(&a, "a", "r1", "one").expect("sent");
        rooms.send(&a, "a", "r1", "two").expect("sent");
        assert!(woken(&woke).await.is_empty());
    }

    #[tokio::test]
    async fn a_paused_room_wakes_nothing_and_tells_the_owner_once_without_its_text() {
        let (rooms, woke, mut heard) = rooms();
        let (a, b) = (reader("alpha", None), reader("beta", Some("B")));
        rooms
            .read(&b, "r2", Duration::ZERO, &watch::Sender::new(false))
            .await
            .expect("joins");
        for n in 1..=BUDGET {
            rooms
                .send(&a, "alpha", "r2", &format!("secret {n}"))
                .expect("sent");
        }
        assert_eq!(carried(&woke).await, 19, "the 20th wakes nothing");
        assert_eq!(
            rooms.send(&a, "alpha", "r2", "secret 21"),
            Err(room::Error::Paused("r2".to_owned()))
        );
        assert_eq!(carried(&woke).await, 19);

        let told = heard.try_recv().expect("one notification");
        assert!(told.body.contains("r2"), "{}", told.body);
        assert!(!told.body.contains("secret"), "{}", told.body);
        assert!(heard.try_recv().is_err(), "only one");

        rooms.resume("r2").expect("known");
        rooms.send(&a, "alpha", "r2", "again").expect("sent");
        assert_eq!(carried(&woke).await, 21, "the 20th went with the next wake");
        assert_eq!(
            rooms.resume("nope"),
            Err(room::Error::Unknown("nope".to_owned()))
        );
    }

    #[tokio::test]
    async fn a_persons_post_lifts_the_pause_and_wakes_every_member_thread() {
        let (rooms, woke, _) = rooms();
        let (a, b) = (reader("alpha", Some("A")), reader("beta", Some("B")));
        let closing = watch::Sender::new(false);
        rooms
            .read(&b, "r3", Duration::ZERO, &closing)
            .await
            .expect("joins");
        for _ in 0..BUDGET {
            rooms.send(&a, "alpha", "r3", "m").expect("sent");
        }
        let before = woken(&woke).await.len();
        let sent = rooms.post("r3", "owner on phone", "go on").expect("posted");
        assert_eq!((sent.delivered, sent.paused), (2, false));
        let woke = woken(&woke).await;
        let mut threads: Vec<&str> = woke[before..]
            .iter()
            .map(|(thread, _)| thread.thread.as_str())
            .collect();
        threads.sort_unstable();
        assert_eq!(threads, ["A", "B"], "the sender of the 20th wakes too");
        assert!(
            woke.last()
                .is_some_and(|(_, prompt)| prompt.contains("from=\"owner on phone\"")
                    && prompt.contains("budget=\"0/20\"")),
            "{woke:?}"
        );
        rooms
            .send(&a, "alpha", "r3", "again")
            .expect("the pause lifted");
        assert_eq!(
            rooms.post("nope", "owner", "hi"),
            Err(room::Error::Unknown("nope".to_owned()))
        );
        assert_eq!(rooms.list().len(), 1);
        let (summary, messages) = rooms.view("r3").expect("known");
        assert_eq!((summary.spent, summary.members), (1, 2));
        assert_eq!(messages.len(), usize::try_from(BUDGET).expect("small") + 2);
    }

    #[tokio::test]
    async fn a_waiting_read_returns_the_message_that_arrives() {
        let (rooms, _, _) = rooms();
        let (a, b) = (reader("alpha", None), reader("beta", None));
        let closing = watch::Sender::new(false);
        rooms
            .read(&b, "r1", Duration::ZERO, &closing)
            .await
            .expect("joins");
        let sender = rooms.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            sender.send(&a, "alpha", "r1", "late").expect("sent");
        });
        let read = tokio::time::timeout(
            Duration::from_secs(5),
            rooms.read(&b, "r1", Duration::from_secs(50), &closing),
        )
        .await
        .expect("the message ends the wait")
        .expect("read")
        .expect("not closing");
        assert_eq!(read[0].text, "late");
    }

    #[tokio::test]
    async fn a_waiting_read_ends_when_the_daemon_shuts_down() {
        let (rooms, _, _) = rooms();
        let closing = watch::Sender::new(false);
        let ender = closing.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            ender.send_replace(true);
        });
        let read = tokio::time::timeout(
            Duration::from_secs(5),
            rooms.read(&reader("b", None), "r1", Duration::from_secs(50), &closing),
        )
        .await
        .expect("the shutdown ends the wait")
        .expect("no refusal");
        assert_eq!(read, None);
    }
}
