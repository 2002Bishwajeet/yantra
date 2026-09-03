//! Y-131: what two live tmux clients do to one window.
//!
//! [R2](../../../docs/research/02-tmux-sessions.md) §3 says *"two browser tabs =
//! two tmux clients, so the smaller clamps pane size"*. That is measured here
//! against a real tmux with two real clients — [`yantra_core::pty::Terminal`] is
//! one, which is what an earlier probe lacked — and **it is not what happens**.
//! The window follows the client that was used last, in either direction, and a
//! keystroke on the other one takes it straight back.
//!
//! Nothing in Yantra is configured by any of this. These tests pin the tmux
//! behaviour the browser terminal is built on, so a future change of default
//! fails here rather than on someone's desk.

#![allow(clippy::expect_used)]

mod common;

use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use common::{SshFixture, USER};
use yantra_core::attach;
use yantra_core::pty::{self, Terminal};
use yantra_core::ssh::{Exec, Machine, Ssh};
use yantra_core::terminfo::{self, Chosen};
use yantra_core::tmux::Tmux;

/// Short enough to survive tmux's status-left truncation, which is what a test
/// waits to see before calling a client attached.
const SESSION: &str = "twocli";
const PATIENCE: Duration = Duration::from_secs(15);

const DESKTOP: pty::Size = pty::Size {
    rows: 40,
    cols: 160,
};
const PHONE: pty::Size = pty::Size { rows: 20, cols: 45 };
const WIDER: pty::Size = pty::Size {
    rows: 44,
    cols: 170,
};

/// The status line takes the bottom row, so a window is one row shorter than the
/// client showing it.
fn window_of(size: pty::Size) -> String {
    format!("{}x{}", size.cols, size.rows - 1)
}

struct Lab {
    fixture: SshFixture,
    ssh: Ssh,
    tmux: Tmux,
    /// I-21: `=name` addresses a session and nothing else.
    pane: String,
    session: String,
    dir: std::path::PathBuf,
}

impl Lab {
    async fn start(label: &str) -> Result<Option<Self>> {
        let Some(fixture) = SshFixture::start()? else {
            return Ok(None);
        };
        let dir = std::path::PathBuf::from("/tmp").join(format!("y131-{label}"));
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
        let opened = tmux.ensure(&ssh, SESSION, "/tmp", None).await?;
        Ok(Some(Self {
            fixture,
            ssh,
            tmux,
            pane: opened.session().pane_id.clone(),
            session: opened.session().session_id.clone(),
            dir,
        }))
    }

    fn plan(&self) -> attach::Plan {
        attach::Plan {
            machine: self.fixture.host().to_owned(),
            session: SESSION.to_owned(),
            tmux: self.tmux.clone(),
            term: Chosen::Known(terminfo::FALLBACK.to_owned()),
        }
    }

    /// A client of `size`, waited on until the far side has drawn its status
    /// line — "attached" is a thing tmux has done, not a call that returned.
    async fn client_of(&self, size: pty::Size) -> Result<Terminal> {
        let mut terminal = pty::on(&self.ssh, &self.plan(), size)?;
        let deadline = Instant::now() + PATIENCE;
        let mut seen = String::new();
        while Instant::now() < deadline {
            match tokio::time::timeout(deadline - Instant::now(), terminal.read()).await {
                Ok(Some(bytes)) => seen.push_str(&String::from_utf8_lossy(&bytes)),
                Ok(None) => bail!("the terminal ended before it drew anything: {seen:?}"),
                Err(_) => break,
            }
            if seen.contains(SESSION) {
                return Ok(terminal);
            }
        }
        bail!("a client of {size:?} never attached: {seen:?}")
    }

