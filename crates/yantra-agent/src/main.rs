//! `yantra-agent` — the per-machine heartbeat agent.
//!
//! Exists because Tailscale exposes **no** CPU/RAM/GPU/battery/load telemetry
//! (R1, verified against `ipnstate.PeerStatus`, the API v2 OpenAPI spec, and
//! `tailscale metrics`), and because SSH-polling cannot see a sleeping laptop
//! (R5). Pushes a heartbeat every 10s; the daemon marks a machine stale at 30s.
//!
//! Deliberately tiny: it reports, it does not decide. Keeping it that way is
//! what stops Yantra drifting from "orchestrator" into "fleet management" (R-12).
//!
//! The transport is eleven lines of HTTP/1.1 over `std::net::TcpStream` rather
//! than an HTTP crate, and there is no async runtime: measured against this
//! shape, `ureq` costs +57 % of the binary, `hyper` + `tokio` +87 %, `tokio`
//! alone +28 % for one timer, and `reqwest` cannot cross-build to musl at all.
//! See the heartbeat-agent plan §2. If this ever needs redirects, retries, keep-alive,
//! compression or TLS, the decision is wrong and the answer is `ureq` —
//! ADR-0013 §4 and §7 rule out every one of those by name.

use std::env;
use std::fmt;
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::ExitCode;
use std::thread;
use std::time::{Duration, Instant};

use yantra_core::heartbeat::Heartbeat;

mod probes;

/// ADR-0013 §7: it never changes. 10 s is slow enough that backoff is ceremony,
/// and three of them is the daemon's staleness threshold.
const INTERVAL: Duration = Duration::from_secs(10);

/// Shorter than the interval on every leg, so a daemon that accepts and then
/// stalls cannot push the next beat toward looking stale.
const TIMEOUT: Duration = Duration::from_secs(3);

/// The agent's whole configuration (ADR-0013 §4), and it is an address: a name
/// works for four of five agents and fails on the fifth (I-50).
const DAEMON: &str = "YANTRA_DAEMON";

fn main() -> ExitCode {
    let daemon = match env::var(DAEMON).map_err(|_| unset()).and_then(parse_daemon) {
        Ok(daemon) => daemon,
        Err(reason) => {
            eprintln!("yantra-agent: {reason}");
            return ExitCode::FAILURE;
        }
    };
    // ADR-0013 §1: the fixed facts are measured here and only their transmission
    // repeats. `nvidia-smi` costs 1.25 s, which no 10 s loop can afford.
    let fixed = probes::Fixed::measure();
    // The fixed facts are said once because an empty label set is a permanent,
    // silent hard-filter-4 rejection, and this is the only place to see it
    // before the read model renders it (heartbeat-agent plan §9).
    eprintln!(
        "yantra-agent: reporting to {daemon} every {}s — {fixed:?}",
        INTERVAL.as_secs()
    );
    run(daemon, move || probes::beat(&fixed))
}

fn unset() -> String {
    format!(
        "{DAEMON} is unset. Set it to the tailnet address and port of the machine running yantrad, e.g. {DAEMON}=100.x.x.x:7717."
    )
}

fn parse_daemon(value: String) -> Result<SocketAddr, String> {
    value.parse().map_err(|_| {
        format!(
            "{DAEMON}={value} is not an address and port. The agent resolves no names, because a \
             MagicDNS short name resolves to 127.0.1.1 and the daemon does not listen there \
             (I-50). Use a tailnet address, e.g. {DAEMON}=100.x.x.x:7717."
        )
    })
}

/// The loop, and the only stateful thing in the process.
///
/// `measure` is [`probes::beat`] over the fixed facts taken at start: one
/// `Heartbeat`, measured now, and infallible because a probe that cannot read
/// something returns the pessimistic value rather than an error. A failed POST
/// drops that beat rather than queueing it — a heartbeat delivered 40 s late is
/// a false statement with a timestamp attached — and never exits, because a
/// restarted daemon must not require reinstalling five agents (ADR-0013 §7).
fn run(daemon: SocketAddr, mut measure: impl FnMut() -> Heartbeat) -> ! {
    let mut log = Log::default();
    loop {
        let started = Instant::now();
        if let Some(line) = log.line(post(daemon, &measure())) {
            eprintln!("yantra-agent: {line}");
        }
        thread::sleep(INTERVAL.saturating_sub(started.elapsed()));
    }
}

#[derive(Default)]
struct Log {
    quiet: bool,
}

impl Log {
    /// ADR-0013 §7: the first failure is said out loud and every one after it is
    /// swallowed until a beat lands, so a daemon down for a day does not produce
    /// 8,640 identical lines.
    fn line(&mut self, outcome: Result<(), Dropped>) -> Option<String> {
        match (outcome, self.quiet) {
            (Err(dropped), false) => {
                self.quiet = true;
                Some(format!(
                    "heartbeat dropped, and further ones will be too — {dropped}"
                ))
            }
            (Ok(()), true) => {
                self.quiet = false;
                Some("heartbeat delivered again".to_string())
            }
            _ => None,
        }
    }
}

fn post(daemon: SocketAddr, beat: &Heartbeat) -> Result<(), Dropped> {
    let body = serde_json::to_string(beat).map_err(Dropped::Body)?;
    let request = format!(
        "POST /heartbeat HTTP/1.1\r\n\
         Host: {daemon}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         \r\n\
         {body}",
        body.len()
    );

    let mut stream = TcpStream::connect_timeout(&daemon, TIMEOUT).map_err(Dropped::Io)?;
    stream
        .set_write_timeout(Some(TIMEOUT))
        .map_err(Dropped::Io)?;
    stream
        .set_read_timeout(Some(TIMEOUT))
        .map_err(Dropped::Io)?;
    stream.write_all(request.as_bytes()).map_err(Dropped::Io)?;

    // The status line is the whole of the response the agent reads. A reply it
    // acts on is a control channel, and that is how a reporter stops being one.
    let mut status = [0u8; 15];
    stream.read_exact(&mut status).map_err(Dropped::Io)?;
    if &status[9..12] != b"204" {
        return Err(Dropped::Status(
            String::from_utf8_lossy(&status).into_owned(),
        ));
    }
    Ok(())
}

