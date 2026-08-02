//! What a caller last learned about the fleet, and when it learned it.
//!
//! A daemon cannot answer a page by calling [`crate::sessions::list`] per
//! request: `ssh.rs` sets `ConnectTimeout=10`, so one asleep or expired-key
//! machine costs ten seconds, and a browser polls whether or not anyone is
//! looking. Something has to look in the background and write down what it saw.
//! This is the writing down.
//!
//! Three things it must not lose, all of them about honesty rather than
//! mechanism:
//!
//! - **Every reading carries its own age.** Serving a two-minute-old session
//!   list as though it were live is a lie, and the fix is a field rather than a
//!   faster poll. [`crate::logs::Transcript::idle_for`] reports a duration for
//!   the same reason.
//! - **A machine that did not answer stays in the reading, with its reason.**
//!   [`crate::sessions::list`] already returns one `Result` per machine; a
//!   cache that keeps only the machines that answered erases the one state
//!   worth acting on.
//! - **"Nobody has looked yet" is [`None`], not an empty [`Vec`]** (I-47).
//!   A look that *failed* is a third answer again, which is why each class
//!   holds the whole `Result` rather than only what succeeded.
//!
//! How often to look is the caller's: this crate hands out no clock and runs no
//! loop of its own.

use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::inventory::{self, MachineInfo};
use crate::sessions::{self, MachineSessions};
use crate::status::{self, MachineStatus};
use crate::workspace::{self, Workspace};

/// One look, and the moment it finished.
///
/// The moment is monotonic and only ever leaves as an age, so a reading cannot
/// become younger because the wall clock moved under it.
#[derive(Debug)]
pub struct Reading<T> {
    value: T,
    taken_at: Instant,
}

impl<T> Reading<T> {
    pub fn new(value: T) -> Self {
        Self {
            value,
            taken_at: Instant::now(),
        }
    }

    pub fn value(&self) -> &T {
        &self.value
    }

    pub fn age(&self) -> Duration {
        self.taken_at.elapsed()
    }
}

/// What the tailnet said, or why it could not be asked.
pub type Machines = Reading<Result<Vec<MachineInfo>, inventory::Error>>;
pub type Workspaces = Reading<Result<Vec<Workspace>, workspace::Error>>;
/// One entry per machine, each carrying its own answer or its own failure.
pub type Sessions = Reading<Result<Vec<MachineSessions>, sessions::Error>>;
/// Also one entry per machine rather than per workspace — see
/// [`crate::status::fleet`] for what that costs and why.
pub type Agents = Reading<Result<Vec<MachineStatus>, status::Error>>;

/// Each class costs something different to look at, so each is looked at on its
/// own and carries its own age. Behind an [`Arc`] so a handler can take the
/// whole snapshot away with it and read it without holding a lock.
#[derive(Debug, Default, Clone)]
pub struct Snapshot {
    pub machines: Option<Arc<Machines>>,
    pub workspaces: Option<Arc<Workspaces>>,
    pub sessions: Option<Arc<Sessions>>,
    pub agents: Option<Arc<Agents>>,
}

#[cfg(test)]
// `expect` in a test is a deliberate abort with a message; the workspace lint
// targets library code, where the same call would take the daemon down.
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn a_reading_carries_its_own_age_and_the_age_moves() {
        let reading = Reading::new("whatever the fleet said");
        let first = reading.age();
        std::thread::sleep(Duration::from_millis(20));
        assert!(reading.age() >= first + Duration::from_millis(20));
    }

    #[test]
    fn a_fresh_snapshot_has_looked_at_nothing() {
        let snapshot = Snapshot::default();
        assert!(snapshot.machines.is_none());
        assert!(snapshot.workspaces.is_none());
        assert!(snapshot.sessions.is_none());
        assert!(snapshot.agents.is_none());
    }

    /// The clone a handler serves is the same reading, not a re-taken one.
    #[test]
    fn cloning_a_snapshot_does_not_reset_an_age() {
        let snapshot = Snapshot {
            workspaces: Some(Arc::new(Reading::new(Ok(Vec::new())))),
            ..Snapshot::default()
        };
        std::thread::sleep(Duration::from_millis(20));

        let served = snapshot.clone();
        let age = served.workspaces.expect("the workspaces were read").age();
        assert!(age >= Duration::from_millis(20));
    }
}
