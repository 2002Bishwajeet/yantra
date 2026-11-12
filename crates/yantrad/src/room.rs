//! The rooms this daemon holds in memory, and the wakes a message starts
//! ([ADR-0038](../../../docs/adr/0038-rooms-and-guest-devices.md) decisions 1,
//! 3 and 4). [`yantra_core::room`] decides; this holds the store, wakes the
//! member threads off the request path, and waits in memory for `room_read`.
//!
//! **Only a room's definition is persisted** ([ADR-0039](../../../docs/adr/0039-a-room-is-a-shared-project.md)
//! decision 2), through [`yantra_core::room_file`]. A restart reloads each
//! defined room with one system message, and loses every message, member,
//! cursor, count and pause, and every room an agent made. The log names a
//! room, a seq and counts, and never a message's text or a brief (Q5).

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime};

use tokio::sync::{mpsc, watch};
use yantra_core::notify::{self, Relay};
use yantra_core::room::{
    self, Activity, BUDGET, Home, Info, Message, Present, Reader, Sent, Summary, Thread,
};
use yantra_core::room_file::{self, Definition};

use crate::chat::{self, Woke};

/// Starts a turn in a member thread, or waits for one to start, and says
/// what came of it. A test captures it.
pub(crate) type Wake =
    Arc<dyn Fn(Thread, String) -> Pin<Box<dyn Future<Output = Woke> + Send>> + Send + Sync>;
/// What an owner thread's stream says it is doing. A test answers its own.
pub(crate) type Look = Arc<dyn Fn(&Thread) -> Option<Activity> + Send + Sync>;

#[derive(Clone)]
pub struct Rooms {
    store: Arc<Mutex<room::Rooms>>,
    /// Bumped on every message and every change of a member's own presence,
    /// so a waiting read or events wait looks again.
    said: watch::Sender<u64>,
    wake: Wake,
    look: Look,
    /// [`chat::Registry::changed`], so an events wait sees a thread's turn.
    turned: watch::Receiver<u64>,
    waking: Arc<Mutex<Waking>>,
    pauses: Option<mpsc::UnboundedSender<notify::Message>>,
    /// Where the definitions are. `None` is no config directory, and then a
    /// room cannot be defined.
    dir: Option<PathBuf>,
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
    /// Rooms that wake threads through `chats`, tell `pauses` when a room
    /// waits for the owner, and keep their definitions in `dir`.
    pub fn new(
        chats: chat::Registry,
        pauses: Option<mpsc::UnboundedSender<notify::Message>>,
        dir: Option<PathBuf>,
    ) -> Self {
        let turned = chats.changed();
        let looked = chats.clone();
        let look: Look =
            Arc::new(move |thread: &Thread| looked.activity(&thread.workspace, &thread.thread));
        let wake: Wake = Arc::new(move |thread: Thread, prompt: String| {
            Box::pin(chat::wake(
                chats.clone(),
                thread.workspace,
                thread.thread,
                prompt,
            ))
        });
        Self {
            look,
            turned,
            ..Self::loading(dir, wake, pauses)
        }
    }

    /// These rooms, with `look` for the threads' streams, and `turned` bumped
    /// when it may answer otherwise.
    #[cfg(test)]
    pub(crate) fn looking(self, look: Look, turned: watch::Receiver<u64>) -> Self {
        Self {
            look,
            turned,
            ..self
        }
    }

    #[cfg(test)]
    pub(crate) fn waking(
        wake: Wake,
        pauses: Option<mpsc::UnboundedSender<notify::Message>>,
    ) -> Self {
        Self::loading(None, wake, pauses)
    }

