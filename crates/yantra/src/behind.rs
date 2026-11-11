//! One stderr line when this CLI is older than the daemon it talks to (Y-713).
//! ADR-0027 updates the appliance itself, and a CLI on a laptop only by hand.

use std::time::Duration;

use yantra_core::about;

/// Short, because every command that names a daemon waits for it first.
const TIMEOUT: Duration = Duration::from_secs(2);

/// A daemon that does not answer, or answers something unreadable, says
/// nothing here: the command itself reports what is wrong with it.
pub async fn warning(daemon: &str) -> Option<String> {
    let base = daemon.trim_end_matches('/').to_owned();
    let theirs = tokio::task::spawn_blocking({
        let base = base.clone();
        move || version_of(&base)
    })
    .await
    .ok()??;
    line(about::VERSION, &theirs, &base)
}

fn version_of(base: &str) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct About {
        version: String,
    }
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .build()
        .into();
    let body = agent
        .get(format!("{base}/api/about"))
        .call()
        .ok()?
        .body_mut()
        .read_to_string()
        .ok()?;
    serde_json::from_str::<About>(&body)
        .ok()
        .map(|about| about.version)
}

fn line(ours: &str, theirs: &str, daemon: &str) -> Option<String> {
    about::older(ours, theirs).then(|| {
        format!(
            "yantra: this CLI is v{ours} and yantrad at {daemon} is v{theirs}. Update this CLI the \
             way you installed it."
        )
    })
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::routing::get;

    #[test]
    fn an_older_cli_names_both_versions_and_the_daemon() {
        assert_eq!(
            line("0.3.2", "0.11.0", "http://box:7717").as_deref(),
            Some(
                "yantra: this CLI is v0.3.2 and yantrad at http://box:7717 is v0.11.0. Update this \
                 CLI the way you installed it."
            )
        );
    }

    #[test]
    fn an_equal_newer_or_unreadable_daemon_says_nothing() {
        assert_eq!(line("0.11.0", "0.11.0", "d"), None);
        assert_eq!(line("0.12.0", "0.11.0", "d"), None);
        assert_eq!(line("0.11.0", "not a version", "d"), None);
    }

    /// `/api/about` as the daemon answers it, fields this does not read included.
    async fn daemon(version: &'static str) -> String {
        let body = serde_json::json!({"version": version, "target": "x86_64", "uptime_seconds": 3});
        let app = Router::new().route("/api/about", get(move || async move { axum::Json(body) }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a loopback port");
        let address = listener.local_addr().expect("an address");
        tokio::spawn(async move { axum::serve(listener, app).await });
        format!("http://{address}/")
    }

    #[tokio::test]
    async fn a_newer_daemon_warns_once_and_an_equal_one_is_silent() {
        let newer = daemon("999.0.0").await;
        let warned = warning(&newer).await.expect("a newer daemon warns");
        assert_eq!(warned.lines().count(), 1, "{warned}");
        assert!(warned.contains("is v999.0.0"), "{warned}");
        assert_eq!(warning(&daemon(about::VERSION).await).await, None);
    }

    #[tokio::test]
    async fn a_daemon_that_does_not_answer_says_nothing() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let address = listener.local_addr().expect("an address");
        drop(listener);
        assert_eq!(warning(&format!("http://{address}")).await, None);
    }
}
