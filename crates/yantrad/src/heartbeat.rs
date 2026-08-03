//! `POST /heartbeat` — the first write into this daemon, and the only one.
//!
//! [ADR-0013] §4–§6 settles the whole of it: JSON on the listener Y-069 already
//! built, `204 No Content`, no new port, no new dependency, no TLS.
//!
//! **The response will never carry instructions.** A reply the agent acts on is
//! a control channel, and a control channel is how `yantra-agent` stops being a
//! reporter (R-12) — one response body away.
//!
//! **The heartbeat names no machine.** It is attributed to the peer that owns
//! the address it arrived from (§5), read from the background-refreshed
//! inventory rather than from the LocalAPI, because nothing expensive happens on
//! the request path. A beat from an address no peer holds is dropped.
//!
//! It writes to memory and never to disk, so a flood costs CPU and cannot fill
//! anything — the no-history non-goal, arriving as a property rather than a
//! promise. R-22 is what stands between an arbitrary tailnet node and that
//! write, and §6 is the argument that the worst it buys is a session placed
//! somewhere that then fails to start.
//!
//! [ADR-0013]: ../../../docs/adr/0013-the-heartbeat-carries-only-what-placement-scores.md

use std::collections::BTreeMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::Router;
use axum::extract::{ConnectInfo, DefaultBodyLimit, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use tokio::sync::RwLock;
use yantra_core::heartbeat::{Heartbeat, Power};
use yantra_core::inventory::MachineInfo;
use yantra_core::snapshot::Reading;

use crate::refresh::Model;

/// ~30× the largest payload measured across the tailnet, and still bounded;
/// `labels` is the only field that could grow without one.
const LIMIT: usize = 4096;

/// The latest beat per machine, keyed on the node id because that is the only
/// stable key (I-5). One row, overwritten every beat: [`Reading`] carries the
/// arrival time, which is the freshness ADR-0013 §7 reads.
pub type Beats = Arc<RwLock<BTreeMap<String, Reading<Heartbeat>>>>;

/// The beats sit beside the snapshot rather than inside it: a beat is not a look
/// the daemon took, it has no `Result` to carry, and putting it in `Snapshot`
/// would give that type a fifth member meaning something different from the
/// other four. Two locks also keep the 10 s write off the one four 30 s refresh
/// tasks hold.
#[derive(Debug, Clone, Default)]
pub struct Fleet {
    pub model: Model,
    pub beats: Beats,
}

/// So a handler asks for the half it reads: `/api/machines` joins the two, and
/// every other route still names the snapshot alone.
impl axum::extract::FromRef<Fleet> for Model {
    fn from_ref(fleet: &Fleet) -> Self {
        fleet.model.clone()
    }
}

impl axum::extract::FromRef<Fleet> for Beats {
    fn from_ref(fleet: &Fleet) -> Self {
        fleet.beats.clone()
    }
}

pub fn router() -> Router<Fleet> {
    Router::new()
        .route("/heartbeat", post(receive))
        .layer(DefaultBodyLimit::max(LIMIT))
}

/// `Json` last, because it consumes the body; its own rejections give 400, 413,
/// 415 and 422 without a line of code here.
async fn receive(
    State(fleet): State<Fleet>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    axum::Json(beat): axum::Json<Heartbeat>,
) -> Response {
    if let Some(reason) = out_of_range(&beat) {
        return (StatusCode::UNPROCESSABLE_ENTITY, reason).into_response();
    }

    let looked = fleet.model.read().await.machines.clone();
    let Some(machines) = looked
        .as_deref()
        .map(Reading::value)
        .and_then(|m| m.as_ref().ok())
    else {
        // Not the agent's fault, so not a 4xx: the daemon cannot yet say who anyone is.
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "the daemon does not yet know which peers exist",
        )
            .into_response();
    };

    let Some(machine) = attribute(machines, from.ip()) else {
        tracing::debug!(
            "dropped a heartbeat from {}: no peer holds that address",
            from.ip()
        );
        return (
            StatusCode::FORBIDDEN,
            "no peer on this tailnet holds the address this heartbeat arrived from",
        )
            .into_response();
    };

    fleet
        .beats
        .write()
        .await
        .insert(machine.id.clone(), Reading::new(beat));
    StatusCode::NO_CONTENT.into_response()
}

