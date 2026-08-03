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
use std::net::IpAddr;
use std::process::Stdio;

/// Go's zero time, which `LastSeen` carries instead of being omitted. It does
/// **not** mean "never seen" — see [`MachineInfo::last_seen`].
/// What `tailscale whois` says on stderr for an address it cannot place,
/// measured on 1.98.9 for both an unused tailnet address and `8.8.8.8`.
const NOT_A_PEER: &str = "peer not found";

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
    /// `TailscaleIPs`, parsed rather than kept as strings: ADR-0013 §5
    /// attributes a heartbeat by matching these against the address it arrived
    /// from, and one v6 address has more than one spelling. Empty is a peer
    /// nothing can be attributed to, never a peer whose addresses are unknown.
    pub addresses: Vec<IpAddr>,
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

/// Inverse of `parse`, so a round trip loses nothing. Not layout (ADR-0005).
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

    #[error("`tailscale whois` failed: {stderr}")]
    Whois { stderr: String },

    #[error("could not parse `tailscale whois --json`")]
    ParseWhois(#[source] serde_json::Error),
}

/// The seam the layers above are tested against (§B2). A tailnet cannot be put
/// in a container, so unlike [`crate::ssh::Exec`] this one is genuinely tested
/// through a fake rather than through the podman fixture.
/// Who holds a tailnet address, asked **live** rather than read from the
/// snapshot — [ADR-0016](../../../docs/adr/0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md)
/// §3, because an authorisation decision on a 30 s reading lets a node removed
/// twenty seconds ago still act.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Caller {
    /// `Node.ID`, the stable identifier and the only safe key (I-5).
    pub node: String,
    /// `Node.User`, the numeric owner — compared against [`Inventory::owner`].
    /// The login name is deliberately not carried: nothing authorises on it,
    /// and it is the one field here that identifies a person.
    pub user: u64,
    /// `Node.Tags`. A tagged node is one no person is accountable for, which
    /// is why ADR-0016 refuses it even when the owner matches.
    pub tags: Vec<String>,
}

pub trait Inventory {
    fn machines(&self)
    -> impl std::future::Future<Output = Result<Vec<MachineInfo>, Error>> + Send;

    /// The addresses **this** machine holds on the tailnet, for a server that
    /// must not listen anywhere else.
    ///
    /// Self only, and that is the whole boundary: a peer's address would be
    /// name resolution, which ADR-0009 declined. This asks what this machine
    /// owns, not where another one is.
    fn addresses(&self) -> impl std::future::Future<Output = Result<Vec<IpAddr>, Error>> + Send;

    /// `None` when the address belongs to no peer. That is a different answer
    /// from *could not ask*, which is an error — ADR-0016 refuses both, and
    /// the operator needs to know which one happened.
    fn whois(
        &self,
        address: IpAddr,
    ) -> impl std::future::Future<Output = Result<Option<Caller>, Error>> + Send;

    /// The numeric user owning **this** node, which is the only thing a
    /// caller's `user` is ever compared against.
    fn owner(&self) -> impl std::future::Future<Output = Result<u64, Error>> + Send;
}

/// Reads the local `tailscale` CLI (§B2). The LocalAPI returns identical data
/// and can stream — the upgrade path when M4 wants live status.
#[derive(Debug, Clone, Default)]
pub struct Tailscale;

impl Inventory for Tailscale {
    async fn machines(&self) -> Result<Vec<MachineInfo>, Error> {
        parse(&self.status().await?)
    }

    async fn addresses(&self) -> Result<Vec<IpAddr>, Error> {
        parse_addresses(&self.status().await?)
    }

    async fn whois(&self, address: IpAddr) -> Result<Option<Caller>, Error> {
        let out = tokio::process::Command::new("tailscale")
            .args(["whois", "--json", &address.to_string()])
            .stdin(Stdio::null())
            .output()
            .await
            .map_err(Error::Spawn)?;

        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if !out.status.success() {
            // Measured on 1.98.9: an address belonging to nobody, and one that
            // is not on the tailnet at all, both exit 1 saying exactly this.
            return if stderr == NOT_A_PEER {
                Ok(None)
            } else {
                Err(Error::Whois { stderr })
            };
        }
        parse_whois(&out.stdout).map(Some)
    }

