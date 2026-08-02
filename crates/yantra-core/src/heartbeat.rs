//! The heartbeat payload — seven fields, every 10 s, from each machine to `yantrad`.
//!
//! ```json
//! { "sent_at": "2026-07-31T18:30:00Z", "arch": "x86_64", "labels": ["gpu", "cuda", "docker"],
//!   "free_ram_mb": 19942, "free_disk_mb": 214003, "cpu_busy_pct": 15, "power": "ac" }
//! ```
//!
//! [ADR-0013] settles which fields earn their place and why, and this is the one
//! definition both `yantra-agent` (which serialises) and `yantrad` (which
//! deserialises) read — the ADR's *"upgrade the daemon before the agents"* is
//! only checkable while there is a single struct to disagree with.
//!
//! `deny_unknown_fields`, like [`workspace`](crate::workspace) and unlike
//! [`inventory`](crate::inventory): Tailscale's format is someone else's and is
//! tolerated, this one is Yantra's on both ends. There is no version field and
//! no negotiation, so an unknown key is a version mismatch, and the ADR chooses
//! to pay for that loudly rather than to ignore a field the daemon does not
//! understand — an ignored field looks collected and influences nothing.
//!
//! [ADR-0013]: ../../../docs/adr/0013-the-heartbeat-carries-only-what-placement-scores.md

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

/// One machine's report of itself. Every field feeds a named row of R5's filter
/// or score table, except `sent_at` — see ADR-0013 §1 for the audit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Heartbeat {
    /// RFC 3339, and never the freshness source: it separates "delivered
    /// slowly" from "this machine's clock is wrong".
    #[serde(with = "time::serde::rfc3339")]
    pub sent_at: OffsetDateTime,
    pub arch: String,
    pub labels: Vec<String>,
    pub free_ram_mb: u64,
    pub free_disk_mb: u64,
    pub cpu_busy_pct: u8,
    pub power: Power,
}

/// Two variants, so **unknown power is unrepresentable** (ADR-0013 §2, I-9).
/// No `Option<bool>`, no `ac: bool`, no third variant — a desktop with no
/// `AC*` entry is `Ac`, not an unknown bucket that scores it down. Restoring
/// "unknown" would mean changing the wire format and R5's score table together.
///
/// Serde's default external tagging is the wire shape: `"ac"` — the ADR's own
/// example, verbatim — and `{"battery":{"percent":42}}`. The two are different
/// JSON *types*, a string and an object, so neither can be misread as the
/// other however the keys are spelled. An internal tag would force `Ac` into
/// `{"state":"ac"}` and change the ADR's payload for nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Power {
    Ac,
    Battery { percent: u8 },
}