/// A dual-stack listener can present a v4 peer as `::ffff:100.64.0.2`, which is
/// not `IpAddr`-equal to `100.64.0.2`; canonicalising both sides is the fix, and
/// getting it wrong drops a real beat in the way that looks like a dead agent.
fn attribute(machines: &[MachineInfo], from: IpAddr) -> Option<&MachineInfo> {
    let from = from.to_canonical();
    machines.iter().find(|machine| {
        machine
            .addresses
            .iter()
            .any(|held| held.to_canonical() == from)
    })
}

/// ADR-0013 names no range, so `u8` alone puts 300 at 422 and 200 at 204 — a
/// line drawn at `u8::MAX` rather than at what a percentage means. R5 scores
/// CPU *idle* as this number's complement, and a value the daemon accepts is a
/// value that score reads.
fn out_of_range(beat: &Heartbeat) -> Option<String> {
    let percentage = |field: &str, value: u8| {
        (value > 100).then(|| {
            format!(
                "invalid value: integer `{value}`, expected a percentage in 0..=100 for `{field}`"
            )
        })
    };
    percentage("cpu_busy_pct", beat.cpu_busy_pct).or_else(|| match beat.power {
        Power::Battery { percent } => percentage("power.battery.percent", percent),
        Power::Ac => None,
    })
}

