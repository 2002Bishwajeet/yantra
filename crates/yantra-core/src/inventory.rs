//! Which machines exist, according to Tailscale.
//!
//! Advisory only. This module reports what the tailnet knows; it never decides
//! what a workspace's `machine` means and never rejects a name for being absent
//! here, because `~/.ssh/config` is the authority ([ADR-0009]).
//!
//! Two things about the source data are worth knowing before editing this:
//!
//! - **The format is officially unstable.** Tailscale documents that
//!   `status --json` "has changed between releases and might change more", so
//!   the private mirrors below deliberately do *not* use
//!   `deny_unknown_fields` — the opposite of [`crate::workspace`], where an
//!   unknown key is a typo worth failing on. Here an unknown key is next
//!   week's release.
//! - **The `Peer` map is keyed by `nodekey:<hex>`, not by node ID.** Iterate
//!   its values and read `ID` from inside (I-5).
//!
//! [ADR-0009]: ../../../docs/adr/0009-machine-names-are-ssh-destinations.md

use std::collections::BTreeMap;
use std::process::Stdio;

/// Go's zero time, which `LastSeen` carries instead of being omitted. It does
/// **not** mean "never seen" — see [`MachineInfo::last_seen`].
const ZERO_TIME: &str = "0001-01-01T00:00:00Z";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MachineInfo {
    /// `ID` — the stable node identifier, and the only safe key (I-5).
    pub id: String,
    /// The first label of `DNSName`, which is what a workspace would name.
    /// Never `HostName`: it collides across nodes and can carry spaces and
    /// non-ASCII (I-33).
    pub name: String,
    /// `DNSName` verbatim, trailing dot included.
    pub dns_name: String,
    pub os: Os,
    pub online: bool,
    /// RFC 3339 as Tailscale reported it; `None` when it reported the zero
    /// time. An **online** peer can still carry a real value, so this says
    /// nothing about reachability on its own — read `online` for that.
    pub last_seen: Option<String>,
    /// The node key has expired. Such a machine can be powered on, listed, and
    /// still unreachable until someone re-authenticates it.
    pub expired: bool,
}

/// Go's `GOOS` with darwin split in two, in Tailscale's own casing — which is
/// not the all-lowercase casing ACL `node:os` uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Os {
    Linux,
    MacOs,
    Ios,
    Windows,
    Android,
    Other(String),
}

impl Os {
    fn parse(raw: &str) -> Self {
        match raw {
            "linux" => Self::Linux,
            "macOS" => Self::MacOs,
            "iOS" => Self::Ios,
            "windows" => Self::Windows,
            "android" => Self::Android,
            other => Self::Other(other.to_string()),
        }
    }
}