#[cfg(test)]
// `expect` in a test is a deliberate abort with a message; the workspace lint
// targets library code, where the same call would take the daemon down.
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    const ADR_EXAMPLE: &str = r#"{"sent_at":"2026-07-31T18:30:00Z","arch":"x86_64","labels":["gpu","cuda","docker"],"free_ram_mb":19942,"free_disk_mb":214003,"cpu_busy_pct":15,"power":"ac"}"#;

    fn beat(power: Power) -> Heartbeat {
        Heartbeat {
            sent_at: OffsetDateTime::from_unix_timestamp(1_785_522_600)
                .expect("a fixed, valid timestamp"),
            arch: "x86_64".to_string(),
            labels: vec!["gpu".to_string(), "cuda".to_string(), "docker".to_string()],
            free_ram_mb: 19942,
            free_disk_mb: 214003,
            cpu_busy_pct: 15,
            power,
        }
    }

    /// ADR-0013 §1's payload, character for character. A serde bug that renames
    /// a field still round-trips through this crate's own type, so the exact
    /// bytes are the only thing worth asserting on.
    #[test]
    fn the_adr_example_payload_is_both_read_and_written() {
        let parsed: Heartbeat = serde_json::from_str(ADR_EXAMPLE).expect("the ADR's own example");
        assert_eq!(parsed, beat(Power::Ac));
        assert_eq!(
            serde_json::to_string(&parsed).expect("a heartbeat serialises"),
            ADR_EXAMPLE
        );
    }

    #[test]
    fn ac_is_the_bare_string_and_never_an_object() {
        assert_eq!(
            serde_json::to_string(&Power::Ac).expect("Ac serialises"),
            r#""ac""#
        );
        assert_eq!(
            serde_json::from_str::<Power>(r#""ac""#).expect("Ac parses"),
            Power::Ac
        );
    }

    #[test]
    fn a_battery_carries_its_percentage_in_an_object() {
        let battery = Power::Battery { percent: 42 };
        assert_eq!(
            serde_json::to_string(&battery).expect("Battery serialises"),
            r#"{"battery":{"percent":42}}"#
        );
        assert_eq!(
            serde_json::from_str::<Power>(r#"{"battery":{"percent":42}}"#).expect("Battery parses"),
            battery
        );
    }

    /// I-9 as a type: there is no spelling of unknown power that parses.
    #[test]
    fn there_is_no_third_power_state() {
        for attempt in [
            r#""unknown""#,
            r#""battery""#,
            r#"null"#,
            r#"{"unknown":{}}"#,
        ] {
            assert!(
                serde_json::from_str::<Power>(attempt).is_err(),
                "`{attempt}` must not parse as a power state"
            );
        }
    }

    #[test]
    fn a_battery_without_a_percentage_is_not_a_battery() {
        let err = serde_json::from_str::<Power>(r#"{"battery":{}}"#)
            .expect_err("a percentage is the second of two required readings");
        assert!(err.to_string().contains("percent"), "{err}");
    }

    /// The strict half of ADR-0013: an unknown key is a version mismatch, and
    /// the error has to name it because the fix is to upgrade the daemon.
    #[test]
    fn an_unknown_key_is_rejected_and_named() {
        let body = ADR_EXAMPLE.replace(r#""power":"ac""#, r#""power":"ac","os":"linux""#);
        let err = serde_json::from_str::<Heartbeat>(&body).expect_err("`os` is not a field");
        assert!(err.to_string().contains("unknown field `os`"), "{err}");
    }

    #[test]
    fn an_unknown_key_inside_a_battery_is_rejected_too() {
        let err = serde_json::from_str::<Power>(r#"{"battery":{"percent":42,"charging":true}}"#)
            .expect_err("`charging` is not a field");
        assert!(
            err.to_string().contains("unknown field `charging`"),
            "{err}"
        );
    }

    #[test]
    fn a_missing_field_is_rejected_and_named() {
        let body = ADR_EXAMPLE.replace(r#","power":"ac""#, "");
        let err = serde_json::from_str::<Heartbeat>(&body).expect_err("power is required");
        assert!(err.to_string().contains("missing field `power`"), "{err}");
    }

    #[test]
    fn a_percentage_outside_a_byte_is_rejected() {
        let err = serde_json::from_str::<Power>(r#"{"battery":{"percent":300}}"#)
            .expect_err("300 is not a u8");
        assert!(err.to_string().contains("expected u8"), "{err}");
        assert!(
            serde_json::from_str::<Power>(r#"{"battery":{"percent":-1}}"#).is_err(),
            "a negative charge is not a u8"
        );
    }

    /// Epoch seconds are the tempting alternative the ADR did not take, so the
    /// wire format has to refuse them rather than silently accept both.
    #[test]
    fn a_timestamp_that_is_not_rfc_3339_is_rejected() {
        for attempt in [
            r#""31 July 2026""#,
            "1785522600",
            r#""2026-07-31 18:30:00""#,
        ] {
            let body = ADR_EXAMPLE.replace(r#""2026-07-31T18:30:00Z""#, attempt);
            assert!(
                serde_json::from_str::<Heartbeat>(&body).is_err(),
                "`{attempt}` must not parse as sent_at"
            );
        }
    }
}
