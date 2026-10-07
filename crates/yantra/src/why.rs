//! `yantra why <workspace> --daemon <url>`: ranks the machines whose heartbeat is
//! fresh, and says why each one won or lost (Y-452).
//!
//! The beats live only in `yantrad`'s memory (Y-044), so this reads them from
//! `GET /api/machines`. The scoring is [`placement::rank`]; this file fetches and
//! renders, and prints every term that moves the rank (I-10).

use std::fmt::Write as _;
use std::time::Duration;

use serde::Deserialize;
use yantra_core::heartbeat::Power;
use yantra_core::placement::{self, Candidate, Ranking, Scored, Why};
use yantra_core::workspace::{self, Workspace};

const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Workspace(#[from] workspace::Error),
    #[error("could not reach yantrad at {daemon}: {detail}")]
    Unreachable { daemon: String, detail: String },
    #[error("yantrad at {daemon} sent an unreadable answer: {detail}")]
    Unreadable { daemon: String, detail: String },
    #[error("yantrad answered {status}: {body}")]
    Refused { status: u16, body: String },
    #[error("yantrad at {daemon} did not answer with a machine list: {detail}")]
    NotAList { daemon: String, detail: String },
    #[error("yantrad has not looked at the tailnet yet; try again in a few seconds")]
    NeverLooked,
    #[error("yantrad could not list the machines: {0}")]
    LookFailed(String),
}

/// What to print, and whether any machine ranked. R5 fails fast when none does.
#[derive(Debug)]
pub struct Report {
    pub text: String,
    pub placed: bool,
}

/// The workspace is loaded by the caller, so a missing one is reported before
/// the daemon is asked anything.
pub fn why(workspace: Result<Workspace, workspace::Error>, daemon: &str) -> Result<Report, Error> {
    let workspace = workspace?;
    let ranking = placement::rank(fetch(daemon)?);
    Ok(Report {
        placed: !ranking.ranked.is_empty(),
        text: render(&ranking, &workspace.machine),
    })
}

/// `yantrad`'s `Answer` envelope, read for the fields the scorer needs and no
/// others. ADR-0012 keeps the daemon's DTOs out of core, so this is the CLI's own.
#[derive(Deserialize)]
#[serde(tag = "looked", rename_all = "lowercase")]
enum Answer {
    Ok { data: Vec<Machine> },
    Failed { error: String },
    Never,
}

#[derive(Deserialize)]
struct Machine {
    name: String,
    online: bool,
    heartbeat: Option<Beat>,
}

#[derive(Deserialize)]
struct Beat {
    age_seconds: u64,
    free_ram_mb: u64,
    cpu_busy_pct: u8,
    power: Power,
}

fn fetch(daemon: &str) -> Result<Vec<Candidate>, Error> {
    let base = daemon.trim_end_matches('/');
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(TIMEOUT))
        .build()
        .into();
    let mut response = agent
        .get(format!("{base}/api/machines"))
        .call()
        .map_err(|error| Error::Unreachable {
            daemon: base.to_owned(),
            detail: error.to_string(),
        })?;
    let status = response.status();
    let body = response
        .body_mut()
        .read_to_string()
        .map_err(|error| Error::Unreadable {
            daemon: base.to_owned(),
            detail: error.to_string(),
        })?;
    if !status.is_success() {
        return Err(Error::Refused {
            status: status.as_u16(),
            body: body.trim().to_owned(),
        });
    }
    let answer: Answer = serde_json::from_str(&body).map_err(|error| Error::NotAList {
        daemon: base.to_owned(),
        detail: error.to_string(),
    })?;
    match answer {
        Answer::Ok { data } => Ok(data
            .into_iter()
            .map(|machine| Candidate {
                machine: machine.name,
                online: machine.online,
                beat: machine.heartbeat.map(|beat| placement::Beat {
                    age: Duration::from_secs(beat.age_seconds),
                    free_ram_mb: beat.free_ram_mb,
                    cpu_busy_pct: beat.cpu_busy_pct,
                    power: beat.power,
                }),
            })
            .collect()),
        Answer::Failed { error } => Err(Error::LookFailed(error)),
        Answer::Never => Err(Error::NeverLooked),
    }
}

