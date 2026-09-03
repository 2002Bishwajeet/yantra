//! Asking a machine about a path, before a workspace names it.
//!
//! `up` already asks this question — `test -d`, at [`crate::up`] — but it asks
//! it *after* the workspace file exists, so a mistyped path is discovered by the
//! verb that was supposed to start working. This module asks first, which is
//! what lets a form offer a choice instead of a blank field (Y-185, owner's
//! *less filling, more selecting*).
//!
//! **This is a read, and it is reached over a `POST`.** That is settled in
//! [ADR-0019]: the answer depends on a path nobody has typed yet, so no snapshot
//! can hold it, and a `GET` that awaited ssh is the bug `yantrad`'s rule exists
//! to prevent. The rule is unchanged; this says which side of it an on-demand
//! probe was always on.
//!
//! [ADR-0019]: ../../../docs/adr/0019-a-probe-that-asks-a-machine-is-a-post.md

use crate::ssh::{self, Exec, Ssh};
use crate::tmux;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Probe {
    pub machine: String,
    pub path: String,
    /// Whether the directory is there. A path that is a *file* answers `false`:
    /// `test -d` is the question `up` asks, and matching it is the point.
    pub exists: bool,
    /// `origin`'s URL when the directory is a git repository that has one.
    /// `None` covers three different things — not a repository, a repository
    /// with no `origin`, and a directory that is not there — and the caller
    /// separates them by reading [`Probe::exists`] first.
    pub origin: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Ssh(#[from] ssh::Error),

    #[error("could not determine a directory for ssh control sockets")]
    NoStateDir,
}

pub async fn probe(machine: &str, path: &str) -> Result<Probe, Error> {
    let ssh = Ssh::new(ssh::machine_at(machine).ok_or(Error::NoStateDir)?)?;
    probe_on(&ssh, machine, path).await
}

/// The testable half, driven by the container fixture.
pub async fn probe_on<E: Exec>(exec: &E, machine: &str, path: &str) -> Result<Probe, Error> {
    let out = exec.exec(&command(path)).await?;
    let mut lines = String::from_utf8_lossy(&out.stdout);
    let answer = parse(lines.to_mut());
    Ok(Probe {
        machine: machine.to_owned(),
        path: path.to_owned(),
        exists: answer.0,
        origin: answer.1,
    })
}

/// One round trip rather than two. The second question only makes sense when
/// the first answers yes, and a person is waiting on both.
///
/// `git`'s own failure is swallowed deliberately: *not a repository* and *a
/// repository with no origin* are both "no origin here", and neither is a
/// reason to fail a probe whose first question already succeeded.
fn command(path: &str) -> String {
    let quoted = tmux::sq(path);
    format!(
        "if test -d {quoted}; then printf 'yes\\n'; git -C {quoted} remote get-url origin \
         2>/dev/null || true; else printf 'no\\n'; fi"
    )
}

fn parse(stdout: &str) -> (bool, Option<String>) {
    let mut lines = stdout.lines();
    let exists = lines.next().is_some_and(|first| first.trim() == "yes");
    let origin = lines
        .next()
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .map(str::to_owned);
    (exists, origin)
}

#[cfg(test)]
// `expect` in a test is a deliberate abort with a message; the workspace lint
// targets library code, where the same call would take the daemon down.
#[allow(clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn a_repository_answers_both_questions() {
        assert_eq!(
            parse("yes\nhttps://github.com/o/r.git\n"),
            (true, Some("https://github.com/o/r.git".to_owned()))
        );
    }

    #[test]
    fn a_directory_that_is_not_a_repository_still_exists() {
        assert_eq!(parse("yes\n"), (true, None));
    }

    #[test]
    fn a_missing_directory_has_no_origin_to_report() {
        assert_eq!(parse("no\n"), (false, None));
    }

    /// The two `None`s above mean different things, and only `exists`
    /// separates them — which is why the struct carries both.
    #[test]
    fn absent_and_not_a_repository_are_distinguishable() {
        assert_ne!(parse("yes\n").0, parse("no\n").0);
    }

    /// A path is a value from a person, so it reaches a remote shell quoted —
    /// the crate's rule for anything that gets there.
    #[test]
    fn a_path_is_quoted_before_it_reaches_a_shell() {
        let built = command("/tmp/a b; rm -rf /");
        assert!(
            built.contains("'/tmp/a b; rm -rf /'"),
            "the whole path is one quoted word: {built}"
        );
    }
}
