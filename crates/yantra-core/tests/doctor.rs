//! `doctor` against a real sshd and a real tmux (§B3), and against a port
//! nothing is listening on — which is where the honesty rule is actually tested.
//!
//! **The stubs here are `claude` and `gh`, and that is the same deliberate limit
//! `tests/agent.rs` names**: the four seams §B2 requires against the real thing
//! are ssh, tmux, telemetry and hardware, and an agent or provider CLI is none
//! of them. Both stubs emit shapes copied from the real binaries.
//!
//! What no container can cover is the macOS half of `login-session` — a tmux
//! server started from a GUI login (ADR-0018 §1, I-44). `manual_macbook.rs`
//! holds that, and green here does not mean it (I-32).

// `expect` in a test is a deliberate abort with a message.
#![allow(clippy::expect_used)]

mod common;

use anyhow::Result;
use common::{SshFixture, USER};
use yantra_core::doctor::{self, Check, State};
use yantra_core::ssh::{Exec as _, Machine, Ssh};

/// Alpine's ncurses knows this one and has never heard of the other, so both
/// halves of the terminfo check have a real answer here (Y-058).
const KNOWN_REMOTELY: &str = "alacritty";
const UNKNOWN_REMOTELY: &str = "xterm-ghostty";

/// Where Claude Code's own installer puts the binary — not on the
/// non-interactive `PATH`, which is why the candidate list exists (I-34).
const BIN_DIR: &str = "/home/yantra/.local/bin";

struct Lab {
    _fixture: SshFixture,
    ssh: Ssh,
    dir: std::path::PathBuf,
}

