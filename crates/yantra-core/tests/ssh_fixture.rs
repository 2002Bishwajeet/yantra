//! Proves the Y-031 fixture works end to end: a real sshd and a real tmux, in a
//! disposable container, reached over a real network hop.
//!
//! Skips (rather than fails) when `podman` is not installed.

mod common;

use anyhow::Result;
use common::SshFixture;

/// Session name obeys I-2: `[A-Za-z0-9_-]` only.
const SESSION: &str = "yantra_fixture";

#[test]
fn ssh_reaches_a_real_tmux_in_the_container() -> Result<()> {
    let Some(fixture) = SshFixture::start()? else {
        return Ok(());
    };

    // The connection details Y-041 will build its own `ssh` invocation from.
    assert_eq!(fixture.host(), "127.0.0.1");
    assert!(fixture.port() > 0, "an ephemeral host port was published");
    assert!(fixture.key_path().is_file(), "the per-run key exists");

    // A real network hop into a separate user and filesystem.
    assert_eq!(fixture.run("whoami")?.trim(), "yantra");

    // I-1: plain `new-session -d`, never `-A -d` and never `has-session ||`.
    fixture.run(&format!("tmux new-session -d -s {SESSION}"))?;
    // I-4: without this a crashed pane vanishes and "crashed" is
    // indistinguishable from "finished". `remain-on-exit` is a *window* option,
    // and a window target needs the trailing colon (I-21).
    fixture.run(&format!(
        "tmux set-option -w -t '={SESSION}:' remain-on-exit on"
    ))?;

    let sessions = fixture.run("tmux list-sessions -F '#{session_name}'")?;
    assert!(
        sessions.lines().any(|name| name == SESSION),
        "expected a {SESSION} session, got: {sessions:?}"
    );
    Ok(())
}

/// Both wordings are real: `rootlessport` reported the first when this cost a
/// CI run, and `pasta` says the second on a developer's machine.
#[test]
fn a_lost_host_port_race_is_recognised_whichever_forwarder_reports_it() {
    assert!(common::lost_the_port_race(
        "Error: rootlessport listen tcp 127.0.0.1:37043: bind: address already in use"
    ));
    assert!(common::lost_the_port_race(
        "Error: pasta failed with exit code 1:\nListen failed for HOST TCP port \
         127.0.0.1/34921: Address already in use"
    ));
    assert!(!common::lost_the_port_race(
        "Error: localhost/yantra-fixture:2: image not known"
    ));
}