#[derive(Debug)]
enum Dropped {
    Body(serde_json::Error),
    Io(io::Error),
    Status(String),
}

impl fmt::Display for Dropped {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Body(error) => write!(f, "it did not serialise: {error}"),
            Self::Io(error) => write!(f, "{error}"),
            Self::Status(line) => write!(f, "the daemon answered `{line}`, not 204"),
        }
    }
}

#[cfg(test)]
// `expect` in a test is a deliberate abort with a message; the workspace lint
// targets code that has to stay up for months.
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread::JoinHandle;
    use time::OffsetDateTime;
    use yantra_core::heartbeat::Power;

    /// ADR-0013 §1's payload, which is also `yantra-core`'s own test vector.
    const BODY: &str = r#"{"sent_at":"2026-07-31T18:30:00Z","arch":"x86_64","labels":["gpu","cuda","docker"],"free_ram_mb":19942,"free_disk_mb":214003,"cpu_busy_pct":15,"power":"ac"}"#;

    fn beat() -> Heartbeat {
        Heartbeat {
            sent_at: OffsetDateTime::from_unix_timestamp(1_785_522_600)
                .expect("a fixed, valid timestamp"),
            arch: "x86_64".to_string(),
            labels: vec!["gpu".to_string(), "cuda".to_string(), "docker".to_string()],
            free_ram_mb: 19942,
            free_disk_mb: 214003,
            cpu_busy_pct: 15,
            power: Power::Ac,
        }
    }

    /// Written out rather than shared with `post`, so a change to the request
    /// has to be made twice and seen once.
    fn expected_request(daemon: SocketAddr) -> String {
        format!(
            "POST /heartbeat HTTP/1.1\r\nHost: {daemon}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{BODY}",
            BODY.len()
        )
    }

    fn listener() -> (TcpListener, SocketAddr) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let address = listener.local_addr().expect("the port it got");
        (listener, address)
    }

    /// A real socket, not a mock (§B3) — the transport *is* what is under test.
    fn serve(listener: TcpListener, response: &'static [u8]) -> JoinHandle<Vec<u8>> {
        let address = listener.local_addr().expect("the port it got");
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("the agent connects");
            let mut request = vec![0u8; expected_request(address).len()];
            stream.read_exact(&mut request).expect("the whole request");
            stream.write_all(response).expect("the daemon answers");
            request
        })
    }

    #[test]
    fn the_daemon_reads_exactly_these_bytes() {
        let (listener, daemon) = listener();
        let served = serve(listener, b"HTTP/1.1 204 No Content\r\n\r\n");

        post(daemon, &beat()).expect("a 204 is a delivered beat");

        let request = served.join().expect("the listener thread");
        assert_eq!(String::from_utf8_lossy(&request), expected_request(daemon));
    }

    #[test]
    fn a_daemon_that_is_not_there_drops_the_beat() {
        let (listener, daemon) = listener();
        drop(listener);

        let dropped = post(daemon, &beat()).expect_err("nothing is listening");

        assert!(matches!(dropped, Dropped::Io(_)), "{dropped}");
    }

    #[test]
    fn a_daemon_that_accepts_and_closes_drops_the_beat() {
        let (listener, daemon) = listener();
        let served = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("the agent connects");
            drop(stream);
        });

        let dropped = post(daemon, &beat()).expect_err("no status line arrives");

        assert!(matches!(dropped, Dropped::Io(_)), "{dropped}");
        served.join().expect("the listener thread");
    }

    #[test]
    fn a_status_that_is_not_204_drops_the_beat_and_names_it() {
        let (listener, daemon) = listener();
        let served = serve(listener, b"HTTP/1.1 422 Unprocessable Entity\r\n\r\n");

        let dropped = post(daemon, &beat()).expect_err("422 is not a delivered beat");

        assert!(dropped.to_string().contains("422"), "{dropped}");
        served.join().expect("the listener thread");
    }

    /// The daemon rejecting the schema is the loud failure ADR-0013 §1 buys with
    /// `deny_unknown_fields`, and the agent must survive it beat after beat.
    #[test]
    fn a_rejected_beat_neither_exits_nor_repeats_itself() {
        let mut log = Log::default();
        let refused = || Err(Dropped::Status("HTTP/1.1 422 Un".to_string()));

        assert!(log.line(refused()).is_some(), "the first failure is said");
        assert!(log.line(refused()).is_none(), "the second is not");
        assert!(log.line(refused()).is_none(), "nor the third");
        assert!(log.line(Ok(())).is_some(), "recovery is said");
        assert!(log.line(Ok(())).is_none(), "and then quiet again");
        assert!(log.line(refused()).is_some(), "a second outage is said too");
    }

    #[test]
    fn a_name_is_refused_at_startup_with_the_reason() {
        let refused =
            parse_daemon("cachyos-g14:7717".to_string()).expect_err("the agent resolves no names");
        assert!(refused.contains("127.0.1.1"), "{refused}");

        assert!(
            parse_daemon("100.64.0.1".to_string()).is_err(),
            "an address without a port is not a destination"
        );
        parse_daemon("100.64.0.1:7717".to_string()).expect("an address and a port");
        parse_daemon("[fd7a:115c::1]:7717".to_string()).expect("the daemon binds v6 as well");
    }
}
