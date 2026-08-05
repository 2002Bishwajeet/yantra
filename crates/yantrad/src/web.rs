//! Serving the dashboard itself, so looking at it does not require a laptop
//! running a development server (Y-073).
//!
//! **`YANTRA_WEB` names a directory, and that is still the default build's only
//! way to serve anything.** R-24 is why: a build that wants `web/dist`
//! unconditionally makes every `fmt`, `clippy`, `test` and musl cross-build job
//! depend on npm.
//!
//! Y-140 added the other half for M7, which wants one file to copy onto a
//! Pi 5: the `embed-dashboard` feature compiles `web/dist` into the binary.
//! It is **absent from `default`** and reachable only through the `embedded`
//! module below, which does not exist without it — so nothing in `just check`
//! or `just ci` needs npm, and `just no-node` is the check that keeps it so.
//!
//! **A set `YANTRA_WEB` wins over the embedded copy and a wrong one still
//! refuses**; see `main.rs`'s `dashboard` for why that direction and not the
//! other.

use std::path::{Path, PathBuf};

use axum::Router;
use axum::http::StatusCode;
use tower_http::services::{ServeDir, ServeFile};

#[cfg(feature = "embed-dashboard")]
mod embedded;

/// The built dashboard's directory — `web/dist` after `npm run build`.
const DIR: &str = "YANTRA_WEB";

/// The advice is here rather than at the call site because both the refusal and
/// the placeholder body say it, and saying it differently twice is how one of
/// them goes stale.
fn how() -> String {
    format!(
        "Set {DIR} to the built dashboard, e.g. {DIR}=$PWD/web/dist after `npm --prefix web run build`."
    )
}

#[derive(Debug, thiserror::Error)]
#[error("{DIR}={} holds no index.html, so there is no dashboard there", .0.display())]
pub struct NoIndex(PathBuf);

/// `None` when the daemon is to serve the API alone, which is every
/// pre-Y-073 deployment and every test that does not care.
pub fn from_env() -> Option<PathBuf> {
    std::env::var_os(DIR).map(PathBuf::from)
}

/// Checked at startup rather than per request: a `ServeDir` over a directory
/// that is not there answers 404 to everything, which reads as a bug in the
/// dashboard instead of a typo in one environment variable.
pub fn router(dir: &Path) -> Result<Router, NoIndex> {
    let index = dir.join("index.html");
    if !index.is_file() {
        return Err(NoIndex(dir.to_path_buf()));
    }
    // The fallback is what makes a deep link work: the browser asks for
    // `/workspaces/yantra`, no such file exists, and the app routes it itself.
    Ok(Router::new().fallback_service(ServeDir::new(dir).fallback(ServeFile::new(index))))
}

/// The dashboard this binary carries, which is `None` for every build that
/// leaves `embed-dashboard` off — meaning every build the Rust gate makes.
#[cfg(feature = "embed-dashboard")]
pub fn embedded() -> Option<Router> {
    Some(embedded::router())
}

#[cfg(not(feature = "embed-dashboard"))]
pub fn embedded() -> Option<Router> {
    None
}

/// What answers when no dashboard is configured. A bare 404 would be read as
/// *the daemon is broken* by the one person who can fix it in a second.
pub fn placeholder() -> Router {
    Router::new().fallback(|| async {
        (
            StatusCode::NOT_FOUND,
            format!(
                "yantrad is serving the API only, and no dashboard. {}\n",
                how()
            ),
        )
    })
}

pub fn advice() -> String {
    how()
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    /// A real directory on a real filesystem — the thing under test is whether
    /// files are found and paths are refused, and neither is testable in memory.
    fn built(dir: &Path) {
        std::fs::write(dir.join("index.html"), "<title>Yantra</title>").expect("index");
        std::fs::write(dir.join("app.js"), "console.log(1)").expect("asset");
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("yantra-web-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a temp dir");
        dir
    }

    async fn get(router: Router, path: &str) -> (StatusCode, String) {
        let response = router
            .oneshot(
                Request::builder()
                    .uri(path)
                    .body(Body::empty())
                    .expect("a request"),
            )
            .await
            .expect("a response");
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("a body");
        (status, String::from_utf8_lossy(&body).into_owned())
    }

    #[tokio::test]
    async fn it_serves_the_app_and_its_assets() {
        let dir = temp("serves");
        built(&dir);
        let router = router(&dir).expect("a directory with an index");

        let (status, body) = get(router.clone(), "/").await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("Yantra"), "{body}");

        let (status, body) = get(router, "/app.js").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "console.log(1)");
    }

    /// The browser asks for a path the app routes, not a file that exists.
    #[tokio::test]
    async fn an_unknown_path_gets_the_app_rather_than_a_404() {
        let dir = temp("deep-link");
        built(&dir);

        let (status, body) = get(
            router(&dir).expect("a directory with an index"),
            "/workspaces/yantra",
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("Yantra"), "{body}");
    }

    /// `ServeDir` refuses to escape its root, which is the whole reason this is
    /// not fifteen lines of `std::fs` (§B2).
    ///
    /// It answers **200 with the app**, not 404: the climb is refused and the
    /// SPA fallback then treats the path as one the app routes. So a traversal
    /// attempt and a deep link are indistinguishable by status, and the body is
    /// the only thing worth asserting.
    #[tokio::test]
    async fn it_refuses_to_climb_out_of_the_directory() {
        let dir = temp("escape");
        built(&dir);
        std::fs::write(dir.parent().expect("a parent").join("secret"), "no").expect("bait");

        let (status, body) = get(
            router(&dir).expect("a directory with an index"),
            "/../secret",
        )
        .await;

        assert_ne!(body, "no", "the file above the root was served");
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("Yantra"), "{body}");
    }

    #[tokio::test]
    async fn a_directory_without_an_index_is_refused_at_startup() {
        let dir = temp("empty");

        let refused = router(&dir).expect_err("nothing to serve");

        assert!(refused.to_string().contains("index.html"), "{refused}");
    }

    #[tokio::test]
    async fn no_dashboard_says_so_and_says_how() {
        let (status, body) = get(placeholder(), "/").await;

        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(body.contains(DIR), "{body}");
        assert!(body.contains("API only"), "{body}");
    }
}