/// R5's table, then one line per machine saying why it won, lost or was left out.
pub fn render(ranking: &Ranking, home: &str) -> String {
    let total = ranking.ranked.len() + ranking.rejected.len();
    if total == 0 {
        return "yantrad knows no machines, so none can be placed.\n".to_owned();
    }
    let limit = placement::FRESH.as_secs();
    let mut out = String::new();
    let _ = write!(
        out,
        "{}/{total} machines have a beat within {limit} s",
        ranking.ranked.len()
    );
    out.push_str(if ranking.ranked.is_empty() {
        ", so none can be placed.\n"
    } else {
        ".\n"
    });

    let width = ranking
        .ranked
        .iter()
        .map(|s| s.machine.len())
        .chain(ranking.rejected.iter().map(|r| r.machine.len()))
        .chain(["MACHINE".len()])
        .max()
        .unwrap_or(0);
    if !ranking.ranked.is_empty() {
        let _ = writeln!(
            out,
            "\n{:<width$}  {:>5}  {:>5}  {:>5}  {:>5}",
            "MACHINE", "SCORE", "RAM", "CPU", "POWER"
        );
        for s in &ranking.ranked {
            let _ = writeln!(
                out,
                "{:<width$}  {:>5.1}  {:>5.1}  {:>5.1}  {:>5.1}",
                s.machine, s.score, s.terms.ram, s.terms.cpu, s.terms.power
            );
        }
    }

    out.push('\n');
    let mark = |machine: &str| {
        if machine == home {
            " (this workspace's machine)"
        } else {
            ""
        }
    };
    if let Some((winner, rest)) = ranking.ranked.split_first() {
        let said = match rest.first() {
            Some(second) => format!(
                "won: highest score, {:.1} ahead of {}",
                winner.score - second.score,
                second.machine
            ),
            None => "won: the only machine with a fresh beat".to_owned(),
        };
        let _ = writeln!(
            out,
            "{:<width$}  {said}{}",
            winner.machine,
            mark(&winner.machine)
        );
        for loser in rest {
            let _ = writeln!(
                out,
                "{:<width$}  {}{}",
                loser.machine,
                lost(loser, winner),
                mark(&loser.machine)
            );
        }
    }
    for rejected in &ranking.rejected {
        let said = match rejected.why {
            Why::NeverHeard => "never heard from".to_owned(),
            Why::NotReporting { age } => format!(
                "up, but not reporting (an agent or install problem); \
                 the last beat arrived {} s ago, and the limit is {limit} s",
                age.as_secs()
            ),
            Why::AsleepOrOff { age: Some(age) } => format!(
                "asleep or off; the last beat arrived {} s ago",
                age.as_secs()
            ),
            Why::AsleepOrOff { age: None } => "asleep or off, and never heard from".to_owned(),
        };
        let _ = writeln!(
            out,
            "{:<width$}  rejected: {said}{}",
            rejected.machine,
            mark(&rejected.machine)
        );
    }
    out
}

/// Names the term with the largest deficit against the winner, with both raw readings.
fn lost(loser: &Scored, winner: &Scored) -> String {
    let behind = winner.score - loser.score;
    if behind <= 0.0 {
        return format!(
            "lost: tied with {} at {:.1}, which sorts first by name",
            winner.machine, winner.score
        );
    }
    let gb = |mb: u64| mb as f64 / 1024.0;
    let (w, l) = (&winner.beat, &loser.beat);
    let gaps = [
        (
            winner.terms.ram - loser.terms.ram,
            format!(
                "RAM: free RAM {:.1} GB against {:.1} GB",
                gb(l.free_ram_mb),
                gb(w.free_ram_mb)
            ),
        ),
        (
            winner.terms.cpu - loser.terms.cpu,
            format!(
                "CPU: {} % busy against {} %",
                l.cpu_busy_pct, w.cpu_busy_pct
            ),
        ),
        (
            winner.terms.power - loser.terms.power,
            format!("POWER: {} against {}", power(l.power), power(w.power)),
        ),
    ];
    let mut largest = &gaps[0];
    for gap in &gaps[1..] {
        if gap.0 > largest.0 {
            largest = gap;
        }
    }
    format!(
        "lost: {behind:.1} behind {}; the largest gap is {}",
        winner.machine, largest.1
    )
}

