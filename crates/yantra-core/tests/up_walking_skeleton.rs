//! M1's definition of done, against a real machine.
//!
//! `up` twice must attach rather than duplicate. Everything else in the
//! milestone exists to make this one assertion trustworthy.

#![allow(clippy::expect_used)]

mod common;

use anyhow::Result;
use common::{SshFixture, USER};
use yantra_core::ssh::{Exec, Machine, Os, Ssh};
use yantra_core::tmux::Tmux;
use yantra_core::up;
use yantra_core::workspace::Workspace;

struct Lab {
    _fixture: SshFixture,
    ssh: Ssh,
    tmux: Tmux,
    dir: std::path::PathBuf,
}

impl Lab {
    async fn start(label: &str) -> Result<Option<Self>> {
        let Some(fixture) = SshFixture::start()? else {
            return Ok(None);
        };
        let dir = std::path::PathBuf::from("/tmp").join(format!("yu-{label}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)?;
        let ssh = Ssh::new(Machine {
            host: fixture.host().to_owned(),
            user: Some(USER.to_owned()),
            port: Some(fixture.port()),
            identity: Some(fixture.key_path()),
            state_dir: dir.clone(),
        })?;
        let tmux = Tmux::resolve(&ssh).await?;
        Ok(Some(Self {
            _fixture: fixture,
            ssh,
            tmux,
            dir,
        }))
    }
}

impl Drop for Lab {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn workspace(name: &str, startup: Option<&str>) -> Workspace {
    Workspace {
        name: name.to_owned(),
        machine: "fixture".to_owned(),
        repo: std::path::PathBuf::from("/tmp"),
        startup: startup.map(str::to_owned),
    }
}

/// The milestone, in one test.
#[tokio::test]
async fn up_twice_attaches_and_does_not_duplicate() -> Result<()> {
    let Some(lab) = Lab::start("skeleton").await? else {
        return Ok(());
    };
    let ws = workspace("skeleton", None);

    let first = up::open(&lab.ssh, &lab.tmux, &ws, None, Os::Other).await?;
    assert!(first.was_created(), "the first up opens the session");

    let second = up::open(&lab.ssh, &lab.tmux, &ws, None, Os::Other).await?;
    assert!(
        !second.was_created(),
        "the second up attaches — this is the whole point of M1"
    );
    assert_eq!(
        first.session().session_id,
        second.session().session_id,
        "and it is the same session"
    );

    let out = lab
        .ssh
        .exec("tmux list-sessions -F '#{session_name}' | grep -c '^skeleton$'")
        .await?;
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "1",
        "exactly one session exists on the machine"
    );

    lab.tmux.kill(&lab.ssh, "skeleton").await?;
    Ok(())
}

/// The startup command must run, and must survive a second `up` without being
/// run again — re-running it would defeat the point of attaching.
#[tokio::test]
async fn startup_runs_once_and_is_not_repeated() -> Result<()> {
    let Some(lab) = Lab::start("startup").await? else {
        return Ok(());
    };
    lab.ssh.exec("rm -f /tmp/ran.log").await?;
    let ws = workspace("startup", Some("echo ran >> /tmp/ran.log; sleep 30"));

    up::open(&lab.ssh, &lab.tmux, &ws, None, Os::Other).await?;
    lab.ssh.exec("sleep 1").await?;
    let again = up::open(&lab.ssh, &lab.tmux, &ws, None, Os::Other).await?;
    assert!(!again.was_created(), "the second open attaches");
    lab.ssh.exec("sleep 1").await?;

    let out = lab.ssh.exec("wc -l < /tmp/ran.log").await?;
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "1",
        "the startup command ran exactly once across two ups"
    );

    lab.tmux.kill(&lab.ssh, "startup").await?;
    Ok(())
}

/// The session opens in the workspace's repo, on the machine — the reason any
/// of this exists.
#[tokio::test]
async fn the_session_opens_in_the_workspace_repo() -> Result<()> {
    let Some(lab) = Lab::start("repo").await? else {
        return Ok(());
    };
    lab.ssh.exec("mkdir -p /tmp/somerepo").await?;
    let mut ws = workspace("repo", None);
    ws.repo = std::path::PathBuf::from("/tmp/somerepo");

    let opened = up::open(&lab.ssh, &lab.tmux, &ws, None, Os::Other).await?;
    let out = lab
        .ssh
        .exec(&format!(
            "tmux display-message -p -t '{}' '#{{pane_current_path}}'",
            opened.session().pane_id
        ))
        .await?;
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "/tmp/somerepo");

    lab.tmux.kill(&lab.ssh, "repo").await?;
    Ok(())
}