    async fn owner(&self) -> Result<u64, Error> {
        parse_owner(&self.status().await?)
    }
}

impl Tailscale {
    async fn status(&self) -> Result<Vec<u8>, Error> {
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
        Ok(out.stdout)
    }
}

/// `Self.TailscaleIPs`, in the order Tailscale reports them — v4 first in
/// every document seen so far, but nothing depends on that.
fn parse_addresses(json: &[u8]) -> Result<Vec<IpAddr>, Error> {
    let status: Status = serde_json::from_slice(json).map_err(Error::Parse)?;
    Ok(status
        .self_node
        .and_then(|node| node.tailscale_ips)
        .unwrap_or_default())
}

/// Machines from one `status --json` document, sorted by name so callers and
/// tests see a stable order.
fn parse_owner(json: &[u8]) -> Result<u64, Error> {
    let status: Status = serde_json::from_slice(json).map_err(Error::Parse)?;
    status
        .self_node
        .and_then(|node| node.user)
        .ok_or_else(|| Error::Whois {
            stderr: "`tailscale status --json` named no owner for this node".to_string(),
        })
}

fn parse_whois(json: &[u8]) -> Result<Caller, Error> {
    let whois: WhoisReply = serde_json::from_slice(json).map_err(Error::ParseWhois)?;
    Ok(Caller {
        node: whois.node.stable_id,
        user: whois.node.user,
        tags: whois.node.tags.unwrap_or_default(),
    })
}

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
    /// `Option` because absent and `null` are both live possibilities in this
    /// format — the sibling `Addrs` is literally `null` on every peer here —
    /// and a `Vec` field would make the second one a whole-document error.
    #[serde(rename = "TailscaleIPs", default)]
    tailscale_ips: Option<Vec<IpAddr>>,
    /// **`UserID` here and `User` in `whois`** — the same number under two
    /// names, in two documents from the same binary.
    #[serde(rename = "UserID", default)]
    user: Option<u64>,
}

/// `tailscale whois --json` — `UserProfile` and `CapMap` are deliberately not
/// read: nothing here authorises on a login name, and reading it would put a
/// person's identity into the daemon's memory for no decision (the same
/// boundary `agent::Status` draws).
#[derive(Debug, serde::Deserialize)]
struct WhoisReply {
    #[serde(rename = "Node")]
    node: WhoisNode,
}

/// **Not [`Node`]**, though both are a node from the same binary. `whois` omits
/// `DNSName`, `OS` and `Tags` entirely, and — the trap — carries **two**
/// identifiers: `StableID` is what `status` calls `ID` and what I-5 requires,
/// while `ID` is a numeric internal key that would deserialise happily into the
/// wrong field and never once error.
#[derive(Debug, serde::Deserialize)]
struct WhoisNode {
    #[serde(rename = "StableID")]
    stable_id: String,
    #[serde(rename = "User")]
    user: u64,
    /// Absent on an untagged node rather than empty.
    #[serde(rename = "Tags", default)]
    tags: Option<Vec<String>>,
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
            addresses: node.tailscale_ips.unwrap_or_default(),
        }
    }
}

/// For testing the layers above. It lives in the library rather than in a test
/// module because `yantra` and `yantrad` need it too, and a tailnet is the one
/// dependency §B3's container cannot stand in for.
#[derive(Debug, Clone, Default)]
pub struct Fake {
    pub machines: Vec<MachineInfo>,
    pub addresses: Vec<IpAddr>,
    pub callers: BTreeMap<IpAddr, Caller>,
    pub owner: u64,
}

impl Inventory for Fake {
    async fn machines(&self) -> Result<Vec<MachineInfo>, Error> {
        Ok(self.machines.clone())
    }