fn power(power: Power) -> String {
    match power {
        Power::Ac => "AC".to_owned(),
        Power::Battery { percent } => format!("battery at {percent} %"),
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::http::StatusCode;
    use axum::routing::get;
    use std::path::PathBuf;

    fn candidate(name: &str, online: bool, beat: Option<(u64, u64, u8, Power)>) -> Candidate {
        Candidate {
            machine: name.to_owned(),
            online,
            beat: beat.map(|(age, ram, cpu, power)| placement::Beat {
                age: Duration::from_secs(age),
                free_ram_mb: ram,
                cpu_busy_pct: cpu,
                power,
            }),
        }
    }

    fn fleet() -> Vec<Candidate> {
        vec![
            candidate("zenith", true, Some((3, 19_968, 15, Power::Ac))),
            candidate(
                "mba",
                true,
                Some((8, 2_150, 40, Power::Battery { percent: 50 })),
            ),
            candidate("pi5", false, Some((412, 4_096, 5, Power::Ac))),
            candidate("winbox", true, Some((45, 8_192, 5, Power::Ac))),
            candidate("ghost", true, None),
            candidate("cold", false, None),
        ]
    }

    #[test]
    fn the_table_and_every_why_line() {
        let text = render(&placement::rank(fleet()), "mba");
        assert_eq!(
            text,
            "\
2/6 machines have a beat within 30 s.

MACHINE  SCORE    RAM    CPU  POWER
zenith    42.8   20.0   12.8   10.0
mba       13.6    2.6    9.0    2.0

zenith   won: highest score, 29.2 ahead of mba
mba      lost: 29.2 behind zenith; the largest gap is RAM: free RAM 2.1 GB against 19.5 GB (this workspace's machine)
cold     rejected: asleep or off, and never heard from
ghost    rejected: never heard from
pi5      rejected: asleep or off; the last beat arrived 412 s ago
winbox   rejected: up, but not reporting (an agent or install problem); the last beat arrived 45 s ago, and the limit is 30 s
"
        );
    }

    #[test]
    fn a_lone_winner_and_a_tie_say_so() {
        let lone = render(
            &placement::rank(vec![candidate("pi", true, Some((1, 0, 0, Power::Ac)))]),
            "pi",
        );
        assert!(
            lone.contains(
                "pi       won: the only machine with a fresh beat (this workspace's machine)"
            ),
            "{lone}"
        );
        let tied = render(
            &placement::rank(vec![
                candidate("b", true, Some((1, 0, 0, Power::Ac))),
                candidate("a", true, Some((1, 0, 0, Power::Ac))),
            ]),
            "x",
        );
        assert!(
            tied.contains("won: highest score, 0.0 ahead of b"),
            "{tied}"
        );
        assert!(
            tied.contains("b        lost: tied with a at 25.0, which sorts first by name"),
            "{tied}"
        );
    }

    #[test]
    fn the_largest_gap_names_cpu_or_power_with_both_readings() {
        let cpu = render(
            &placement::rank(vec![
                candidate("idle", true, Some((1, 0, 0, Power::Ac))),
                candidate("busy", true, Some((1, 0, 90, Power::Ac))),
            ]),
            "x",
        );
        assert!(
            cpu.contains("the largest gap is CPU: 90 % busy against 0 %"),
            "{cpu}"
        );
        let power = render(
            &placement::rank(vec![
                candidate("plugged", true, Some((1, 0, 0, Power::Ac))),
                candidate(
                    "flat",
                    true,
                    Some((1, 0, 0, Power::Battery { percent: 10 })),
                ),
            ]),
            "x",
        );
        assert!(
            power.contains("the largest gap is POWER: battery at 10 % against AC"),
            "{power}"
        );
    }

    #[test]
    fn no_fresh_machine_is_not_placed() {
        let ranking = placement::rank(vec![candidate("cold", false, None)]);
        let text = render(&ranking, "cold");
        assert_eq!(
            text,
            "\
0/1 machines have a beat within 30 s, so none can be placed.

cold     rejected: asleep or off, and never heard from (this workspace's machine)
"
        );
    }

    #[test]
    fn an_empty_fleet_says_so() {
        assert_eq!(
            render(&Ranking::default(), "x"),
            "yantrad knows no machines, so none can be placed.\n"
        );
    }

    fn workspace() -> Result<Workspace, workspace::Error> {
        Ok(Workspace {
            name: "demo".to_owned(),
            machine: "zenith".to_owned(),
            repo: PathBuf::from("/srv/demo"),
            startup: None,
        })
    }

    /// Serves `body` with `status` on `/api/machines`.
    async fn daemon(status: StatusCode, body: &'static str) -> String {
        let app = Router::new().route("/api/machines", get(move || async move { (status, body) }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a loopback port");
        let address = listener.local_addr().expect("an address");
        tokio::spawn(async move { axum::serve(listener, app).await });
        format!("http://{address}/")
    }

    async fn ask(
        workspace: Result<Workspace, workspace::Error>,
        daemon: String,
    ) -> Result<Report, Error> {
        tokio::task::spawn_blocking(move || why(workspace, &daemon))
            .await
            .expect("the blocking thread")
    }

    /// The daemon's own shape (`api.rs`'s `Answer` and `Machine`), fields the
    /// scorer does not read included, so an extra field never breaks the CLI.
    const MACHINES: &str = r#"{"looked":"ok","age_seconds":4,"data":[
        {"name":"zenith","dns_name":"zenith.ts.net.","address":"100.64.0.1","os":"linux",
         "online":true,"expired":false,"last_seen":null,"ownership":"yours",
         "heartbeat":{"age_seconds":3,"arch":"x86_64","labels":["gpu"],"free_ram_mb":19968,
                      "free_disk_mb":1,"cpu_busy_pct":15,"power":"ac"}},
        {"name":"mba","dns_name":"mba.ts.net.","address":null,"os":"macOS",
         "online":true,"expired":false,"last_seen":null,"ownership":"yours",
         "heartbeat":{"age_seconds":8,"arch":"aarch64","labels":[],"free_ram_mb":2150,
                      "free_disk_mb":1,"cpu_busy_pct":40,"power":{"battery":{"percent":50}}}},
        {"name":"pi5","dns_name":"pi5.ts.net.","address":null,"os":"linux",
         "online":false,"expired":false,"last_seen":"2026-10-07T10:00:00Z","ownership":"yours",
         "heartbeat":null}]}"#;

    #[tokio::test]
    async fn the_daemons_machines_are_ranked() {
        let report = ask(workspace(), daemon(StatusCode::OK, MACHINES).await)
            .await
            .expect("an answer");
        assert!(report.placed);
        assert!(report.text.starts_with("2/3 machines"), "{}", report.text);
        assert!(
            report.text.contains(
                "zenith   won: highest score, 29.2 ahead of mba (this workspace's machine)"
            ),
            "{}",
            report.text
        );
        assert!(
            report
                .text
                .contains("pi5      rejected: asleep or off, and never heard from"),
            "{}",
            report.text
        );
    }

    #[tokio::test]
    async fn a_fleet_with_no_fresh_beat_is_not_placed() {
        let body = r#"{"looked":"ok","age_seconds":1,"data":[]}"#;
        let report = ask(workspace(), daemon(StatusCode::OK, body).await)
            .await
            .expect("an answer");
        assert!(!report.placed);
    }

    #[tokio::test]
    async fn a_missing_workspace_is_reported_before_the_daemon_is_asked() {
        let missing = Err(workspace::Error::NotFound {
            name: "nope".to_owned(),
            path: PathBuf::from("/c/yantra/workspaces/nope.toml"),
        });
        // Nothing listens on port 9, so reaching it would be `Unreachable`.
        let err = ask(missing, "http://127.0.0.1:9".to_owned())
            .await
            .expect_err("no workspace");
        assert!(matches!(err, Error::Workspace(_)), "{err:?}");
        assert!(
            err.to_string().starts_with("no workspace named `nope`"),
            "{err}"
        );
    }

    #[tokio::test]
    async fn a_daemon_that_cannot_be_reached_is_named() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let address = listener.local_addr().expect("an address");
        drop(listener);
        let err = ask(workspace(), format!("http://{address}"))
            .await
            .expect_err("nothing listens");
        assert!(
            err.to_string()
                .starts_with(&format!("could not reach yantrad at http://{address}: ")),
            "{err}"
        );
    }

    #[tokio::test]
    async fn a_body_that_is_not_json_is_an_error() {
        let err = ask(workspace(), daemon(StatusCode::OK, "<html>hi</html>").await)
            .await
            .expect_err("not JSON");
        assert!(matches!(err, Error::NotAList { .. }), "{err:?}");
    }

    #[tokio::test]
    async fn a_refusal_carries_the_status_and_the_body() {
        let err = ask(
            workspace(),
            daemon(StatusCode::NOT_FOUND, "no route\n").await,
        )
        .await
        .expect_err("404");
        assert_eq!(err.to_string(), "yantrad answered 404: no route");
    }

    #[tokio::test]
    async fn a_daemon_that_has_not_looked_or_failed_to_look_says_so() {
        let never = ask(
            workspace(),
            daemon(StatusCode::OK, r#"{"looked":"never"}"#).await,
        )
        .await
        .expect_err("never");
        assert!(matches!(never, Error::NeverLooked), "{never:?}");
        let failed = ask(
            workspace(),
            daemon(
                StatusCode::OK,
                r#"{"looked":"failed","age_seconds":2,"error":"tailscale is not running"}"#,
            )
            .await,
        )
        .await
        .expect_err("failed");
        assert_eq!(
            failed.to_string(),
            "yantrad could not list the machines: tailscale is not running"
        );
    }
}