/// Y-081. The assertion that matters is the **absence of a session**: a check
/// that ran after the fact would pass just as well against an implementation
/// that opens first and complains second, and that is exactly what the bug was.
///
/// The directory is really missing rather than described as missing, because
/// `new-session -c` on a path that is not there does not fail — it falls back to
/// `$HOME`, and only a real tmux does that.
#[tokio::test]
async fn a_repo_that_is_not_there_is_refused_before_a_session_exists() -> Result<()> {
    let Some(lab) = Lab::start("norepo").await? else {
        return Ok(());
    };
    lab.ssh.exec("rm -rf /tmp/gonerepo").await?;
    let mut ws = workspace("norepo", None);
    ws.repo = std::path::PathBuf::from("/tmp/gonerepo");

    let err = up::open(&lab.ssh, &lab.tmux, &ws, None, Os::Other)
        .await
        .expect_err("a repo the machine does not have cannot be opened");
    assert!(matches!(err, up::Error::NoRepo { .. }), "{err:?}");
    let said = err.to_string();
    for named in ["norepo", "/tmp/gonerepo", "fixture"] {
        assert!(
            said.contains(named),
            "the message must name the workspace, the path and the machine: {said}"
        );
    }

    let sessions = lab.tmux.list(&lab.ssh).await?;
    assert!(
        !sessions.iter().any(|s| s.name == ws.name),
        "nothing may be opened by a refusal — the bug left a live pane in $HOME \
         and reported success: {sessions:?}"
    );

    // The same workspace, once the directory exists: the refusal has to be the
    // check doing its job rather than a blanket one, and §B4 still holds after it.
    lab.ssh.exec("mkdir -p /tmp/gonerepo").await?;
    assert!(
        up::open(&lab.ssh, &lab.tmux, &ws, None, Os::Other)
            .await?
            .was_created(),
        "a repo that is there opens normally"
    );
    assert!(
        !up::open(&lab.ssh, &lab.tmux, &ws, None, Os::Other)
            .await?
            .was_created(),
        "and the second up still attaches"
    );

    lab.tmux.kill(&lab.ssh, &ws.name).await?;
    Ok(())
}

/// **ADR-0018 §1, driven on Linux with `Os::MacOs` as the argument** — which is
/// what the parameter is for: the refusal is about the *far side's* operating
/// system, and no container is a Mac.
///
/// What this proves is the mechanics — that a machine reported as macOS with no
/// tmux server is refused, that one with a server is not, and that the refusal
/// leaves nothing behind. **It proves nothing about launchd**: that a server
/// started from a GUI login is what makes the agent able to read the keychain is
/// only measurable on the Mac itself (`manual_macbook.rs`).
#[tokio::test]
async fn a_macos_machine_with_no_tmux_server_is_refused_rather_than_given_one() -> Result<()> {
    let Some(lab) = Lab::start("macos-precondition").await? else {
        return Ok(());
    };
    let ws = workspace("macprecond", None);
    assert!(
        lab.tmux.list(&lab.ssh).await?.is_empty(),
        "the precondition of this test is a machine with no tmux server at all"
    );

    let err = up::open(&lab.ssh, &lab.tmux, &ws, None, Os::MacOs)
        .await
        .expect_err("a Mac with no server must not be given one");
    assert!(matches!(err, up::Error::NoLoginServer { .. }), "{err:?}");
    assert!(
        err.to_string().contains("fixture"),
        "the refusal names the machine a person has to go and start it on: {err}"
    );
    assert!(
        lab.tmux.list(&lab.ssh).await?.is_empty(),
        "and it started nothing — a refusal that creates the server is the bug"
    );

    // The same call on the same machine reported as anything else: I-1's plain
    // `new-session -d` is reached exactly as before, so Linux is untouched.
    assert!(
        up::open(&lab.ssh, &lab.tmux, &ws, None, Os::Other)
            .await?
            .was_created(),
        "the precondition is macOS-only"
    );

    // And with a server already there, macOS opens in it rather than refusing —
    // otherwise the guard would be *never open on a Mac*.
    let mut second = workspace("macprecond2", None);
    second.machine = ws.machine.clone();
    assert!(
        up::open(&lab.ssh, &lab.tmux, &second, None, Os::MacOs)
            .await?
            .was_created(),
        "a server the login session already started is the state ADR-0018 §1 asks for"
    );

    lab.tmux.kill(&lab.ssh, &ws.name).await?;
    lab.tmux.kill(&lab.ssh, &second.name).await?;
    Ok(())
}

/// The probe §1 rests on, against a real machine. Alpine is not macOS, and the
/// answer has to be that rather than an error — the guard reads
/// [`Os::Other`] as *carry on*.
#[tokio::test]
async fn the_machine_is_asked_what_it_runs_and_answers() -> Result<()> {
    let Some(lab) = Lab::start("uname").await? else {
        return Ok(());
    };
    assert_eq!(yantra_core::ssh::os(&lab.ssh).await?, Os::Other);
    Ok(())
}

/// I-26 on the path the check added. `repo` comes from a file on disk and now
/// reaches a remote shell one command earlier than it used to; the unit test in
/// `up.rs` pins the quoting, and only a real `/bin/sh` can say whether it holds.
#[tokio::test]
async fn a_hostile_repo_path_never_executes_while_being_checked() -> Result<()> {
    let Some(lab) = Lab::start("norepo-inject").await? else {
        return Ok(());
    };
    lab.ssh.exec("rm -f /tmp/upowned").await?;
    let mut ws = workspace("upinject", None);
    ws.repo = std::path::PathBuf::from("/tmp/x'; touch /tmp/upowned; '");

    let err = up::open(&lab.ssh, &lab.tmux, &ws, None, Os::Other)
        .await
        .expect_err("no such directory, whatever else the path contains");
    assert!(matches!(err, up::Error::NoRepo { .. }), "{err:?}");

    let out = lab
        .ssh
        .exec("test -e /tmp/upowned && echo PWNED || echo clean")
        .await?;
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "clean",
        "the payload in a repo path must stay an argument"
    );
    Ok(())
}