#[cfg(test)]
// `expect` in a test is a deliberate abort with a message; the workspace lint
// targets the daemon, where the same call would take it down.
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, header};
    use std::time::Duration;
    use tower::ServiceExt as _;
    use yantra_core::inventory::Os;
    use yantra_core::snapshot::Snapshot;

    const BEAT: &str = r#"{"sent_at":"2026-07-31T18:30:00Z","arch":"x86_64","labels":["gpu","cuda","docker"],"free_ram_mb":19942,"free_disk_mb":214003,"cpu_busy_pct":15,"power":"ac"}"#;

    fn peer(id: &str, name: &str, addresses: &[&str]) -> MachineInfo {
        MachineInfo {
            id: id.into(),
            name: name.into(),
            dns_name: format!("{name}.example.ts.net."),
            os: Os::Linux,
            online: true,
            last_seen: None,
            expired: false,
            addresses: addresses
                .iter()
                .map(|a| a.parse().expect("a fixture address"))
                .collect(),
        }
    }

    /// The fleet as Tailscale reports it: two addresses per node, v4 first.
    fn fleet() -> Fleet {
        looking_at(Ok(vec![
            peer("n-1", "cachyos-g14", &["100.64.0.1", "fd7a:115c:a1e0::1"]),
            peer(
                "n-2",
                "bishwajeets-macbook-pro",
                &["100.64.0.2", "fd7a:115c:a1e0::2"],
            ),
        ]))
    }

    fn looking_at(machines: Result<Vec<MachineInfo>, yantra_core::inventory::Error>) -> Fleet {
        Fleet {
            model: Arc::new(RwLock::new(Snapshot {
                machines: Some(Arc::new(Reading::new(machines))),
                ..Snapshot::default()
            })),
            beats: Beats::default(),
        }
    }

    async fn send(fleet: &Fleet, request: Request<Body>) -> (StatusCode, String) {
        let response = router()
            .with_state(fleet.clone())
            .oneshot(request)
            .await
            .expect("the router is infallible");
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("the body is in memory");
        (status, String::from_utf8_lossy(&body).into_owned())
    }

    /// `ConnectInfo` arrives as a request extension, which is what
    /// `into_make_service_with_connect_info` inserts on a real connection.
    fn beat_from(source: &str, body: &str) -> Request<Body> {
        let mut request = Request::post("/heartbeat")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_owned()))
            .expect("a POST with a JSON body is a valid request");
        request.extensions_mut().insert(ConnectInfo(SocketAddr::new(
            source.parse().expect("a fixture address"),
            61620,
        )));
        request
    }

    async fn post(fleet: &Fleet, source: &str, body: &str) -> (StatusCode, String) {
        send(fleet, beat_from(source, body)).await
    }

    async fn beats(fleet: &Fleet) -> Vec<String> {
        fleet.beats.read().await.keys().cloned().collect()
    }

    /// The happy path, and the promise attached to it: an empty body, forever.
    /// A reply the agent could act on is R-12's drift (ADR-0013 §4).
    #[tokio::test]
    async fn a_beat_from_a_known_peer_is_written_and_answered_with_nothing() {
        let fleet = fleet();
        let (status, body) = post(&fleet, "100.64.0.2", BEAT).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
        assert!(
            body.is_empty(),
            "the response carries no instructions: {body}"
        );

        let held = fleet.beats.read().await;
        let reading = held
            .get("n-2")
            .expect("the MacBook's row, keyed on its node id");
        assert_eq!(reading.value().free_ram_mb, 19942);
        assert_eq!(reading.value().power, Power::Ac);
        assert!(reading.age() < Duration::from_secs(1));
        assert_eq!(held.len(), 1, "no row for a machine that did not beat");
    }

    #[tokio::test]
    async fn both_power_states_are_accepted_and_the_charge_survives() {
        let fleet = fleet();
        let battery = BEAT.replace(r#""power":"ac""#, r#""power":{"battery":{"percent":42}}"#);
        let (status, body) = post(&fleet, "100.64.0.1", &battery).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
        assert_eq!(
            fleet.beats.read().await["n-1"].value().power,
            Power::Battery { percent: 42 }
        );
    }

    /// ADR-0013 §5: identity is the source address, so a machine nothing on the
    /// tailnet claims is refused rather than silently accepted. 403 and not 204
    /// because a dropped beat that answers `204` is indistinguishable from a
    /// recorded one, and the thing being diagnosed is usually a stale inventory.
    #[tokio::test]
    async fn a_beat_from_an_address_no_peer_holds_is_dropped_and_says_so() {
        let fleet = fleet();
        let (status, body) = post(&fleet, "100.64.0.99", BEAT).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert!(body.contains("address"), "{body}");
        assert!(beats(&fleet).await.is_empty(), "a stranger wrote a row");
    }

    /// The trap Y-105 left at this comparison site. A dual-stack listener can
    /// present a v4 peer in v6 clothing, and a comparison that misses it drops a
    /// real beat — which looks exactly like the agent being down.
    #[tokio::test]
    async fn a_v4_peer_arriving_v4_mapped_is_the_same_peer() {
        let fleet = fleet();
        let (status, body) = post(&fleet, "::ffff:100.64.0.2", BEAT).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
        assert_eq!(beats(&fleet).await, ["n-2"]);
    }

    /// Both families are the same peer, because `TailscaleIPs` holds both and a
    /// v6-connecting agent is not a stranger.
    #[tokio::test]
    async fn a_peer_is_the_same_peer_over_v6() {
        let fleet = fleet();
        let (status, body) = post(&fleet, "fd7a:115c:a1e0:0:0:0:0:2", BEAT).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
        assert_eq!(beats(&fleet).await, ["n-2"]);
    }

    /// A daemon that has not looked yet cannot know who anyone is, and neither
    /// can one whose look failed. Blaming the agent with a 403 would send
    /// someone to the wrong machine, so this is the daemon's own 5xx.
    #[tokio::test]
    async fn a_beat_the_daemon_cannot_attribute_yet_is_not_the_agents_fault() {
        for fleet in [
            Fleet::default(),
            looking_at(Err(yantra_core::inventory::Error::Command {
                stderr: "failed to connect to local tailscaled".into(),
            })),
        ] {
            let (status, body) = post(&fleet, "100.64.0.2", BEAT).await;
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
            assert!(beats(&fleet).await.is_empty());
        }
    }

    /// One row per machine, overwritten. The no-history non-goal is what makes a
    /// flood cost CPU and nothing else.
    #[tokio::test]
    async fn a_second_beat_overwrites_the_first_rather_than_accumulating() {
        let fleet = fleet();
        post(&fleet, "100.64.0.2", BEAT).await;
        let later = BEAT.replace(r#""free_ram_mb":19942"#, r#""free_ram_mb":8"#);
        let (status, body) = post(&fleet, "100.64.0.2", &later).await;

        assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
        let held = fleet.beats.read().await;
        assert_eq!(held.len(), 1, "the fleet grew a second row for one machine");
        assert_eq!(held["n-2"].value().free_ram_mb, 8);
    }

    /// ADR-0013 §6.2: kilobytes rather than axum's 2 MB default, and `labels` is
    /// the field that could otherwise grow without one.
    #[tokio::test]
    async fn a_body_past_the_limit_is_refused_before_it_is_parsed() {
        let fleet = fleet();
        let fat = BEAT.replace(
            r#"["gpu","cuda","docker"]"#,
            &format!("[{}]", vec![r#""gpu""#; 800].join(",")),
        );
        assert!(fat.len() > LIMIT);
        let (status, body) = post(&fleet, "100.64.0.2", &fat).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{body}");
        assert!(beats(&fleet).await.is_empty());
    }

    /// The strict half of ADR-0013 reaching the wire. An unknown key is a
    /// version mismatch — upgrade the daemon before the agents — and the daemon
    /// says so rather than ignoring a field it does not understand.
    #[tokio::test]
    async fn an_unknown_key_a_missing_field_and_a_wrong_type_are_each_refused() {
        let fleet = fleet();
        for (body, expected) in [
            (
                BEAT.replace(r#""power":"ac""#, r#""power":"ac","os":"linux""#),
                "unknown field `os`",
            ),
            (
                BEAT.replace(r#","power":"ac""#, ""),
                "missing field `power`",
            ),
            (
                BEAT.replace(r#""cpu_busy_pct":15"#, r#""cpu_busy_pct":"eleven""#),
                "expected u8",
            ),
            (
                BEAT.replace(r#""cpu_busy_pct":15"#, r#""cpu_busy_pct":300"#),
                "expected u8",
            ),
        ] {
            let (status, said) = post(&fleet, "100.64.0.2", &body).await;
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{said}");
            assert!(said.contains(expected), "{said}");
        }
        assert!(beats(&fleet).await.is_empty());
    }

    /// `u8` is a byte, not a percentage: without this, 300 is a 422 and 200 is a
    /// 204. R5's score table reads whatever gets through here, so the line
    /// belongs at 100 — and 100 itself is the agent's pessimistic value on a
    /// failed CPU read, so it has to be on the accepting side.
    #[tokio::test]
    async fn a_percentage_above_a_hundred_is_refused_like_one_above_a_byte() {
        let fleet = fleet();
        for body in [
            BEAT.replace(r#""cpu_busy_pct":15"#, r#""cpu_busy_pct":200"#),
            BEAT.replace(r#""power":"ac""#, r#""power":{"battery":{"percent":200}}"#),
        ] {
            let (status, said) = post(&fleet, "100.64.0.2", &body).await;
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{said}");
            assert!(said.contains("percentage in 0..=100"), "{said}");
        }
        assert!(beats(&fleet).await.is_empty());

        let pessimistic = BEAT.replace(r#""cpu_busy_pct":15"#, r#""cpu_busy_pct":100"#);
        let (status, said) = post(&fleet, "100.64.0.2", &pessimistic).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{said}");
    }

    #[tokio::test]
    async fn malformed_json_is_refused_and_so_is_a_body_with_no_content_type() {
        let fleet = fleet();
        let (status, body) = post(&fleet, "100.64.0.2", "{not json").await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

        let mut request = Request::post("/heartbeat")
            .body(Body::from(BEAT))
            .expect("a POST with no content type is still a valid request");
        request.extensions_mut().insert(ConnectInfo(SocketAddr::new(
            "100.64.0.2".parse().expect("a fixture address"),
            61620,
        )));
        let (status, body) = send(&fleet, request).await;
        assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE, "{body}");
        assert!(beats(&fleet).await.is_empty());
    }

    /// Y-071's convention, inverted: `/api` is 405-on-write because a write is
    /// where Q6's absent auth stops being free, and this is the one route where
    /// that cost has been argued for and accepted.
    #[tokio::test]
    async fn this_route_answers_no_verb_but_post() {
        let fleet = fleet();
        for method in ["GET", "PUT", "DELETE", "PATCH"] {
            let request = Request::builder()
                .method(method)
                .uri("/heartbeat")
                .body(Body::empty())
                .expect("a request with no body is valid");
            let (status, body) = send(&fleet, request).await;
            assert_eq!(
                status,
                StatusCode::METHOD_NOT_ALLOWED,
                "{method} /heartbeat reached a handler: {body}"
            );
        }
    }

    /// RFC 3339 does not mean UTC, and `sent_at`'s only job is telling slow
    /// delivery from a wrong clock. The daemon stores the instant and compares
    /// nothing today; what it must never do is compare the text, which would
    /// read a correctly-set machine in another timezone as skewed.
    #[tokio::test]
    async fn an_offset_that_is_not_utc_is_the_same_instant_and_not_skew() {
        let fleet = fleet();
        let elsewhere = BEAT.replace("2026-07-31T18:30:00Z", "2026-08-01T00:00:00+05:30");
        assert!(!elsewhere.contains('Z'));

        let (status, body) = post(&fleet, "100.64.0.2", &elsewhere).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{body}");

        let held = fleet.beats.read().await;
        let stored = held["n-2"].value().sent_at;
        assert_eq!(
            stored.unix_timestamp(),
            1_785_522_600,
            "the ADR's own instant, reached from the other side of the world"
        );
        assert_eq!(
            stored.offset().whole_minutes(),
            330,
            "the offset it was sent in is preserved, not normalised away"
        );
    }
}
