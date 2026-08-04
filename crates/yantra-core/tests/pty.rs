//! Y-127: does `^C` written to a pseudo-terminal reach a process running inside
//! a tmux pane on the far side?
//!
//! R2 §3 chose a daemon-side PTY and graded the finding **[D]** — nothing was
//! run — and I-18 says the PTY must give its child a controlling terminal or the
//! interrupt is lost. This is a spike: no module is added, and the deliverable is
//! what the four connections below measure.
//!
//! **The process must die.** A test that finds `^C` echoed on the screen proves
//! nothing: an echoed keystroke that interrupted nothing is precisely the failure
//! I-18 describes.
//!
//! The four arms differ only in how the local `ssh` is given a terminal — the
//! session, the victim and the remote command are identical in all of them, and
//! the remote command comes from [`attach::remote_command`] rather than being
//! written out here (I-34, I-35, I-36/I-43).

#![allow(clippy::expect_used)]

mod common;

use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use common::{SshFixture, USER};
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use yantra_core::attach;
use yantra_core::ssh::{Exec, Machine, Ssh};
use yantra_core::terminfo;
use yantra_core::tmux::Tmux;

const SESSION: &str = "ptyspike";
/// Long enough that only a signal can end it inside the test's lifetime, and
/// distinctive enough to find by name.
const VICTIM: &str = "sleep 300";
const ETX: u8 = 0x03;
/// How long any awaited state gets. Polled, never slept through: the interesting
/// failure is "never", not "not yet".
const PATIENCE: Duration = Duration::from_secs(15);
/// Deliberately not openssh's 80x24 default, so a client of this size is
/// evidence the local window reached the far side.
const WINDOW: PtySize = PtySize {
    rows: 30,
    cols: 100,
    pixel_width: 0,
    pixel_height: 0,
};
const RESIZED: PtySize = PtySize {
    rows: 40,
    cols: 120,
    pixel_width: 0,
    pixel_height: 0,
};

/// How tmux spells a client's size back.
fn size_of(window: PtySize) -> String {
    format!("{}x{}", window.cols, window.rows)
}

struct Lab {
    fixture: SshFixture,
    ssh: Ssh,
    tmux: Tmux,
    /// I-21: `=name` addresses a session and nothing else, so everything asked
    /// about the pane is asked by `%id`.
    pane: String,
    session: String,
    dir: std::path::PathBuf,
}

