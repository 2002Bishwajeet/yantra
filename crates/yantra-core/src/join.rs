//! The join command a person runs on a new machine (Y-387,
//! [ADR-0029](../../../docs/adr/0029-a-machine-joins-itself.md)).
//!
//! The script is POSIX `sh` in [`join.sh`](join.sh). The daemon fills in three
//! values and serves it at `GET /join`; `yantra join-script` prints the same
//! bytes. What the machine reports back is [`crate::identity::join_in`]'s input.

use std::net::{IpAddr, SocketAddr};

/// `yantrad`'s port, here so the CLI names the daemon without a second copy.
pub const DAEMON_PORT: u16 = 7717;

const SCRIPT: &str = include_str!("join.sh");

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(
        "the public key holds a character a shell would read, so it is not written into a script"
    )]
    UnusableKey,

    #[error("this machine holds no tailnet address, so a joined machine has nowhere to report")]
    NoAddress,
}

/// IPv4 first, because `agent.env` wants `100.x.x.x:7717` (ADR-0013 §4).
pub fn daemon_address(addresses: &[IpAddr]) -> Result<SocketAddr, Error> {
    addresses
        .iter()
        .find(|address| address.is_ipv4())
        .or_else(|| addresses.first())
        .map(|address| SocketAddr::new(*address, DAEMON_PORT))
        .ok_or(Error::NoAddress)
}

/// The script with this daemon's address, its public key and its version in
/// it. The agent it installs is this daemon's own release.
pub fn script(daemon: SocketAddr, public_key: &str) -> Result<String, Error> {
    // Each value sits inside single quotes, so a quote or a newline would end it.
    let usable = !public_key.is_empty()
        && public_key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || " +/=@._-:".contains(c));
    if !usable {
        return Err(Error::UnusableKey);
    }
    Ok(SCRIPT
        .replace("__YANTRA_DAEMON__", &daemon.to_string())
        .replace("__YANTRA_KEY__", public_key)
        .replace("__YANTRA_VERSION__", crate::about::VERSION))
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    const KEY: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB0yYW50cmEtdGVzdC1rZXktbm90LXJlYWw yantra";

    #[test]
    fn the_script_carries_all_three_values_and_no_placeholder() {
        let daemon = SocketAddr::new(IpAddr::from([100, 64, 0, 1]), DAEMON_PORT);
        let script = script(daemon, KEY).expect("a usable key");

        assert!(script.contains("DAEMON='100.64.0.1:7717'"), "{script}");
        assert!(script.contains(&format!("KEY='{KEY}'")));
        assert!(script.contains(&format!("VERSION='{}'", crate::about::VERSION)));
        assert!(!script.contains("__YANTRA_"), "a placeholder was left in");
    }

    /// `sh -n` parses without running, so a syntax error fails here rather
    /// than on the machine someone is trying to join.
    #[test]
    fn the_script_parses_as_posix_sh() {
        let daemon = SocketAddr::new(IpAddr::from([100, 64, 0, 1]), DAEMON_PORT);
        let script = script(daemon, KEY).expect("a usable key");
        let out = std::process::Command::new("sh")
            .args(["-n", "-c", &script])
            .output()
            .expect("sh is on every machine this builds on");
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[test]
    fn a_key_that_would_end_its_quotes_is_refused() {
        let daemon = SocketAddr::new(IpAddr::from([100, 64, 0, 1]), DAEMON_PORT);
        for hostile in [
            "",
            "ssh-ed25519 AAAA' ; rm -rf ~ '",
            "ssh-ed25519 AAAA\nexit",
        ] {
            assert!(
                matches!(script(daemon, hostile), Err(Error::UnusableKey)),
                "{hostile:?}"
            );
        }
    }

    #[test]
    fn the_daemon_is_named_by_its_ipv4_address_first() {
        let v6: IpAddr = "fd7a:115c:a1e0::1".parse().expect("v6");
        let v4 = IpAddr::from([100, 64, 0, 1]);

        assert_eq!(
            daemon_address(&[v6, v4]).expect("an address"),
            SocketAddr::new(v4, 7717)
        );
        assert_eq!(
            daemon_address(&[v6]).expect("an address").to_string(),
            "[fd7a:115c:a1e0::1]:7717"
        );
        assert!(matches!(daemon_address(&[]), Err(Error::NoAddress)));
    }
}
