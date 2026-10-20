//! The rooms this daemon holds in memory, and the wakes a message starts
//! ([ADR-0038](../../../docs/adr/0038-rooms-and-guest-devices.md) decisions 1,
//! 3 and 4). [`yantra_core::room`] decides; this holds the store, wakes the
//! member threads off the request path, and waits in memory for `room_read`.
//!
//! **Nothing here is persisted**, so a restart loses every room, member,
//! cursor, count and pause. The log names a room, a seq and counts, and never a
//! message's text (Q5).

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime};

use tokio::sync::{mpsc, watch};
use yantra_core::notify::{self, Relay};
use yantra_core::room::{self, BUDGET, Message, Reader, Sent, Thread};

use crate::chat;

/// Starts or queues a turn in a member thread, and says whether it did. A
/// test captures it.
type Wake = Arc<dyn Fn(Thread, String) -> Pin<Box<dyn Future<Output = bool> + Send>> + Send + Sync>;

#[derive(Clone)]
pub struct Rooms {
    store: Arc<Mutex<room::Rooms>>,
    /// Bumped on every message, so a waiting read looks again.
    said: watch::Sender<u64>,
    wake: Wake,
    pauses: Option<mpsc::UnboundedSender<notify::Message>>,
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

    fn waking(wake: Wake, pauses: Option<mpsc::UnboundedSender<notify::Message>>) -> Self {
        Self {
            store: Arc::default(),
            said: watch::Sender::new(0),
            wake,
            pauses,
        }
    }

    fn lock(&self) -> MutexGuard<'_, room::Rooms> {
        self.store.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Takes `text` from `reader`, labelled `from`, and wakes each member
    /// thread with what it has not seen. Never awaits: each wake is a task,
    /// and a wake that fails gives its messages back to that thread.
    pub fn send(
        &self,
        reader: &Reader,
        from: &str,
        name: &str,
        text: &str,
    ) -> Result<Sent, room::Error> {
        let now = SystemTime::now();
        let (sent, made, prompts) = {
            let mut store = self.lock();
            let made = !store.contains(name);
            let sent = store
                .send(name, reader, from, text, now)
                .inspect_err(|error| {
                    if matches!(error, room::Error::Paused(_)) {
                        tracing::info!("room {name}: a message was refused, because it is paused");
                    }
                })?;
            // Taken under the same lock as the send, so each thread gets a
            // message once and in order.
            let prompts: Vec<(Reader, Vec<u64>, String)> = sent
                .wake
                .iter()
                .filter_map(|member| {
                    let messages = store.deliver(name, member, sent.seq);
                    let seqs = messages.iter().map(|message| message.seq).collect();
                    (!messages.is_empty()).then(|| (member.clone(), seqs, prompt(name, &messages)))
                })
                .collect();
            (sent, made, prompts)
        };
        if made {
            tracing::info!("room {name}: made by {}", reader.node);
        }
        tracing::info!(
            "room {name}: message {} from {}, {} delivered, {} woken",
            sent.seq,
            reader.node,
            sent.delivered,
            prompts.len()
        );
        self.said.send_modify(|count| *count += 1);
        for (member, seqs, prompt) in prompts {
            let Some(thread) = member.thread.clone() else {
                continue;
            };
            let woke = (self.wake)(thread, prompt);
            let rooms = self.clone();
            let name = name.to_owned();
            tokio::spawn(async move {
                if !woke.await {
                    rooms.lock().give_back(&name, &member, &seqs);
                    rooms.said.send_modify(|count| *count += 1);
                    tracing::info!("room {name}: {} given back to a thread", seqs.len());
                }
            });
        }
        if sent.paused {
            tracing::info!("room {name}: paused after {BUDGET} agent messages");
            if let Some(pauses) = &self.pauses {
                let _ = pauses.send(paused(name));
            }
        }
        Ok(sent)
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
    use std::sync::atomic::{AtomicBool, Ordering};

    pub(crate) type Woken = Arc<Mutex<Vec<(Thread, String)>>>;

    /// Rooms whose wakes land in a list, and whose pauses land in a channel.
    pub(crate) fn rooms() -> (Rooms, Woken, mpsc::UnboundedReceiver<notify::Message>) {
        let (rooms, woken, heard, _) = failing();
        (rooms, woken, heard)
    }

    /// [`rooms`], with a switch that makes each later wake fail.
    fn failing() -> (
        Rooms,
        Woken,
        mpsc::UnboundedReceiver<notify::Message>,
        Arc<AtomicBool>,
    ) {
        let woken = Woken::default();
        let into = Arc::clone(&woken);
        let fails = Arc::new(AtomicBool::new(false));
        let failed = Arc::clone(&fails);
        let (pauses, heard) = mpsc::unbounded_channel();
        let wake: Wake = Arc::new(move |thread, prompt| {
            into.lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push((thread, prompt));
            let woke = !failed.load(Ordering::SeqCst);
            Box::pin(async move { woke })
        });
        (Rooms::waking(wake, Some(pauses)), woken, heard, fails)
    }

    pub(crate) fn woken(woken: &Woken) -> Vec<(Thread, String)> {
        woken.lock().unwrap_or_else(PoisonError::into_inner).clone()
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
            woken(&woke),
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
        let (rooms, woke, _, fails) = failing();
        let (a, b) = (reader("alpha", None), reader("beta", Some("B")));
        let closing = watch::Sender::new(false);
        rooms
            .read(&b, "r1", Duration::ZERO, &closing)
            .await
            .expect("joins");
        fails.store(true, Ordering::SeqCst);
        rooms.send(&a, "alpha", "r1", "lost?").expect("sent");
        assert_eq!(woken(&woke).len(), 1, "a wake was tried");
        let read = tokio::time::timeout(
            Duration::from_secs(5),
            rooms.read(&b, "r1", Duration::from_secs(50), &closing),
        )
        .await
        .expect("the give-back ends the wait")
        .expect("read")
        .expect("not closing");
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].text, "lost?");

        fails.store(false, Ordering::SeqCst);
        rooms.send(&a, "alpha", "r1", "next").expect("sent");
        tokio::task::yield_now().await;
        let read = rooms
            .read(&b, "r1", Duration::ZERO, &closing)
            .await
            .expect("read")
            .expect("not closing");
        assert!(read.is_empty(), "a wake that took keeps the cursor moved");
    }

    #[tokio::test]
    async fn no_thread_wakes_on_its_own_message() {
        let (rooms, woke, _) = rooms();
        let a = reader("alpha", Some("A"));
        rooms.send(&a, "a", "r1", "one").expect("sent");
        rooms.send(&a, "a", "r1", "two").expect("sent");
        assert!(woken(&woke).is_empty());
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
        assert_eq!(woken(&woke).len(), 19, "the 20th wakes nothing");
        assert_eq!(
            rooms.send(&a, "alpha", "r2", "secret 21"),
            Err(room::Error::Paused("r2".to_owned()))
        );
        assert_eq!(woken(&woke).len(), 19);

        let told = heard.try_recv().expect("one notification");
        assert!(told.body.contains("r2"), "{}", told.body);
        assert!(!told.body.contains("secret"), "{}", told.body);
        assert!(heard.try_recv().is_err(), "only one");

        rooms.resume("r2").expect("known");
        rooms.send(&a, "alpha", "r2", "again").expect("sent");
        assert_eq!(woken(&woke).len(), 20);
        assert_eq!(
            rooms.resume("nope"),
            Err(room::Error::Unknown("nope".to_owned()))
        );
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