/// The inverse of `parse`: renders Tailscale's own spelling, so a round trip
/// through `Os` loses nothing. Not a presentation choice — ADR-0005 keeps
/// layout in the caller — but a property of the type.
impl std::fmt::Display for Os {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Linux => "linux",
            Self::MacOs => "macOS",
            Self::Ios => "iOS",
            Self::Windows => "windows",
            Self::Android => "android",
            Self::Other(raw) => raw,
        })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("could not spawn `tailscale` — is it installed and on PATH?")]
    Spawn(#[source] std::io::Error),

    #[error("`tailscale status --json` failed: {stderr}")]
    Command { stderr: String },

    #[error("could not parse `tailscale status --json`")]
    Parse(#[source] serde_json::Error),
}

/// The seam the layers above are tested against (§B2). A tailnet cannot be put
/// in a container, so unlike [`crate::ssh::Exec`] this one is genuinely tested
/// through a fake rather than through the podman fixture.
pub trait Inventory {
    fn machines(&self)
    -> impl std::future::Future<Output = Result<Vec<MachineInfo>, Error>> + Send;
}

/// Reads the local `tailscale` CLI (§B2). The LocalAPI at
/// `/run/tailscale/tailscaled.sock` returns byte-identical data and can also
/// push updates over `watch-ipn-bus`, which is the upgrade path when M4 wants
/// live status; the CLI is portable to the macOS and Windows clients without
/// token or named-pipe handling, and M2 only ever needs a snapshot.
#[derive(Debug, Clone, Default)]
pub struct Tailscale;

impl Inventory for Tailscale {
    async fn machines(&self) -> Result<Vec<MachineInfo>, Error> {
        let out = tokio::process::Command::new("tailscale")
            .args(["status", "--json"])
            .stdin(Stdio::null())
            .output()
            .await
            .map_err(Error::Spawn)?;

        if !out.status.success() {
            return Err(Error::Command {
                stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
            });
        }
        parse(&out.stdout)
    }
}

/// Machines from one `status --json` document, sorted by name so callers and
/// tests see a stable order.
fn parse(json: &[u8]) -> Result<Vec<MachineInfo>, Error> {
    let status: Status = serde_json::from_slice(json).map_err(Error::Parse)?;
    let mut machines: Vec<MachineInfo> = status
        .self_node
        .into_iter()
        .chain(status.peers.unwrap_or_default().into_values())
        .map(MachineInfo::from)
        .collect();
    machines.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(machines)
}

#[derive(Debug, serde::Deserialize)]
struct Status {
    #[serde(rename = "Self")]
    self_node: Option<Node>,
    /// Absent on a tailnet of one, so not merely empty.
    #[serde(rename = "Peer")]
    peers: Option<BTreeMap<String, Node>>,
}

/// Every field is Go PascalCase, so there is no `rename_all` that covers them.
#[derive(Debug, serde::Deserialize)]
struct Node {
    #[serde(rename = "ID")]
    id: String,
    #[serde(rename = "DNSName")]
    dns_name: String,
    #[serde(rename = "OS")]
    os: String,
    #[serde(rename = "Online")]
    online: bool,
    #[serde(rename = "LastSeen")]
    last_seen: Option<String>,
    /// Peers carry this; `Self` has no such key at all.
    #[serde(rename = "Expired", default)]
    expired: bool,
}

impl From<Node> for MachineInfo {
    fn from(node: Node) -> Self {
        let label = node
            .dns_name
            .trim_end_matches('.')
            .split('.')
            .next()
            .unwrap_or_default();
        let name = if label.is_empty() {
            node.id.clone()
        } else {
            label.to_string()
        };

        Self {
            id: node.id,
            name,
            os: Os::parse(&node.os),
            online: node.online,
            last_seen: node.last_seen.filter(|t| t != ZERO_TIME),
            expired: node.expired,
            dns_name: node.dns_name,
        }
    }
}

/// For testing the layers above. It lives in the library rather than in a test
/// module because `yantra` and `yantrad` need it too, and a tailnet is the one
/// dependency §B3's container cannot stand in for.
#[derive(Debug, Clone, Default)]
pub struct Fake {
    pub machines: Vec<MachineInfo>,
}

impl Inventory for Fake {
    async fn machines(&self) -> Result<Vec<MachineInfo>, Error> {
        Ok(self.machines.clone())
    }
}

#[cfg(test)]
// `expect` in a test is a deliberate abort with a message; the workspace lint
// targets library code, where the same call would take the daemon down.
#[allow(clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    /// Shaped from a real `tailscale status --json` on 1.98.9: the same
    /// collisions, the same dual boot, the same U+2019. Identifiers, keys,
    /// addresses and the tailnet name are replaced.
    const STATUS: &str = include_str!("../tests/fixture/tailscale-status.json");

    fn machines() -> Vec<MachineInfo> {
        parse(STATUS.as_bytes()).expect("fixture parses")
    }

    fn named(name: &str) -> MachineInfo {
        machines()
            .into_iter()
            .find(|m| m.name == name)
            .unwrap_or_else(|| panic!("no machine called {name}"))
    }

    #[test]
    fn the_whole_tailnet_parses_including_self() {
        let names: Vec<_> = machines().into_iter().map(|m| m.name).collect();
        assert_eq!(
            names,
            [
                "bishwajeets-macbook-pro",
                "cachyos-g14",
                "ipad153",
                "iphone-15",
                "laptop-9ml3d644",
                "laptop-9ml3d644-1",
            ]
        );
    }

    #[test]
    fn the_name_comes_from_dns_not_from_hostname() {
        // Both iOS nodes report HostName "localhost"; DNSName keeps them apart.
        assert_eq!(named("ipad153").os, Os::Ios);
        assert_eq!(named("iphone-15").os, Os::Ios);
        // And this one's HostName is "Bishwajeet’s MacBook Pro" (I-33).
        let mac = named("bishwajeets-macbook-pro");
        assert!(
            mac.name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
        );
        assert_eq!(mac.dns_name, "bishwajeets-macbook-pro.example.ts.net.");
    }

    #[test]
    fn the_dual_boot_is_two_nodes_that_share_a_hostname() {
        let linux = named("laptop-9ml3d644");
        let windows = named("laptop-9ml3d644-1");
        assert_ne!(linux.id, windows.id);
        assert_eq!(linux.os, Os::Linux);
        assert_eq!(windows.os, Os::Windows);
    }

    #[test]
    fn an_online_peer_can_still_carry_a_real_last_seen() {
        // Tailscale's own doc comment says LastSeen is "only present if
        // offline". This peer is online and carries 2026-07-29, so the field
        // cannot be used to infer reachability.
        let mac = named("bishwajeets-macbook-pro");
        assert!(mac.online);
        assert_eq!(mac.last_seen.as_deref(), Some("2026-07-29T22:10:00.1Z"));
    }

    #[test]
    fn the_zero_time_is_not_a_last_seen() {
        let this_box = named("cachyos-g14");
        assert!(this_box.online);
        assert_eq!(this_box.last_seen, None);
    }

    #[test]
    fn an_offline_peer_keeps_its_last_seen() {
        let ipad = named("ipad153");
        assert!(!ipad.online);
        assert_eq!(ipad.last_seen.as_deref(), Some("2026-07-14T22:25:55.1Z"));
    }

    #[test]
    fn an_expired_key_is_visible_and_self_has_no_such_field() {
        assert!(named("laptop-9ml3d644").expired);
        assert!(!named("laptop-9ml3d644-1").expired);
        assert!(!named("cachyos-g14").expired);
    }

    #[test]
    fn unknown_fields_are_ignored_because_the_format_is_unstable() {
        let json = br#"{
            "Self": {
                "ID": "n1", "DNSName": "solo.example.ts.net.", "OS": "linux",
                "Online": true, "LastSeen": "0001-01-01T00:00:00Z",
                "SomethingTailscaleAddedLastTuesday": {"nested": [1, 2, 3]}
            },
            "AnEntirelyNewTopLevelKey": 7
        }"#;
        let machines = parse(json).expect("unknown fields are tolerated");
        assert_eq!(machines.len(), 1);
        assert_eq!(machines[0].name, "solo");
    }

    #[test]
    fn a_tailnet_of_one_has_no_peer_key_at_all() {
        let json = br#"{"Self": {
            "ID": "n1", "DNSName": "solo.example.ts.net.", "OS": "linux",
            "Online": true, "LastSeen": "0001-01-01T00:00:00Z"
        }}"#;
        assert_eq!(parse(json).expect("parses").len(), 1);
    }

    #[test]
    fn an_unrecognised_os_is_carried_rather_than_dropped() {
        assert_eq!(Os::parse("freebsd"), Os::Other("freebsd".to_string()));
        assert_eq!(Os::parse("macOS"), Os::MacOs);
        // Not the lowercase spelling ACLs use.
        assert_eq!(Os::parse("macos"), Os::Other("macos".to_string()));
    }

    #[test]
    fn every_os_renders_back_to_the_string_it_was_parsed_from() {
        for raw in ["linux", "macOS", "iOS", "windows", "android", "freebsd"] {
            assert_eq!(Os::parse(raw).to_string(), raw);
        }
    }

    #[test]
    fn nonsense_is_a_parse_error_not_a_panic() {
        assert!(matches!(parse(b"not json"), Err(Error::Parse(_))));
    }
}