    /// Opens each definition in `dir`, each with the restart's system message.
    pub(crate) fn loading(
        dir: Option<PathBuf>,
        wake: Wake,
        pauses: Option<mpsc::UnboundedSender<notify::Message>>,
    ) -> Self {
        let mut store = room::Rooms::default();
        let listing = match dir.as_deref().map(room_file::list_in) {
            Some(Ok(listing)) => listing,
            Some(Err(error)) => {
                tracing::warn!("the room definitions were not read: {error}");
                room_file::Listing::default()
            }
            None => room_file::Listing::default(),
        };
        let now = SystemTime::now();
        for definition in listing.rooms {
            if let Err(error) = store.open(&definition.name, home(&definition), now, true) {
                tracing::warn!("room {}: not reloaded: {error}", definition.name);
            }
        }
        for (name, error) in &listing.unusable {
            tracing::warn!("room file {name}.toml was skipped: {error}");
        }
        Self {
            store: Arc::new(Mutex::new(store)),
            said: watch::Sender::new(0),
            wake,
            look: Arc::new(|_| None),
            turned: watch::Sender::new(0).subscribe(),
            waking: Arc::default(),
            pauses,
            dir,
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

    /// Whether an agent token for `workspace` reaches the room.
    pub fn admits(&self, name: &str, workspace: &str) -> bool {
        self.lock().admits(name, workspace)
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
        self.bump();
        for thread in workers {
            tokio::spawn(self.clone().work(thread));
        }
    }

    /// What `reader` has not seen, waiting up to `wait` for something new.
    /// `None` is a daemon that began to shut down while it waited. The wait
    /// shows `reader` as listening until it ends, however it ends.
    pub async fn read(
        &self,
        reader: &Reader,
        label: &str,
        name: &str,
        wait: Duration,
        closing: &watch::Sender<bool>,
    ) -> Result<Option<Vec<Message>>, room::Error> {
        let deadline = tokio::time::Instant::now() + wait;
        let mut said = self.said.subscribe();
        let mut closing = closing.subscribe();
        let mut listening = None;
        loop {
            let messages = {
                let mut store = self.lock();
                let made = !store.contains(name);
                let messages = store.read(name, reader, label, SystemTime::now())?;
                if made {
                    tracing::info!("room {name}: made by {}", reader.node);
                }
                messages
            };
            if !messages.is_empty() || tokio::time::Instant::now() >= deadline {
                return Ok(Some(messages));
            }
            listening.get_or_insert_with(|| Listening::open(self, name, reader));
            tokio::select! {
                biased;
                _ = closing.wait_for(|closing| *closing) => return Ok(None),
                _ = tokio::time::timeout_at(deadline, said.changed()) => {}
            }
        }
    }

    /// The room and its members, for `room_info`.
    pub fn info(&self, reader: &Reader, label: &str, name: &str) -> Result<Info, room::Error> {
        self.lock()
            .info(name, reader, label, SystemTime::now(), &*self.look)
    }

    /// What `reader` says it is doing, for `room_status`.
    pub fn status(
        &self,
        reader: &Reader,
        label: &str,
        name: &str,
        doing: &str,
    ) -> Result<(), room::Error> {
        self.lock()
            .status(name, reader, label, doing, SystemTime::now())?;
        self.bump();
        Ok(())
    }

    /// Each member's presence, for the dashboard.
    pub fn presence(&self, name: &str) -> Result<Vec<Present>, room::Error> {
        self.lock().presence(name, SystemTime::now(), &*self.look)
    }

    /// The messages after seq `after`, the members' presence and the last
    /// seq, for the owner's long-poll. It answers at once when a message is
    /// new, and otherwise once one is, presence changes, or `wait` runs out.
    /// `None` is a daemon that began to shut down while it waited.
    pub async fn events(
        &self,
        name: &str,
        after: u64,
        wait: Duration,
        closing: &watch::Sender<bool>,
    ) -> Result<Option<(Vec<Message>, Vec<Present>, u64)>, room::Error> {
        let deadline = tokio::time::Instant::now() + wait;
        let mut said = self.said.subscribe();
        let mut turned = self.turned.clone();
        turned.mark_unchanged();
        let mut closing = closing.subscribe();
        let mut before = None;
        loop {
            let now = SystemTime::now();
            let (messages, present, last, away) = {
                let mut store = self.lock();
                let present = store.presence(name, now, &*self.look)?;
                let (messages, last) = store.since(name, after)?;
                (messages, present, last, store.next_away(name, now))
            };
            let moved = before.as_ref().is_some_and(|before| *before != present);
            if !messages.is_empty() || moved || tokio::time::Instant::now() >= deadline {
                return Ok(Some((messages, present, last)));
            }
            before = Some(present);
            // The next member to turn away changes presence with no call.
            let until = away
                .and_then(|away| away.duration_since(now).ok())
                .map_or(deadline, |left| {
                    deadline.min(tokio::time::Instant::now() + left)
                });
            tokio::select! {
                biased;
                _ = closing.wait_for(|closing| *closing) => return Ok(None),
                _ = tokio::time::sleep_until(until) => {}
                _ = said.changed() => {}
                Ok(()) = turned.changed() => {}
            }
        }
    }

    fn bump(&self) {
        self.said.send_modify(|count| *count += 1);
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
            self.bump();
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

    /// Writes a new definition, then opens the room. Both happen under the
    /// store's lock, so two creates of one name cannot both write.
    pub fn create(&self, definition: &Definition) -> Result<Summary, room_file::Error> {
        let mut store = self.lock();
        room_file::create_in(self.dir()?, definition)?;
        open(&mut store, definition)
    }

    /// Sets the brief of a defined room, on disk first.
    pub fn edit(&self, name: &str, brief: Option<&str>) -> Result<Summary, room_file::Error> {
        let mut store = self.lock();
        let definition = room_file::update_in(self.dir()?, name, brief)?;
        open(&mut store, &definition)
    }

    /// Deletes the definition, then the room. `false` is a room that was in
    /// neither place.
    pub fn end(&self, name: &str) -> Result<bool, room_file::Error> {
        if !room::valid_name(name) {
            return Err(room_file::Error::BadName(name.to_owned()));
        }
        let mut store = self.lock();
        let removed = match &self.dir {
            Some(dir) => room_file::remove_in(dir, name)?,
            None => false,
        };
        Ok(store.close(name) || removed)
    }

    fn dir(&self) -> Result<&std::path::Path, room_file::Error> {
        self.dir.as_deref().ok_or(room_file::Error::NoConfigDir)
    }
}

/// A `room_read` wait that is open, counted in its member's presence until
/// it drops: when the read answers, fails, or the daemon shuts down.
struct Listening<'a> {
    rooms: &'a Rooms,
    name: String,
    reader: Reader,
}

impl<'a> Listening<'a> {
    fn open(rooms: &'a Rooms, name: &str, reader: &Reader) -> Self {
        rooms.lock().listen(name, reader, true);
        rooms.bump();
        Self {
            rooms,
            name: name.to_owned(),
            reader: reader.clone(),
        }
    }
}

impl Drop for Listening<'_> {
    fn drop(&mut self) {
        self.rooms.lock().listen(&self.name, &self.reader, false);
        self.rooms.bump();
    }
}

fn home(definition: &Definition) -> Home {
    Home {
        workspace: definition.workspace.clone(),
        brief: definition.brief.clone(),
        base: definition.base.clone(),
        workspaces: definition.workspaces.clone(),
        made_at: definition.made_at,
    }
}

/// The name passed `room_file`'s check, which is the same predicate.
fn open(store: &mut room::Rooms, definition: &Definition) -> Result<Summary, room_file::Error> {
    store
        .open(&definition.name, home(definition), SystemTime::now(), false)
        .map_err(|_| room_file::Error::BadName(definition.name.clone()))
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
        click: None,
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

    /// Rooms whose wakes land in a list, whose pauses land in a channel, and
    /// whose definitions go to a new scratch directory.
    pub(crate) fn rooms() -> (Rooms, Woken, mpsc::UnboundedReceiver<notify::Message>) {
        let (rooms, woken, heard, _) = answering();
        (rooms, woken, heard)
    }

    /// An empty directory of its own, made on the first write.
    pub(crate) fn scratch() -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "yantrad-rooms-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn no_wake() -> Wake {
        Arc::new(|_, _| Box::pin(async { Woke::Started }))
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
        (
            Rooms::loading(Some(scratch()), wake, Some(pauses)),
            woken,
            heard,
            answer,
        )
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
                .read(member, "m", "r1", Duration::ZERO, &closing)
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
            .read(&b, "m", "r1", Duration::ZERO, &closing)
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
            .read(&b, "m", "r1", Duration::ZERO, &closing)
            .await
            .expect("joins");
        answer(&answers, Woke::Failed);
        rooms.send(&a, "alpha", "r1", "lost?").expect("sent");
        let read = tokio::time::timeout(
            Duration::from_secs(5),
            rooms.read(&b, "m", "r1", Duration::from_secs(50), &closing),
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
            .read(&b, "m", "r1", Duration::ZERO, &closing)
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
            .read(&b, "m", "r1", Duration::ZERO, &closing)
            .await
            .expect("joins");
        answer(&answers, Woke::Never);
        rooms.send(&a, "alpha", "r1", "one").expect("sent");
        assert_eq!(woken(&woke).await.len(), 1);
        rooms.send(&a, "alpha", "r1", "two").expect("sent");
        assert_eq!(woken(&woke).await.len(), 1, "not tried again");
        let read = rooms
            .read(&b, "m", "r1", Duration::ZERO, &closing)
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
            .read(&b, "m", "r1", Duration::ZERO, &closing)
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
            .read(&b, "m", "r2", Duration::ZERO, &watch::Sender::new(false))
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
            .read(&b, "m", "r3", Duration::ZERO, &closing)
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
            .read(&b, "m", "r1", Duration::ZERO, &closing)
            .await
            .expect("joins");
        let sender = rooms.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            sender.send(&a, "alpha", "r1", "late").expect("sent");
        });
        let read = tokio::time::timeout(
            Duration::from_secs(5),
            rooms.read(&b, "m", "r1", Duration::from_secs(50), &closing),
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
            rooms.read(
                &reader("b", None),
                "m",
                "r1",
                Duration::from_secs(50),
                &closing,
            ),
        )
        .await
        .expect("the shutdown ends the wait")
        .expect("no refusal");
        assert_eq!(read, None);
    }

    /// The wait counts while it is open, and stops counting however it ends:
    /// with a message, or with the daemon's shutdown.
    #[tokio::test]
    async fn a_waiting_read_listens_until_it_ends() {
        let (rooms, _, _) = rooms();
        let (a, b) = (reader("alpha", None), reader("beta", None));
        let closing = watch::Sender::new(false);
        rooms
            .read(&b, "beta", "r1", Duration::ZERO, &closing)
            .await
            .expect("joins");
        let state = |rooms: &Rooms| rooms.presence("r1").expect("known")[0].presence.clone();
        assert_eq!(
            state(&rooms),
            room::Presence::Idle,
            "a wait of 0 is no wait"
        );

        let watcher = rooms.clone();
        let sender = rooms.clone();
        let ended = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let heard = state(&watcher);
            sender.send(&a, "alpha", "r1", "hi").expect("sent");
            heard
        });
        rooms
            .read(&b, "beta", "r1", Duration::from_secs(50), &closing)
            .await
            .expect("read")
            .expect("not closing");
        assert_eq!(ended.await.expect("ran"), room::Presence::Listening);
        assert_eq!(state(&rooms), room::Presence::Idle, "the message ended it");

        let ender = closing.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            ender.send_replace(true);
        });
        let read = rooms
            .read(&b, "beta", "r1", Duration::from_secs(50), &closing)
            .await
            .expect("read");
        assert_eq!(read, None);
        assert_eq!(state(&rooms), room::Presence::Idle, "the shutdown ended it");
    }

    fn definition(name: &str) -> Definition {
        Definition {
            name: name.to_owned(),
            workspace: "web".to_owned(),
            brief: None,
            base: None,
            workspaces: Vec::new(),
            made_at: 1_800_000_000,
        }
    }

    #[tokio::test]
    async fn a_restart_reloads_each_definition_with_one_system_message_and_skips_a_bad_file() {
        let dir = scratch();
        for name in ["alpha", "beta"] {
            room_file::create_in(&dir, &definition(name)).expect("written");
        }
        std::fs::write(dir.join("broken.toml"), "workspace = [").expect("written");

        let rooms = Rooms::loading(Some(dir.clone()), no_wake(), None);
        let listed = rooms.list();
        let names: Vec<&str> = listed.iter().map(|room| room.name.as_str()).collect();
        assert_eq!(names, ["alpha", "beta"], "the bad file is skipped");
        for name in names {
            let (summary, log) = rooms.view(name).expect("reloaded");
            assert_eq!(summary.workspace.as_deref(), Some("web"));
            assert_eq!(log.len(), 1, "{log:?}");
            assert_eq!(log[0].kind, room::Kind::System);
            assert!(
                log[0].text.starts_with("yantrad restarted at "),
                "{}",
                log[0].text
            );
        }
    }

    #[tokio::test]
    async fn create_writes_first_refuses_an_existing_name_and_end_removes_both() {
        let dir = scratch();
        let rooms = Rooms::loading(Some(dir.clone()), no_wake(), None);
        let summary = rooms.create(&definition("home")).expect("made");
        assert_eq!(
            (summary.messages, summary.workspace.as_deref()),
            (0, Some("web"))
        );
        assert!(dir.join("home.toml").exists());
        assert!(matches!(
            rooms.create(&definition("home")),
            Err(room_file::Error::Exists(_))
        ));

        let edited = rooms.edit("home", Some("Ship it.")).expect("edited");
        assert_eq!(edited.brief.as_deref(), Some("Ship it."));
        assert!(matches!(
            rooms.edit("nope", Some("x")),
            Err(room_file::Error::Missing(_))
        ));

        assert!(rooms.end("home").expect("ended"));
        assert!(!dir.join("home.toml").exists());
        assert!(rooms.view("home").is_err());
        assert!(!rooms.end("home").expect("absence is success"));
        assert!(matches!(
            rooms.end("Bad"),
            Err(room_file::Error::BadName(_))
        ));

        let nowhere = Rooms::waking(no_wake(), None);
        assert!(matches!(
            nowhere.create(&definition("home")),
            Err(room_file::Error::NoConfigDir)
        ));
    }
}
