//! Cloning a repository onto a machine, inside a tmux session there (Y-344).
//!
//! **[`clone`] does not wait for the clone.** A clone of a large repository takes
//! minutes, and a handler that awaited it would hold a request open for all of
//! them ([R13] §4.2). So `git clone` runs as the startup command of a session
//! named `clone-<slug>`: progress is that session's terminal socket
//! ([ADR-0022]), completion is [`crate::probe`], and the session is opened
//! with [`Tmux::ensure`], so asking twice attaches rather than clones twice.
//! [`landed`] is for a caller that must know how git ended: it follows the
//! pane, and no request may await it.
//!
//! **The machine's own git credential does the fetch.** No token of the
//! daemon's goes with the command ([ADR-0023] §4), and a URL carrying one is
//! refused before it reaches a machine — it would sit in the pane's start
//! command for as long as the session lives.
//!
//! [R13]: ../../../docs/research/13-dashboard-revamp-and-github.md
//! [ADR-0022]: ../../../docs/adr/0022-a-socket-may-address-a-session-rather-than-a-workspace.md
//! [ADR-0023]: ../../../docs/adr/0023-the-github-grant-lives-beside-the-relay.md

use std::time::Duration;

use crate::ssh::{self, Exec, Os, Ssh};
use crate::tmux::{self, Opened, Tmux, sq};

/// A clone that passed every check, and nothing else — no machine has been
/// asked yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub url: String,
    /// Absolute, or `~/…`, which the far side's own `$HOME` completes.
    pub path: String,
    /// `clone-<slug>`, in I-2's charset, from the URL's last segment.
    pub session: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cloning {
    pub machine: String,
    pub session: String,
    /// `Attached` is a clone already running there, which is the state asked for.
    pub opened: Opened,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(
        "`{url}` is not a clone URL this verb accepts: `https://host/path`, `ssh://user@host/path` \
         or `user@host:path`, with no credential in it"
    )]
    InvalidUrl { url: String },

    #[error(
        "`{path}` is not a usable destination: absolute or `~/…`, no `..`, and only letters, \
         digits and `-_./+@`"
    )]
    InvalidPath { path: String },

    #[error(transparent)]
    Ssh(#[from] ssh::Error),

    #[error(transparent)]
    Tmux(#[from] tmux::Error),

    /// The same refusal `up` makes: every later agent session inherits the
    /// server this one opens in, so it must be the login session's.
    #[error(
        "`{machine}` runs macOS, and no one is logged in at its screen, so there is no login \
         session for its tmux server (ADR-0018 §1). Log in at that Mac, then try again"
    )]
    NoLoginServer { machine: String },

    #[error("could not determine a directory for ssh control sockets")]
    NoStateDir,
}

/// Checks both values before anything reaches a shell (I-24). The shell only
/// ever sees them quoted (I-26), so the allowlists are a second wall and not
/// the first — what they add is refusing a URL that carries a credential and a
/// path that climbs.
pub fn plan(url: &str, path: &str) -> Result<Plan, Error> {
    if !valid_url(url) {
        return Err(Error::InvalidUrl {
            url: url.to_owned(),
        });
    }
    if !valid_path(path) {
        return Err(Error::InvalidPath {
            path: path.to_owned(),
        });
    }
    Ok(Plan {
        url: url.to_owned(),
        path: path.to_owned(),
        session: format!("clone-{}", slug(url)),
    })
}

fn word(value: &str, extra: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('-')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || extra.contains(c))
}

fn valid_url(url: &str) -> bool {
    if let Some(rest) = url.strip_prefix("https://") {
        // No `@`: userinfo is the one place a token travels in an https URL.
        return word(rest, "-._~/:+") && !rest.starts_with('/');
    }
    if let Some(rest) = url.strip_prefix("ssh://") {
        let (user, host) = rest.split_once('@').unwrap_or(("git", rest));
        return word(user, "-._") && word(host, "-._~/:+") && !host.starts_with('/');
    }
    // scp-like `user@host:path`, which is what GitHub prints.
    let Some((user, rest)) = url.split_once('@') else {
        return false;
    };
    let Some((host, path)) = rest.split_once(':') else {
        return false;
    };
    word(user, "-._") && word(host, "-.") && word(path, "-._~/+")
}