impl Lab {
    async fn start(label: &str) -> Result<Option<Self>> {
        let Some(fixture) = SshFixture::start()? else {
            return Ok(None);
        };
        let dir = std::path::PathBuf::from("/tmp").join(format!("yp-{label}"));
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

    /// The connection parameters the fixture uses, so the developer's `~/.ssh` is
    /// neither read nor consulted, plus the one thing `Exec` will not do.
    fn ssh_args(&self, tty: bool) -> Vec<String> {
        let mut args = vec![
            "-F".to_owned(),
            "/dev/null".to_owned(),
            "-i".to_owned(),
            self.fixture.key_path().display().to_string(),
            "-p".to_owned(),
            self.fixture.port().to_string(),
        ];
        for opt in [
            "IdentitiesOnly=yes",
            "IdentityAgent=none",
            "StrictHostKeyChecking=no",
            "UserKnownHostsFile=/dev/null",
            "GlobalKnownHostsFile=/dev/null",
            "BatchMode=yes",
            "ConnectTimeout=5",
            "LogLevel=ERROR",
        ] {
            args.push("-o".to_owned());
            args.push(opt.to_owned());
        }
        if tty {
            args.push("-tt".to_owned());
        } else {
            args.push("-o".to_owned());
            args.push("RequestTTY=no".to_owned());
        }
        args.push(format!("{USER}@{}", self.fixture.host()));
        args.push("--".to_owned());
        args.push(attach::remote_command(
            self.tmux.path(),
            SESSION,
            terminfo::FALLBACK,
        ));
        args
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

    async fn display(&self, format: &str) -> Result<String> {
        self.ask(&format!("display-message -p -t '{}' '{format}'", self.pane))
            .await
    }

    /// What the far side thinks the terminal on this end is, which is empty
    /// until something attaches.
    async fn client_size(&self) -> Result<String> {
        self.ask(&format!(
            "list-clients -t '{}' -F '#{{client_width}}x#{{client_height}}'",
            self.session
        ))
        .await
    }

    async fn start_the_victim(&self) -> Result<()> {
        self.ask(&format!("send-keys -t '{}' '{VICTIM}' Enter", self.pane))
            .await?;
        if !self
            .wait_for(|lab| Box::pin(lab.victim_is_running()))
            .await?
        {
            bail!("`{VICTIM}` never started in the pane");
        }
        Ok(())
    }

    async fn victim_is_running(&self) -> Result<bool> {
        Ok(self.ssh.exec("pgrep -x sleep").await?.success())
    }

    /// Both spellings of gone: no process by that name, and the pane back to its
    /// shell. Either alone can be true while the other is not.
    async fn victim_is_gone(&self) -> Result<bool> {
        Ok(!self.victim_is_running().await?
            && self.display("#{pane_current_command}").await? != "sleep")
    }

    async fn a_client_is_attached(&self) -> Result<bool> {
        Ok(self.display("#{session_attached}").await? != "0")
    }

    async fn wait_for<F>(&self, mut condition: F) -> Result<bool>
    where
        F: for<'a> FnMut(
            &'a Self,
        )
            -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<bool>> + 'a>>,
    {
        let deadline = Instant::now() + PATIENCE;
        loop {
            if condition(self).await? {
                return Ok(true);
            }
            if Instant::now() >= deadline {
                return Ok(false);
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

/// One local `ssh`, however its terminal was arranged, with a thread draining
/// whatever it prints so a full buffer can never block the far side.
struct Link {
    stdin: Box<dyn Write + Send>,
    seen: Arc<Mutex<Vec<u8>>>,
    process: Process,
    master: Option<Box<dyn MasterPty + Send>>,
}

enum Process {
    Pty(Box<dyn portable_pty::Child + Send + Sync>),
    Pipes(std::process::Child),
}

impl Link {
    /// R2 §3(a): the pty is opened and the child spawned into it, which is what
    /// makes it the child's controlling terminal. `controlling` is the half I-18
    /// names — `false` is the implementation the invariant was written about.
    fn through_a_pty(lab: &Lab, controlling: bool) -> Result<Self> {
        let pair = native_pty_system().openpty(WINDOW)?;
        let mut command = CommandBuilder::new("ssh");
        for arg in lab.ssh_args(true) {
            command.arg(arg);
        }
        // `CommandBuilder` clears the environment, and it resolves the program
        // through its own `PATH` rather than the caller's.
        command.env("PATH", std::env::var("PATH").unwrap_or_default());
        command.env("TERM", terminfo::FALLBACK);
        command.set_controlling_tty(controlling);
        let child = pair.slave.spawn_command(command)?;
        drop(pair.slave);

        let seen = drain(pair.master.try_clone_reader()?);
        let stdin = pair.master.take_writer()?;
        Ok(Self {
            stdin,
            seen,
            process: Process::Pty(child),
            master: Some(pair.master),
        })
    }

    /// What `Exec` can express: pipes on all three streams and no terminal
    /// anywhere. `tty` forces a remote one anyway, which is R2's named fallback.
    fn through_pipes(lab: &Lab, tty: bool) -> Result<Self> {
        let mut child = std::process::Command::new("ssh")
            .args(lab.ssh_args(tty))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()?;
        let stdin = child.stdin.take().expect("stdin was piped");
        let seen = drain(Box::new(child.stdout.take().expect("stdout was piped")));
        merge_into(
            &seen,
            Box::new(child.stderr.take().expect("stderr was piped")),
        );
        Ok(Self {
            stdin: Box::new(stdin),
            seen,
            process: Process::Pipes(child),
            master: None,
        })
    }

    fn press(&mut self, byte: u8) -> Result<()> {
        self.stdin.write_all(&[byte])?;
        self.stdin.flush()?;
        Ok(())
    }

    /// Resizing the master is `TIOCSWINSZ` plus a `SIGWINCH` to the terminal's
    /// foreground process group — which is where a controlling terminal is
    /// actually load-bearing.
    fn resize(&self, size: PtySize) -> Result<()> {
        match &self.master {
            Some(master) => Ok(master.resize(size)?),
            None => bail!("a pipe has no window to resize"),
        }
    }

    fn is_running(&mut self) -> bool {
        match &mut self.process {
            Process::Pty(child) => matches!(child.try_wait(), Ok(None)),
            Process::Pipes(child) => matches!(child.try_wait(), Ok(None)),
        }
    }

    fn output(&self) -> String {
        match self.seen.lock() {
            Ok(held) => String::from_utf8_lossy(&held).into_owned(),
            Err(_) => String::new(),
        }
    }
}

impl Drop for Link {
    fn drop(&mut self) {
        match &mut self.process {
            Process::Pty(child) => {
                let _ = child.kill();
            }
            Process::Pipes(child) => {
                let _ = child.kill();
            }
        }
    }
}

fn drain(reader: Box<dyn Read + Send>) -> Arc<Mutex<Vec<u8>>> {
    let seen = Arc::new(Mutex::new(Vec::new()));
    merge_into(&seen, reader);
    seen
}

fn merge_into(seen: &Arc<Mutex<Vec<u8>>>, mut reader: Box<dyn Read + Send>) {
    let sink = Arc::clone(seen);
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(read) = reader.read(&mut buf) {
            if read == 0 {
                break;
            }
            if let Ok(mut held) = sink.lock() {
                held.extend_from_slice(&buf[..read]);
            }
        }
    });
}

/// The question Y-127 exists to answer, and the answer is yes.
#[tokio::test]
async fn ctrl_c_through_a_pty_kills_the_process_in_the_pane() -> Result<()> {
    let Some(lab) = Lab::start("works").await? else {
        return Ok(());
    };
    let mut link = Link::through_a_pty(&lab, true)?;
    assert!(
        lab.wait_for(|lab| Box::pin(lab.a_client_is_attached()))
            .await?,
        "the pty's ssh never attached: {}",
        link.output()
    );
    assert_eq!(
        lab.client_size().await?,
        size_of(WINDOW),
        "the local window is what the far side sees"
    );

    lab.start_the_victim().await?;
    link.press(ETX)?;

    assert!(
        lab.wait_for(|lab| Box::pin(lab.victim_is_gone())).await?,
        "`{VICTIM}` survived ^C, which is I-18's failure: {}",
        link.output()
    );
    assert!(
        link.is_running(),
        "and the local ssh survived it — the byte is forwarded to the far side, \
         not turned into a signal here"
    );

    link.resize(RESIZED)?;
    assert!(
        lab.wait_for(|lab| Box::pin(
            async move { Ok(lab.client_size().await? == size_of(RESIZED)) }
        ))
        .await?,
        "resizing the master must reach the far side"
    );
    Ok(())
}

/// The negative control, and the shape `Exec` has today: no terminal at either
/// end. tmux does not merely fail to be interrupted — it refuses to start.
#[tokio::test]
async fn ctrl_c_with_no_terminal_allocated_interrupts_nothing() -> Result<()> {
    let Some(lab) = Lab::start("notty").await? else {
        return Ok(());
    };
    let mut link = Link::through_pipes(&lab, false)?;

    lab.start_the_victim().await?;
    link.press(ETX)?;

    assert!(
        !lab.wait_for(|lab| Box::pin(lab.victim_is_gone())).await?,
        "^C down a pipe must not reach the pane"
    );
    assert!(
        link.output()
            .contains("open terminal failed: not a terminal"),
        "and the reason is tmux refusing to attach at all, got {:?}",
        link.output()
    );
    assert!(lab.client_size().await?.is_empty(), "nothing ever attached");
    Ok(())
}

/// **I-18 measured against `portable-pty`, and it does not hold as written.**
/// `set_controlling_tty(false)` keeps the `setsid` and drops the `TIOCSCTTY`,
/// which is the implementation the invariant was found in — and `^C` still
/// interrupts, because it is never a local signal: the byte is data all the way
/// to the far side's line discipline. What the missing controlling terminal
/// costs is `SIGWINCH`, so the window silently never resizes.
#[tokio::test]
async fn a_pty_that_is_not_the_controlling_terminal_interrupts_but_never_resizes() -> Result<()> {
    let Some(lab) = Lab::start("nocttys").await? else {
        return Ok(());
    };
    let mut link = Link::through_a_pty(&lab, false)?;
    assert!(
        lab.wait_for(|lab| Box::pin(lab.a_client_is_attached()))
            .await?,
        "it attaches like any other pty: {}",
        link.output()
    );

    lab.start_the_victim().await?;
    link.press(ETX)?;
    assert!(
        lab.wait_for(|lab| Box::pin(lab.victim_is_gone())).await?,
        "^C reaches the pane without a controlling terminal: {}",
        link.output()
    );

    link.resize(RESIZED)?;
    assert!(
        !lab.wait_for(|lab| Box::pin(
            async move { Ok(lab.client_size().await? == size_of(RESIZED)) }
        ))
        .await?,
        "and this is what it costs: no SIGWINCH, so the far side never hears"
    );
    assert_eq!(lab.client_size().await?, size_of(WINDOW));
    Ok(())
}

/// **R2's named fallback measured, and its stated cost is the wrong one.**
/// `ssh -tt` plus plain pipes does not lose the interrupt. What it loses is the
/// window: with no local terminal to ask, `ssh` reports a default size the
/// browser never chose, and there is nothing to resize afterwards.
#[tokio::test]
async fn pipes_with_a_forced_remote_tty_interrupt_but_report_a_size_nobody_asked_for() -> Result<()>
{
    let Some(lab) = Lab::start("forcedtty").await? else {
        return Ok(());
    };
    let mut link = Link::through_pipes(&lab, true)?;
    assert!(
        lab.wait_for(|lab| Box::pin(lab.a_client_is_attached()))
            .await?,
        "`-tt` forces a remote terminal even from a pipe: {}",
        link.output()
    );
    assert_eq!(
        lab.client_size().await?,
        "80x24",
        "openssh's default, not a window anyone measured"
    );

    lab.start_the_victim().await?;
    link.press(ETX)?;
    assert!(
        lab.wait_for(|lab| Box::pin(lab.victim_is_gone())).await?,
        "the fallback does interrupt: {}",
        link.output()
    );
    assert!(
        link.resize(RESIZED).is_err(),
        "and it has no window to resize"
    );
    Ok(())
}