    async fn ask(&self, command: &str) -> Result<String> {
        let out = self
            .ssh
            .exec(&format!("{} {command}", self.tmux.path()))
            .await?;
        if !out.success() {
            bail!(
                "`tmux {command}` failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
    }

    /// The size of the window every client shares — not of any one client.
    async fn window(&self) -> Result<String> {
        self.ask(&format!(
            "display-message -p -t '{}' '#{{window_width}}x#{{window_height}}'",
            self.pane
        ))
        .await
    }

    async fn attached(&self) -> Result<usize> {
        Ok(self
            .ask(&format!(
                "list-clients -t '{}' -F '#{{client_tty}}'",
                self.session
            ))
            .await?
            .lines()
            .filter(|line| !line.trim().is_empty())
            .count())
    }

    async fn pane_text(&self) -> Result<String> {
        self.ask(&format!("capture-pane -p -t '{}'", self.pane))
            .await
    }

    /// Polled rather than slept through: the interesting failure is "never".
    async fn settles_at(&self, size: &str) -> Result<bool> {
        let deadline = Instant::now() + PATIENCE;
        loop {
            if self.window().await? == size {
                return Ok(true);
            }
            if Instant::now() >= deadline {
                return Ok(false);
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    async fn wait_for_clients(&self, n: usize) -> Result<()> {
        let deadline = Instant::now() + PATIENCE;
        loop {
            if self.attached().await? == n {
                return Ok(());
            }
            if Instant::now() >= deadline {
                bail!("never reached {n} clients");
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
}

impl Drop for Lab {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// **`latest` is the most recently *used* client, not the most recently
/// attached one** — which is the sentence neither R2 nor Y-131's own row had.
/// A phone opening the dashboard does shrink the desktop, and the desktop's
/// next keystroke takes it back while the phone is still attached.
#[tokio::test]
async fn the_window_follows_whichever_client_was_used_last() -> Result<()> {
    let Some(lab) = Lab::start("typed").await? else {
        return Ok(());
    };
    let mut desktop = lab.client_of(DESKTOP).await?;
    assert!(
        lab.settles_at(&window_of(DESKTOP)).await?,
        "one client sizes the window it is the only viewer of"
    );

    let mut phone = lab.client_of(PHONE).await?;
    lab.wait_for_clients(2).await?;
    assert!(
        lab.settles_at(&window_of(PHONE)).await?,
        "attaching is enough to take the window, so the desktop shrinks to a phone"
    );

    desktop.write(b"\n".to_vec()).await?;
    assert!(
        lab.settles_at(&window_of(DESKTOP)).await?,
        "and a keystroke takes it straight back, with no resize involved"
    );
    assert_eq!(
        lab.attached().await?,
        2,
        "which happened without the phone going anywhere"
    );

    phone.write(b"\n".to_vec()).await?;
    assert!(
        lab.settles_at(&window_of(PHONE)).await?,
        "the window belongs to whoever typed last, both ways round"
    );
    Ok(())
}

/// **R2's sentence falsified.** If the *smaller* client clamped the window, a
/// larger latecomer would change nothing. It takes the window like any other.
#[tokio::test]
async fn a_larger_second_client_takes_the_window_too() -> Result<()> {
    let Some(lab) = Lab::start("larger").await? else {
        return Ok(());
    };
    let _phone = lab.client_of(PHONE).await?;
    assert!(lab.settles_at(&window_of(PHONE)).await?);

    let _desktop = lab.client_of(DESKTOP).await?;
    lab.wait_for_clients(2).await?;
    assert!(
        lab.settles_at(&window_of(DESKTOP)).await?,
        "the window grew to the newcomer, so nothing here is clamped by the smaller client"
    );
    Ok(())
}

/// **What the shrinking costs, which is nothing that lasts.** The pane reflows
/// to the narrow client and reflows back when it leaves, with the text intact —
/// so accepting `latest` is not accepting damage.
#[tokio::test]
async fn the_reflow_undoes_itself_when_a_client_leaves() -> Result<()> {
    let Some(lab) = Lab::start("reflow").await? else {
        return Ok(());
    };
    let _desktop = lab.client_of(DESKTOP).await?;
    assert!(lab.settles_at(&window_of(DESKTOP)).await?);

    // A line far wider than the phone, so a reflow is visible in the capture.
    lab.ask(&format!(
        "send-keys -t '{}' 'printf \"%0.sX\" $(seq 1 150); echo ZZEND' Enter",
        lab.pane
    ))
    .await?;
    let widest = |text: &str| text.lines().map(str::len).max().unwrap_or_default();
    assert!(
        lab.settles_at(&window_of(DESKTOP)).await? && widest(&lab.pane_text().await?) == 155,
        "the wide line is on the pane at its full width to begin with"
    );

    let phone = lab.client_of(PHONE).await?;
    lab.wait_for_clients(2).await?;
    assert!(lab.settles_at(&window_of(PHONE)).await?);
    let narrow = lab.pane_text().await?;
    assert_eq!(
        widest(&narrow),
        PHONE.cols as usize,
        "it wraps to the phone"
    );
    assert!(narrow.contains("ZZEND"), "wrapped, not truncated");

    drop(phone);
    assert!(
        lab.settles_at(&window_of(DESKTOP)).await?,
        "the last client left standing gets the window back without being touched"
    );
    let restored = lab.pane_text().await?;
    assert_eq!(widest(&restored), 155, "and the line is unwrapped again");
    assert!(restored.contains("ZZEND"));
    Ok(())
}

/// **The rejected alternative, measured.** `window-size manual` does stop a
/// second client moving the window — by stopping the *first* one moving it too.
/// It is a fixed size Yantra would have to choose, and every client that does
/// not match it sees a crop.
#[tokio::test]
async fn window_size_manual_stops_following_the_only_client_either() -> Result<()> {
    let Some(lab) = Lab::start("manual").await? else {
        return Ok(());
    };
    let desktop = lab.client_of(DESKTOP).await?;
    assert!(lab.settles_at(&window_of(DESKTOP)).await?);

    lab.ask(&format!(
        "set-option -w -t '{}' window-size manual",
        lab.pane
    ))
    .await?;
    lab.ask(&format!(
        "resize-window -t '{}' -x {} -y {}",
        lab.pane,
        DESKTOP.cols,
        DESKTOP.rows - 1
    ))
    .await?;

    let _phone = lab.client_of(PHONE).await?;
    lab.wait_for_clients(2).await?;
    assert!(
        lab.settles_at(&window_of(DESKTOP)).await?,
        "the phone cannot move a manual window, which is the point of it"
    );

    desktop.resize(WIDER)?;
    assert!(
        !lab.settles_at(&window_of(WIDER)).await?,
        "and neither can the desktop — a manual window ignores the person at it"
    );
    assert_eq!(lab.window().await?, window_of(DESKTOP));
    Ok(())
}
