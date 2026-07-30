//! Y-042 against a real tmux in the container, per §B3.
//!
//! The assertions that matter are the invariants: a second `ensure` must attach
//! rather than duplicate (I-1, §B4), and `remain-on-exit` must actually be set
//! on the window (I-4 through I-21).

// `expect` in a test is a deliberate abort with a message.
#![allow(clippy::expect_used)]

mod common;

use anyhow::Result;
use common::{SshFixture, USER};
use yantra_core::ssh::{Exec, Machine, Ssh};
use yantra_core::tmux::{Error, Tmux};

struct Lab {
    /// Held only so the container outlives the test.
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
        let dir = std::path::PathBuf::from("/tmp").join(format!("yt-{label}"));
        if dir.exists() {
            std::fs::remove_dir_all(&dir)?;
        }
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

/// The M1 definition of done: run it twice, get one session.
#[tokio::test]
async fn a_second_ensure_attaches_rather_than_duplicating() -> Result<()> {
    let Some(lab) = Lab::start("idem").await? else {
        return Ok(());
    };

    let first = lab.tmux.ensure(&lab.ssh, "demo", "/tmp", None).await?;
    assert!(first.was_created(), "the first open creates the session");

    let second = lab.tmux.ensure(&lab.ssh, "demo", "/tmp", None).await?;
    assert!(
        !second.was_created(),
        "the second open must attach, not create (I-1, §B4)"
    );
    assert_eq!(
        first.session().session_id,
        second.session().session_id,
        "it is the same session, not a look-alike"
    );

    let sessions = lab
        .ssh
        .exec("tmux list-sessions -F '#{session_name}'")
        .await?;
    let matching = String::from_utf8_lossy(&sessions.stdout)
        .lines()
        .filter(|l| *l == "demo")
        .count();
    assert_eq!(matching, 1, "exactly one session called demo exists");

    lab.tmux.kill(&lab.ssh, "demo").await?;
    Ok(())
}

/// I-4 via I-21. `remain-on-exit` is a *window* option and `=name` is not a
/// valid window target, so this fails if the code addresses by name.
#[tokio::test]
async fn remain_on_exit_is_actually_set_on_the_window() -> Result<()> {
    let Some(lab) = Lab::start("remain").await? else {
        return Ok(());
    };

    let opened = lab.tmux.ensure(&lab.ssh, "keepalive", "/tmp", None).await?;
    let window = &opened.session().window_id;

    let out = lab
        .ssh
        .exec(&format!(
            "tmux show-options -w -t '{window}' remain-on-exit"
        ))
        .await?;
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "remain-on-exit on",
        "a crashed pane would otherwise vanish and look like a clean finish"
    );

    lab.tmux.kill(&lab.ssh, "keepalive").await?;
    Ok(())
}

/// Confirms the worry about ordering is unfounded: a startup command that exits
/// immediately still leaves an inspectable dead pane, so `remain-on-exit` wins
/// the race against a fast exit.
#[tokio::test]
async fn a_startup_command_that_exits_at_once_leaves_a_dead_pane() -> Result<()> {
    let Some(lab) = Lab::start("fastexit").await? else {
        return Ok(());
    };

    let opened = lab
        .tmux
        .ensure(&lab.ssh, "quick", "/tmp", Some("exit 3"))
        .await?;
    let pane = &opened.session().pane_id;

    let out = lab
        .ssh
        .exec(&format!(
            "sleep 1; tmux list-panes -a -F '#{{pane_id}} #{{pane_dead}} #{{pane_dead_status}}' | grep '^{pane} '"
        ))
        .await?;
    let line = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    assert!(
        line.starts_with(&format!("{pane} 1")),
        "the pane should be dead but still present, got `{line}`"
    );
    assert!(
        line.ends_with(" 3"),
        "the exit status should be recoverable, got `{line}`"
    );

    lab.tmux.kill(&lab.ssh, "quick").await?;
    Ok(())
}

#[tokio::test]
async fn the_session_starts_in_the_requested_directory() -> Result<()> {
    let Some(lab) = Lab::start("cwd").await? else {
        return Ok(());
    };
    lab.ssh.exec("mkdir -p '/tmp/a dir'").await?;

    let opened = lab
        .tmux
        .ensure(&lab.ssh, "workdir", "/tmp/a dir", None)
        .await?;
    let out = lab
        .ssh
        .exec(&format!(
            "tmux display-message -p -t '{}' '#{{pane_current_path}}'",
            opened.session().pane_id
        ))
        .await?;
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "/tmp/a dir",
        "a path with a space must survive quoting"
    );

    lab.tmux.kill(&lab.ssh, "workdir").await?;
    Ok(())
}

/// I-2: a name tmux cannot address must be refused before it reaches tmux, not
/// after it has created a permanently unaddressable session.
#[tokio::test]
async fn an_unaddressable_name_is_refused_locally() -> Result<()> {
    let Some(lab) = Lab::start("badname").await? else {
        return Ok(());
    };

    let err = lab
        .tmux
        .ensure(&lab.ssh, "has.dot", "/tmp", None)
        .await
        .expect_err("a dotted name is not addressable");
    assert!(matches!(err, Error::InvalidName { .. }));

    let sessions = lab.ssh.exec("tmux list-sessions").await?;
    assert!(
        !String::from_utf8_lossy(&sessions.stdout).contains("has"),
        "nothing was created on the machine"
    );
    Ok(())
}

/// Prefix matching is why I-2 mandates `=name`: without it `demo` also matches
/// `demo2`, and the wrong session gets killed.
#[tokio::test]
async fn similar_names_are_distinct_sessions() -> Result<()> {
    let Some(lab) = Lab::start("prefix").await? else {
        return Ok(());
    };

    let a = lab.tmux.ensure(&lab.ssh, "demo", "/tmp", None).await?;
    let b = lab.tmux.ensure(&lab.ssh, "demo2", "/tmp", None).await?;
    assert_ne!(
        a.session().session_id,
        b.session().session_id,
        "demo2 is its own session, not a prefix match on demo"
    );

    lab.tmux.kill(&lab.ssh, "demo").await?;
    let still = lab.tmux.ensure(&lab.ssh, "demo2", "/tmp", None).await?;
    assert!(
        !still.was_created(),
        "killing `demo` must not have taken `demo2` with it"
    );

    lab.tmux.kill(&lab.ssh, "demo2").await?;
    Ok(())
}

#[tokio::test]
async fn killing_an_absent_session_is_not_an_error() -> Result<()> {
    let Some(lab) = Lab::start("killabsent").await? else {
        return Ok(());
    };
    lab.tmux.kill(&lab.ssh, "never-existed").await?;
    Ok(())
}
