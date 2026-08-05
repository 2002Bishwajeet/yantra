//! The dashboard compiled into the binary, so M7's appliance is one file to
//! copy rather than a binary, a directory and a variable (Y-140).
//!
//! Nothing here exists without `embed-dashboard`, which is absent from
//! `default`: the module is behind a `#[cfg]` and `include_dir` is an optional
//! dependency, so a default build neither reads `web/dist` nor compiles the
//! macro that would. That is R-24's retire condition held by construction
//! rather than by care.

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderValue, Uri, header};
use axum::response::Response;
use include_dir::{Dir, include_dir};

static DIST: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../../web/dist");

/// `include_str!` rather than a lookup in `DIST`, so a `web/dist` with no
/// `index.html` is a **build** error. That is where the directory half's
/// startup refusal belongs once the directory is chosen at build time.
const INDEX: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../web/dist/index.html"
));

pub fn router() -> Router {
    Router::new().fallback(serve)
}

/// A miss answers the app, which is what makes a deep link work — the same job
/// the directory half gives `ServeFile`. A path that climbs out of the root
/// lands here too, and needs no guard: this is a lookup in a table the compiler
/// built, so `..` is a key no file has rather than a directory to walk.
async fn serve(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    match DIST.get_file(path) {
        Some(file) => respond(content_type(path), file.contents()),
        None => respond(content_type("index.html"), INDEX.as_bytes()),
    }
}

/// The directory half gets this from `ServeDir`. Here it is a list of what
/// `vite build` emits, which is cheaper than a dependency that knows every
/// media type in the world.
fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("woff2") => "font/woff2",
        Some("webmanifest") => "application/manifest+json",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    }
}

fn respond(content_type: &'static str, bytes: &'static [u8]) -> Response {
    let mut response = Response::new(Body::from(bytes));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    /// Nothing in this module opens a file, and that is the point of the
    /// assertions below: they compare what was served against what the binary
    /// carries, never against `web/dist`.
    async fn get(path: &str) -> (StatusCode, String, Vec<u8>) {
        let response = router()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .body(Body::empty())
                    .expect("a request"),
            )
            .await
            .expect("a response");
        let status = response.status();
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        let body = axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024)
            .await
            .expect("a body");
        (status, content_type, body.to_vec())
    }

    #[tokio::test]
    async fn it_serves_the_index_the_binary_carries() {
        let (status, content_type, body) = get("/").await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(content_type, "text/html; charset=utf-8");
        assert_eq!(body, INDEX.as_bytes());
    }

    #[tokio::test]
    async fn it_serves_a_built_asset_with_its_own_type() {
        let asset = DIST
            .get_dir("assets")
            .expect("vite writes assets/")
            .files()
            .find(|file| file.path().extension().is_some_and(|kind| kind == "js"))
            .expect("a bundle");
        let path = asset.path().to_str().expect("a utf-8 path");

        let (status, content_type, body) = get(&format!("/{path}")).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(content_type, "text/javascript; charset=utf-8");
        assert_eq!(body, asset.contents());
    }

    /// The directory half's `an_unknown_path_gets_the_app_rather_than_a_404`,
    /// asserted here because the two must not answer differently.
    #[tokio::test]
    async fn an_unknown_path_gets_the_app_rather_than_a_404() {
        let (status, _, body) = get("/workspaces/yantra").await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, INDEX.as_bytes());
    }

    /// 200 with the app, exactly as the directory half answers it — a traversal
    /// attempt and a deep link stay indistinguishable by status.
    #[tokio::test]
    async fn a_path_that_climbs_out_gets_the_app() {
        let (status, _, body) = get("/../secret").await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, INDEX.as_bytes());
    }
}