    async fn addresses(&self) -> Result<Vec<IpAddr>, Error> {
        Ok(self.addresses.clone())
    }

    async fn whois(&self, address: IpAddr) -> Result<Option<Caller>, Error> {
        Ok(self.callers.get(&address).cloned())
    }

    async fn owner(&self) -> Result<u64, Error> {
        Ok(self.owner)
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

    /// A real `tailscale whois --json` on 1.98.9, with keys, addresses,
    /// endpoints and the login name replaced.
    const WHOIS: &str = include_str!("../tests/fixture/tailscale-whois.json");

    /// The two identifiers are the point: `StableID` is what `status` calls
    /// `ID` and what I-5 requires, and the numeric `ID` beside it would
    /// deserialise into the same field without ever erroring.
    #[test]
    fn whois_reads_the_stable_id_and_not_the_numeric_one() {
        let caller = parse_whois(WHOIS.as_bytes()).expect("the fixture parses");

        assert_eq!(caller.node, "nMAC000000011CNTRL");
        assert_eq!(
            caller.node,
            named("bishwajeets-macbook-pro").id,
            "I-5's key"
        );
        assert_eq!(caller.user, 1);
        assert!(caller.tags.is_empty(), "{:?}", caller.tags);
    }

    /// `UserID` in `status`, `User` in `whois` — one number, two names, two
    /// documents from the same binary. Reading the wrong one yields `None`,
    /// and an owner of `None` compared against a caller would refuse
    /// everything or, worse, default to zero and match a tagged node.
    #[test]
    fn the_owner_comes_from_status_under_its_other_name() {
        let owner = parse_owner(STATUS.as_bytes()).expect("the fixture names an owner");

        assert_eq!(owner, 1);
        assert_eq!(
            owner,
            parse_whois(WHOIS.as_bytes()).expect("parses").user,
            "the same node, read through both documents"
        );
    }

    #[test]
    fn a_tagged_node_is_read_as_tagged() {
        let tagged = WHOIS.replace(r#""User": 1,"#, r#""User": 1, "Tags": ["tag:ci"],"#);

        let caller = parse_whois(tagged.as_bytes()).expect("parses");

        assert_eq!(caller.tags, ["tag:ci"], "ADR-0016 refuses this node");
    }

    /// Needs the tailnet, so it is ignored rather than skipped (root §B3).
    /// `just test-mac`-style: `cargo test -p yantra-core -- --ignored whois`.
    #[tokio::test]
    #[ignore = "needs a live tailnet"]
    async fn the_real_tailscale_places_this_machine_and_refuses_a_stranger() {
        let tailscale = Tailscale;
        let mine = tailscale
            .addresses()
            .await
            .expect("this machine holds addresses")
            .into_iter()
            .next()
            .expect("at least one");

        let me = tailscale
            .whois(mine)
            .await
            .expect("tailscale answers")
            .expect("this machine is a peer of itself");
        assert_eq!(
            me.user,
            tailscale.owner().await.expect("an owner"),
            "the daemon must authorise its own host"
        );
        assert!(me.tags.is_empty(), "{:?}", me.tags);

        // 8.8.8.8 is not on any tailnet, and `whois` says so by exiting 1
        // rather than by answering — the `None` this asserts is the difference
        // between *not a peer* and *could not ask*.
        let stranger = tailscale
            .whois("8.8.8.8".parse().expect("a literal address"))
            .await
            .expect("a failure to place is not a failure to ask");
        assert!(stranger.is_none(), "{stranger:?}");
    }

    #[test]
    fn a_status_without_an_owner_is_an_error_rather_than_zero() {
        let anonymous = STATUS.replace(r#""UserID": 1"#, r#""NotUserID": 1"#);

        let refused = parse_owner(anonymous.as_bytes()).expect_err("no owner to compare against");

        assert!(refused.to_string().contains("owner"), "{refused}");
    }

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

    /// Attribution (ADR-0013 §5) is fleet-wide, so unlike
    /// [`Inventory::addresses`] this has to arrive on peers too.
    #[test]
    fn every_node_carries_its_addresses_including_the_peers() {
        for machine in machines() {
            assert_eq!(
                machine.addresses.len(),
                2,
                "{} carries {:?}",
                machine.name,
                machine.addresses
            );
        }
        assert_eq!(
            named("bishwajeets-macbook-pro")
                .addresses
                .iter()
                .map(std::string::ToString::to_string)
                .collect::<Vec<_>>(),
            ["100.64.0.2", "fd7a:115c:a1e0::2"]
        );
    }

    /// Why the field is `IpAddr` and not `String`: the fixture spells this
    /// address `fd7a:115c:a1e0::2` and the connection arrives spelling it in
    /// full. Same address, different text.
    #[test]
    fn a_peer_matches_whichever_spelling_its_address_arrives_in() {
        const ARRIVED: &str = "[fd7a:115c:a1e0:0:0:0:0:2]:52001";
        let mac = named("bishwajeets-macbook-pro");
        let ip = ARRIVED
            .parse::<std::net::SocketAddr>()
            .expect("a v6 socket address")
            .ip();
        assert!(mac.addresses.contains(&ip));
        assert!(
            !ARRIVED.contains("fd7a:115c:a1e0::2"),
            "the arriving text is not the fixture's text, which is all a String could compare"
        );
    }

    /// Y-071's rule — no state inferable only from a missing field. Absent and
    /// `null` are one state, empty, and neither is an error: the sibling
    /// `Addrs` is `null` on every live peer, so nulling a key is how this
    /// format moves.
    #[test]
    fn an_absent_or_null_address_list_is_empty_rather_than_an_error() {
        let json = br#"{
            "Self": {
                "ID": "n1", "DNSName": "solo.example.ts.net.", "OS": "linux",
                "Online": true, "LastSeen": "0001-01-01T00:00:00Z"
            },
            "Peer": {"nodekey:00": {
                "ID": "n2", "DNSName": "nulled.example.ts.net.", "OS": "linux",
                "Online": true, "LastSeen": "0001-01-01T00:00:00Z",
                "TailscaleIPs": null
            }}
        }"#;
        let machines = parse(json).expect("a nulled address list is not a parse error");
        assert_eq!(machines.len(), 2);
        assert!(machines.iter().all(|m| m.addresses.is_empty()));
    }

    #[test]
    fn this_machines_addresses_come_from_self_and_carry_both_families() {
        let addresses = parse_addresses(STATUS.as_bytes()).expect("fixture parses");
        assert_eq!(
            addresses
                .iter()
                .map(std::string::ToString::to_string)
                .collect::<Vec<_>>(),
            ["100.64.0.1", "fd7a:115c:a1e0::1"]
        );
    }

    /// A peer's address is not this machine's, and a server that bound one
    /// would be listening on somebody else's behalf.
    #[test]
    fn no_peer_address_is_ever_returned() {
        let addresses = parse_addresses(STATUS.as_bytes()).expect("fixture parses");
        assert!(!addresses.iter().any(|a| a.to_string() == "100.64.0.2"));
    }

    /// A tailnet that is down still parses; it simply owns nothing, which is
    /// what makes "refuse to start" a decision the caller can take.
    #[test]
    fn a_document_without_self_yields_no_addresses_rather_than_an_error() {
        assert!(
            parse_addresses(b"{}")
                .expect("an empty document is valid")
                .is_empty()
        );
    }

    #[test]
    fn a_self_node_with_no_addresses_is_not_an_error() {
        let json = br#"{"Self": {
            "ID": "n1", "DNSName": "solo.example.ts.net.", "OS": "linux",
            "Online": true, "LastSeen": "0001-01-01T00:00:00Z"
        }}"#;
        assert!(parse_addresses(json).expect("parses").is_empty());
    }
}