fn valid_path(path: &str) -> bool {
    let rest = match path.strip_prefix("~/") {
        Some(rest) => rest,
        None => match path.strip_prefix('/') {
            Some(rest) => rest,
            None => return false,
        },
    };
    !rest.is_empty()
        && rest
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./+@".contains(c))
        && rest
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

/// The repository's name as a session name: `https://github.com/o/Yantra.git`
/// is `yantra`. Two URLs with one last segment share a session, and that is
/// I-30's answer rather than a bug — the second asks for what the first is
/// already doing.
fn slug(url: &str) -> String {
    let last = url
        .trim_end_matches('/')
        .rsplit(['/', ':'])
        .next()
        .unwrap_or_default();
    let last = last.strip_suffix(".git").unwrap_or(last);
    let slug: String = last
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .take(40)
        .collect();
    let slug = slug.trim_matches('-');
    if slug.is_empty() {
        "repo".to_owned()
    } else {
        slug.to_owned()
    }
}

/// `~/` is completed by the far side, because `sq` would make the `~` a
/// literal and the shell only expands it bare — and `$HOME` there is a value
/// this side never composes (ADR-0009).
pub(crate) fn destination(path: &str) -> String {
    match path.strip_prefix("~/") {
        Some(rest) => format!("\"$HOME\"/{}", sq(rest)),
        None => sq(path),
    }
}

/// `--progress` because a pane is a terminal and the person watching it is
/// the whole reason the clone runs in one; `--` because the URL is a value.
fn command(plan: &Plan) -> String {
    format!(
        "git clone --progress -- {} {}",
        sq(&plan.url),
        destination(&plan.path)
    )
}

pub async fn clone(machine: &str, plan: &Plan) -> Result<Cloning, Error> {
    let ssh = Ssh::new(ssh::machine_at(machine).ok_or(Error::NoStateDir)?)?;
    let tmux = Tmux::resolve(&ssh).await?;
    let os = ssh::os(&ssh).await?;
    clone_on(&ssh, &tmux, os, machine, plan).await
}

/// The testable half, driven by the container fixture. `os` is a parameter for
/// [`crate::up::open`]'s reason: the macOS refusal is drivable from Linux.
pub async fn clone_on<E: Exec>(
    exec: &E,
    tmux: &Tmux,
    os: Os,
    machine: &str,
    plan: &Plan,
) -> Result<Cloning, Error> {
    if os == Os::MacOs && !tmux.login_server(exec).await? {
        return Err(Error::NoLoginServer {
            machine: machine.to_owned(),
        });
    }
    // `/` as the working directory: the destination does not exist yet, and
    // `new-session -c` falls back to `$HOME` silently on a path that is not
    // there, which would hide a typo `git clone` then reports anyway.
    let opened = tmux
        .ensure(exec, &plan.session, "/", Some(&command(plan)))
        .await?;
    Ok(Cloning {
        machine: machine.to_owned(),
        session: plan.session.clone(),
        opened,
    })
}

/// The dashboard's own probe interval.
const LOOK: Duration = Duration::from_secs(3);

/// Follows the clone that `cloning` started until its pane ends, and answers
/// whether `git clone` exited 0. It sets no time limit; the caller does.
pub async fn landed(cloning: &Cloning) -> Result<bool, Error> {
    let ssh = Ssh::new(ssh::machine_at(&cloning.machine).ok_or(Error::NoStateDir)?)?;
    let tmux = Tmux::resolve(&ssh).await?;
    landed_on(&ssh, &tmux, cloning, LOOK).await
}

/// The testable half. The exit status is the only proof it reads: the command
/// names the URL and the path, and an agent in the folder cannot change how
/// git ended. `probe` cannot say this, because `origin` is there before the
/// fetch is done. A session that is gone, or one with another pane, is not
/// this clone, so it did not land.
pub async fn landed_on<E: Exec>(
    exec: &E,
    tmux: &Tmux,
    cloning: &Cloning,
    every: Duration,
) -> Result<bool, Error> {
    let started = &cloning.opened.session().pane_id;
    loop {
        let pane = tmux.pane(exec, &cloning.session).await?;
        let Some(pane) = pane.filter(|pane| pane.id == *started) else {
            return Ok(false);
        };
        if pane.dead {
            return Ok(pane.status == Some(0));
        }
        tokio::time::sleep(every).await;
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use crate::tmux::fake::{Mac, Server};

    async fn cloned(mac: &Mac) -> Result<Cloning, Error> {
        let tmux = Tmux::resolve(mac).await.expect("a tmux");
        let plan = plan("https://github.com/o/r.git", "~/src/r").expect("planned");
        clone_on(mac, &tmux, Os::MacOs, "mac", &plan).await
    }

    #[tokio::test]
    async fn a_mac_with_no_server_clones_once_the_launch_agent_starts_one() {
        let mac = Mac::new(Server::None, 0);
        let cloning = cloned(&mac).await.expect("cloning");
        assert!(cloning.opened.was_created());
        assert!(mac.asked_for("launchctl bootstrap") && mac.asked_for("new-session"));
    }

    #[tokio::test]
    async fn a_mac_with_an_empty_server_clones() {
        let mac = Mac::new(Server::Empty, 3);
        cloned(&mac).await.expect("cloning");
        assert!(mac.asked_for("new-session"));
    }

    #[tokio::test]
    async fn no_one_at_a_macs_screen_is_refused_and_nothing_starts() {
        let mac = Mac::new(Server::None, 3);
        let err = cloned(&mac).await.expect_err("refused");
        assert!(matches!(err, Error::NoLoginServer { .. }), "{err:?}");
        assert!(!mac.asked_for("new-session"));

        let err = cloned(&Mac::new(Server::None, 1))
            .await
            .expect_err("refused");
        assert!(
            matches!(err, Error::Tmux(tmux::Error::Command { .. })),
            "{err:?}"
        );
    }

    #[test]
    fn the_three_git_spellings_are_accepted_and_nothing_else_is() {
        for good in [
            "https://github.com/2002Bishwajeet/yantra.git",
            "https://github.com/2002Bishwajeet/yantra",
            "ssh://git@github.com/2002Bishwajeet/yantra.git",
            "ssh://yantra@localhost/tmp/origin.git",
            "git@github.com:2002Bishwajeet/yantra.git",
        ] {
            assert!(plan(good, "/srv/x").is_ok(), "{good}");
        }
        for bad in [
            "",
            "github.com/o/r",
            "http://github.com/o/r",
            "file:///etc",
            "/srv/repo",
            "https://",
            "https:///o/r",
            "https://user:token@github.com/o/r.git",
            "ssh://user:pw@host/o/r.git",
            "https://github.com/o/r.git; rm -rf ~",
            "https://github.com/o/r.git'",
            "https://github.com/o/r`id`",
            "https://github.com/o/r$(id)",
            "git@github.com:o/r.git x",
            "-oProxyCommand=id@github.com:o/r",
            "--upload-pack=id@host:o/r",
        ] {
            assert!(
                matches!(plan(bad, "/srv/x"), Err(Error::InvalidUrl { .. })),
                "{bad:?} must be refused"
            );
        }
    }

    #[test]
    fn a_destination_is_absolute_or_under_home_and_never_climbs() {
        for good in [
            "/srv/x",
            "/home/u/Github/yantra",
            "~/Github/yantra",
            "~/.local/src/x",
        ] {
            assert!(plan("https://h/o/r", good).is_ok(), "{good}");
        }
        for bad in [
            "",
            "~",
            "~/",
            "/",
            "relative/path",
            "~user/x",
            "/srv/../etc",
            "~/../x",
            "/srv/./x",
            "/srv//x",
            "/srv/x/",
            "/srv/a b",
            "/srv/x;id",
            "/srv/$HOME",
            "/srv/`id`",
            "/srv/x'",
            "/srv/x\"",
            "/srv/x\n",
            "/srv/x*",
        ] {
            assert!(
                matches!(plan("https://h/o/r", bad), Err(Error::InvalidPath { .. })),
                "{bad:?} must be refused"
            );
        }
    }

    #[test]
    fn the_session_is_named_after_the_repository_in_i2s_charset() {
        let named = |url: &str| plan(url, "/srv/x").expect("a good url").session;
        assert_eq!(named("https://github.com/o/Yantra.git"), "clone-yantra");
        assert_eq!(named("git@github.com:o/my.repo"), "clone-my-repo");
        assert_eq!(named("https://github.com/o/r/"), "clone-r");
        assert_eq!(named("https://github.com/o/-.git"), "clone-repo");
    }

    /// Asserted whole, as [`crate::up`] does: a correctly quoted command still
    /// *contains* the value, so a substring search proves nothing. A real
    /// `/bin/sh` settles it in `tests/clone.rs`.
    #[test]
    fn the_command_quotes_the_url_and_completes_home_on_the_far_side() {
        let home = plan("https://github.com/o/r.git", "~/src/r").expect("planned");
        assert_eq!(
            command(&home),
            r#"git clone --progress -- 'https://github.com/o/r.git' "$HOME"/'src/r'"#
        );
        let absolute = plan("git@github.com:o/r.git", "/srv/r").expect("planned");
        assert_eq!(
            command(&absolute),
            "git clone --progress -- 'git@github.com:o/r.git' '/srv/r'"
        );
    }

    /// A machine whose clone session answers each `list-panes` in turn.
    struct Panes(std::sync::Mutex<Vec<(i32, &'static str, &'static str)>>);

    impl Exec for Panes {
        async fn exec(&self, command: &str) -> Result<ssh::Output, ssh::Error> {
            let (status, stdout, stderr) = if command.contains("command -v tmux") {
                (0, "Linux\n/usr/bin/tmux\n", "")
            } else {
                self.0.lock().expect("the answers").remove(0)
            };
            Ok(ssh::Output {
                status,
                stdout: stdout.as_bytes().to_vec(),
                stderr: stderr.as_bytes().to_vec(),
            })
        }
    }

    async fn landed_after(answers: &[(i32, &'static str, &'static str)]) -> bool {
        let machine = Panes(std::sync::Mutex::new(answers.to_vec()));
        let tmux = Tmux::resolve(&machine).await.expect("a tmux");
        let cloning = Cloning {
            machine: "m".to_owned(),
            session: "clone-r".to_owned(),
            opened: Opened::Created(tmux::Session {
                name: "clone-r".to_owned(),
                session_id: "$1".to_owned(),
                window_id: "@1".to_owned(),
                pane_id: "%1".to_owned(),
            }),
        };
        let landed = landed_on(&machine, &tmux, &cloning, Duration::ZERO).await;
        assert!(machine.0.lock().expect("the answers").is_empty());
        landed.expect("an answer")
    }

    const RUNNING: (i32, &str, &str) = (0, "%1|0|||41|git clone\n", "");

    #[tokio::test]
    async fn a_clone_lands_when_git_exits_0_and_not_before() {
        assert!(landed_after(&[RUNNING, RUNNING, (0, "%1|1|0|||git clone\n", "")]).await);
    }

    /// Y-782: `destination path already exists` is status 128, and the folder
    /// then holds whatever it held before.
    #[tokio::test]
    async fn a_clone_that_git_refused_or_that_was_killed_did_not_land() {
        assert!(!landed_after(&[RUNNING, (0, "%1|1|128|||git clone\n", "")]).await);
        assert!(!landed_after(&[(0, "%1|1||15||git clone\n", "")]).await);
    }

    #[tokio::test]
    async fn a_session_that_is_gone_or_holds_another_pane_did_not_land() {
        assert!(!landed_after(&[RUNNING, (1, "", "can't find session: clone-r")]).await);
        assert!(!landed_after(&[(0, "%7|1|0|||git clone\n", "")]).await);
    }
}