impl Lab {
    fn start(label: &str) -> Result<Option<Self>> {
        let Some(fixture) = SshFixture::start()? else {
            return Ok(None);
        };
        let dir = std::path::PathBuf::from("/tmp").join(format!("yd-{label}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)?;
        let ssh = Ssh::new(Machine {
            host: fixture.host().to_owned(),
            user: Some(USER.to_owned()),
            port: Some(fixture.port()),
            identity: Some(fixture.key_path()),
            state_dir: dir.clone(),
        })?;
        Ok(Some(Self {
            _fixture: fixture,
            ssh,
            dir,
        }))
    }

    /// Installs a stub where an installer would put it, so finding it exercises
    /// the candidate list rather than the remote `PATH`.
    async fn install(&self, name: &str, script: &str) -> Result<()> {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(script);
        let out = self
            .ssh
            .exec(&format!(
                "mkdir -p {BIN_DIR} && printf %s '{b64}' | base64 -d > {BIN_DIR}/{name} \
                 && chmod 755 {BIN_DIR}/{name}"
            ))
            .await?;
        anyhow::ensure!(out.success(), "installing the {name} stub failed");
        Ok(())
    }

    /// `auth status` prints its JSON on stdout either way and exits 1 in the
    /// negative case — both measured on Claude Code 2.1.220.
    async fn install_claude(&self, logged_in: bool) -> Result<()> {
        let (flag, method, code) = if logged_in {
            ("true", "claude.ai", 0)
        } else {
            ("false", "none", 1)
        };
        self.install(
            "claude",
            &format!(
                "#!/bin/sh\n\
                 if [ \"$1\" = auth ]; then\n\
                 \x20 printf '%s\\n' '{{\"loggedIn\":{flag},\"authMethod\":\"{method}\"}}'\n\
                 \x20 exit {code}\n\
                 fi\n\
                 exit 0\n"
            ),
        )
        .await
    }

    /// `gh`/`glab auth status` answer on stderr and carry the account name, so
    /// the stub does too — what must not come back is exactly what a real one
    /// would print.
    async fn install_provider(&self, name: &str, authenticated: bool) -> Result<()> {
        let code = i32::from(!authenticated);
        self.install(
            name,
            &format!(
                "#!/bin/sh\n\
                 if [ \"$1\" = auth ]; then\n\
                 \x20 echo 'Logged in to github.com account someone (token gho_secret)' >&2\n\
                 \x20 exit {code}\n\
                 fi\n\
                 echo '{name} version 0.0.0'\n"
            ),
        )
        .await
    }
}

impl Drop for Lab {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// The nine checks D2 §3.1 lists, in the order `doctor` reports them. Asserted
/// on every path below, because the list *and its order* are the contract an
/// installer and an agent read (D2.2).
const EXPECTED: [&str; 9] = [
    "reachable",
    "sshd",
    "tmux",
    "agent-cli",
    "terminfo",
    "provider-cli",
    "provider-auth",
    "login-session",
    "heartbeat",
];

fn look<'a>(checks: &'a [Check], name: &str) -> &'a Check {
    assert_eq!(
        checks.iter().map(|c| c.check).collect::<Vec<_>>(),
        EXPECTED,
        "every machine reports the whole list, whatever it could answer"
    );
    checks
        .iter()
        .find(|check| check.check == name)
        .expect("the list above contains it")
}

fn assert_state(checks: &[Check], name: &str, wanted: State) {
    let check = look(checks, name);
    assert_eq!(check.state, wanted, "{name}: {}", check.detail);
}

/// A port nothing is listening on, closed again before the test uses it.
fn closed_port() -> Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

/// **R-23, and the whole reason this module reports three states.** A machine
/// that refuses the connection has said something about its sshd and nothing at
/// all about what is installed on it — so every check behind ssh must come back
/// `unknown`, and an `absent` anywhere in that list would send a reader to
/// install software on a box that already has it.
///
/// Needs no container: a refused TCP connection is a real `ssh` failure, and
/// this is the one path that must be exercised on a machine without podman too.
#[tokio::test]
async fn a_machine_that_refuses_the_connection_is_never_reported_as_missing_anything() -> Result<()>
{
    let dir = std::path::PathBuf::from("/tmp").join("yd-refused");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    let ssh = Ssh::new(Machine {
        host: "127.0.0.1".to_owned(),
        user: Some(USER.to_owned()),
        port: Some(closed_port()?),
        identity: None,
        state_dir: dir.clone(),
    })?;

    let checks = doctor::of(&ssh, KNOWN_REMOTELY).await;
    let _ = std::fs::remove_dir_all(&dir);

    let reachable = look(&checks, "reachable");
    assert_eq!(reachable.state, State::Absent, "{}", reachable.detail);
    assert!(
        reachable.detail.contains("refused"),
        "the reason has to be in the report, or nobody can act on it: {}",
        reachable.detail
    );
    // The far side answered, and what it answered is that nothing holds the ssh
    // port — D2 §3.1's *distinguishing refusal from timeout*.
    assert_state(&checks, "sshd", State::Absent);

    for check in checks.iter().skip(2) {
        assert_eq!(
            check.state,
            State::Unknown,
            "{} must be unknown behind an ssh that never connected: {}",
            check.check,
            check.detail
        );
    }
    Ok(())
}

/// A machine that answers everything honestly says *no* to: the container has
/// tmux and ncurses and nothing else, so four checks have a real absence to
/// report and two have something better to say than absence.
#[tokio::test]
async fn a_bare_machine_tells_missing_apart_from_unaskable() -> Result<()> {
    let Some(lab) = Lab::start("bare")? else {
        return Ok(());
    };
    let checks = doctor::of(&lab.ssh, UNKNOWN_REMOTELY).await;

    assert_state(&checks, "reachable", State::Present);
    assert_state(&checks, "sshd", State::Present);
    assert_state(&checks, "tmux", State::Present);
    assert_state(&checks, "agent-cli", State::Absent);
    assert_state(&checks, "terminfo", State::Absent);
    assert_state(&checks, "provider-cli", State::Absent);

    // Not absent: with no `gh` or `glab` there, nothing was asked about a
    // credential — which is a different thing from asking and finding none.
    assert_state(&checks, "provider-auth", State::Unknown);
    // The same rule one row down: the gate runs `claude`, and there is none.
    assert_state(&checks, "login-session", State::Unknown);
    assert_state(&checks, "heartbeat", State::Unknown);

    assert!(
        look(&checks, "terminfo").detail.contains(UNKNOWN_REMOTELY),
        "a downgrade has to name the terminal it lost"
    );
    Ok(())
}

/// The equipped machine, and the one assertion that matters beyond the states:
/// **the heartbeat is the only check a CLI cannot answer**, because the beats
/// live in the running daemon's memory and nothing persists them.
#[tokio::test]
async fn a_machine_with_everything_reports_present_except_the_beat() -> Result<()> {
    let Some(lab) = Lab::start("equipped")? else {
        return Ok(());
    };
    lab.install_claude(true).await?;
    lab.install_provider("gh", true).await?;

    let checks = doctor::of(&lab.ssh, KNOWN_REMOTELY).await;
    for check in &checks {
        let wanted = if check.check == "heartbeat" {
            State::Unknown
        } else {
            State::Present
        };
        assert_eq!(check.state, wanted, "{}: {}", check.check, check.detail);
    }

    // §B4: the far side keeps what `auth status` printed. A real `gh` names the
    // account and a redacted token there, and this report is published.
    let auth = look(&checks, "provider-auth");
    assert!(
        !auth.detail.contains("someone") && !auth.detail.contains("gho_"),
        "no credential and no account name may reach a report: {}",
        auth.detail
    );
    Ok(())
}

/// The other side of both credential checks: a CLI that is there and finds
/// nothing is **absent**, and nothing in that resembles a machine that could not
/// be asked.
#[tokio::test]
async fn a_tool_that_finds_no_credential_is_absent_rather_than_unknown() -> Result<()> {
    let Some(lab) = Lab::start("uncredentialled")? else {
        return Ok(());
    };
    lab.install_claude(false).await?;
    lab.install_provider("glab", false).await?;

    let checks = doctor::of(&lab.ssh, KNOWN_REMOTELY).await;
    assert_state(&checks, "provider-cli", State::Present);
    assert_state(&checks, "provider-auth", State::Absent);
    assert_state(&checks, "agent-cli", State::Present);
    assert_state(&checks, "login-session", State::Absent);

    assert!(
        look(&checks, "provider-cli").detail.contains("glab"),
        "the report says which one it found"
    );
    Ok(())
}
