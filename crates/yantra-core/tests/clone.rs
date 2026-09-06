//! Cloning through a tmux session on a real machine (§B3), Y-344.
//!
//! The unit tests prove the command is quoted; only a real `/bin/sh`, a real
//! tmux and a real `git` can prove that it runs, that `"$HOME"` completes on
//! the far side, that the repository lands where `probe` looks for it, and
//! that asking twice attaches rather than clones twice. The origin is a bare
//! repository inside the container, reached over the container's own sshd
//! with a key the container's user holds — which is ADR-0023 §4 as a test:
//! the machine's credential fetches, and nothing of ours goes with it.

#![allow(clippy::expect_used)]

mod common;

use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::Result;
use common::{SshFixture, USER};
use yantra_core::clone;
use yantra_core::probe;
use yantra_core::ssh::{Exec, Machine, Os, Ssh};
use yantra_core::tmux::Tmux;

const ORIGIN: &str = "ssh://yantra@localhost/tmp/lab-clone/origin.git";

async fn lab(label: &str) -> Result<Option<(SshFixture, Ssh, Tmux)>> {
    let Some(fixture) = SshFixture::start()? else {
        return Ok(None);
    };
    let dir = PathBuf::from("/tmp").join(format!("ya-{label}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    let ssh = Ssh::new(Machine {
        host: fixture.host().to_owned(),
        user: Some(USER.to_owned()),
        port: Some(fixture.port()),
        identity: Some(fixture.key_path()),
        state_dir: dir,
    })?;
    let tmux = Tmux::resolve(&ssh).await?;
    Ok(Some((fixture, ssh, tmux)))
}

/// The fixture image carries neither `git` nor an ssh *client*, and adding
/// them there would rebuild an image every other suite shares. Installed into
/// the running container, which needs a network the run is not promised —
/// so a container without them skips, and says so.
async fn arrange(fixture: &SshFixture, ssh: &Ssh) -> Result<bool> {
    let _ = fixture.arrange_as_root("apk add --no-cache git openssh-client");
    let out = ssh.exec("command -v git && command -v ssh").await?;
    if !out.success() {
        eprintln!("skipped: no git or no ssh client in the fixture container");
        return Ok(false);
    }
    // A key the container's user holds for itself, so `git clone` over ssh
    // inside the container is the machine's own credential and not ours.
    ssh.exec(
        "ssh-keygen -q -t ed25519 -N '' -f ~/.ssh/id_self \
         && cat ~/.ssh/id_self.pub >> ~/.ssh/authorized_keys \
         && printf 'Host localhost\\n  StrictHostKeyChecking no\\n  UserKnownHostsFile /dev/null\\n  IdentityFile ~/.ssh/id_self\\n' > ~/.ssh/config \
         && chmod 600 ~/.ssh/config \
         && rm -rf /tmp/lab-clone ~/cloned && mkdir -p /tmp/lab-clone/seed \
         && cd /tmp/lab-clone/seed && git init -q \
         && git -c user.email=y@example.invalid -c user.name=yantra commit -q --allow-empty -m seed \
         && git clone -q --bare /tmp/lab-clone/seed /tmp/lab-clone/origin.git",
    )
    .await?;
    Ok(true)
}

/// Completion is the pane: under `remain-on-exit` it outlives `git` and
/// carries how git ended (I-4). `probe` sees `origin` before the checkout is
/// done, so it is the *answer* and not the signal.
async fn finished(ssh: &Ssh, tmux: &Tmux, session: &str) -> Result<yantra_core::tmux::Pane> {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let pane = tmux.pane(ssh, session).await?.expect("the pane");
        if pane.dead || Instant::now() > deadline {
            return Ok(pane);
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// The whole verb: the session opens at once, the clone lands where `probe`
/// looks — under a `~/` the far side completed — and a second ask attaches to
/// the session that is already there (I-30).
#[tokio::test]
async fn a_clone_runs_in_its_session_lands_where_probe_looks_and_asks_twice_once() -> Result<()> {
    let Some((fixture, ssh, tmux)) = lab("clone").await? else {
        return Ok(());
    };
    if !arrange(&fixture, &ssh).await? {
        return Ok(());
    }

    let plan = clone::plan(ORIGIN, "~/cloned/origin")?;
    assert_eq!(plan.session, "clone-origin");

    let first = clone::clone_on(&ssh, &tmux, Os::Other, "fixture", &plan).await?;
    assert!(
        first.opened.was_created(),
        "the first ask opens the session"
    );
    assert_eq!(first.session, "clone-origin");

    let pane = finished(&ssh, &tmux, "clone-origin").await?;
    assert!(pane.dead, "git has finished: {pane:?}");
    assert_eq!(pane.status, Some(0), "and cleanly: {pane:?}");

    let found = probe::probe_on(&ssh, "fixture", &format!("/home/{USER}/cloned/origin")).await?;
    assert!(found.exists, "{found:?}");
    assert_eq!(found.origin.as_deref(), Some(ORIGIN), "{found:?}");

    // The session is still there to be watched after the clone has landed,
    // and a second ask attaches to it rather than cloning again.
    let again = clone::clone_on(&ssh, &tmux, Os::Other, "fixture", &plan).await?;
    assert!(!again.opened.was_created(), "the second ask attaches");
    let sessions = tmux.list(&ssh).await?;
    assert_eq!(
        sessions.iter().filter(|s| s.name == "clone-origin").count(),
        1,
        "one session, not two: {sessions:?}"
    );

    tmux.kill(&ssh, "clone-origin").await?;
    Ok(())
}

/// ADR-0018 §1 reaches this verb too: a tmux server started here on macOS
/// would be one every later agent session inherits, so the refusal is `up`'s.
#[tokio::test]
async fn on_macos_with_no_tmux_server_nothing_is_started() -> Result<()> {
    let Some((_fixture, ssh, tmux)) = lab("clone-mac").await? else {
        return Ok(());
    };
    let plan = clone::plan("https://example.invalid/o/r.git", "/tmp/never")?;

    let refused = clone::clone_on(&ssh, &tmux, Os::MacOs, "fixture", &plan)
        .await
        .expect_err("no login server");
    assert!(
        matches!(refused, clone::Error::NoLoginServer { ref machine } if machine == "fixture"),
        "{refused:?}"
    );
    assert!(tmux.list(&ssh).await?.is_empty(), "nothing was created");
    Ok(())
}
