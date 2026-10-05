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
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::response::Response;
use include_dir::{Dir, include_dir};
use std::hash::{DefaultHasher, Hash, Hasher};

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
async fn serve(uri: Uri, headers: HeaderMap) -> Response {
    let asked = uri.path().trim_start_matches('/');
    let (path, identity) = match DIST.get_file(asked) {
        Some(file) => (asked, file.contents()),
        None => ("index.html", INDEX.as_bytes()),
    };
    // `npm run build` gzips the js, css and svg beside the originals, so the
    // appliance sends bytes it compressed once at build time (Y-357).
    let gzipped = wants_gzip(&headers)
        .then(|| DIST.get_file(format!("{path}.gz")))
        .flatten();
    let asked_for = headers.get(header::IF_NONE_MATCH);
    match gzipped {
        Some(file) => compressed(path, file.contents(), asked_for),
        None => respond(path, identity, asked_for),
    }
}

fn wants_gzip(headers: &HeaderMap) -> bool {
    headers
        .get(header::ACCEPT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.split(',').any(acceptable_gzip))
}

/// `q=0` refuses a coding rather than ranking it last (RFC 9110 §12.5.3), and
/// the directory half gets that from `tower-http`. Nothing else about a quality
/// value is read: there are two answers here, so an order between them is moot.
fn acceptable_gzip(coding: &str) -> bool {
    let mut parts = coding.split(';').map(str::trim);
    if parts.next() != Some("gzip") {
        return false;
    }
    !parts.any(|parameter| {
        parameter
            .strip_prefix("q=")
            .and_then(|quality| quality.parse::<f32>().ok())
            .is_some_and(|quality| quality <= 0.0)
    })
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
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("webmanifest") => "application/manifest+json",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    }
}

/// The tag hashes the bytes sent, so the gzip and identity bodies of one file
/// are two representations with two tags. `DefaultHasher` may change between
/// Rust releases, which costs one download after a rebuild and nothing more.
fn respond(path: &str, bytes: &'static [u8], asked_for: Option<&HeaderValue>) -> Response {
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    let etag = format!("\"{:016x}\"", hasher.finish());
    let fresh = asked_for
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| matches(value, &etag));
    let mut response = if fresh {
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::NOT_MODIFIED;
        response
    } else {
        let mut response = Response::new(Body::from(bytes));
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static(content_type(path)),
        );
        response
    };
    // Vite names `assets/` by content hash. Everything else, the SPA fallback
    // under `/assets/` included, keeps its name across releases, so it revalidates.
    let cache = if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    headers.insert(header::VARY, HeaderValue::from_static("accept-encoding"));
    if let Ok(etag) = HeaderValue::from_str(&etag) {
        headers.insert(header::ETAG, etag);
    }
    response
}

/// Weak comparison (RFC 9110 §13.1.2), which is what `ServeDir` does, so the two
/// halves answer one `If-None-Match` the same way.
fn matches(if_none_match: &str, etag: &str) -> bool {
    if_none_match
        .split(',')
        .map(str::trim)
        .any(|tag| tag == "*" || tag.strip_prefix("W/").unwrap_or(tag) == etag)
}

fn compressed(path: &str, bytes: &'static [u8], asked_for: Option<&HeaderValue>) -> Response {
    let mut response = respond(path, bytes, asked_for);
    if response.status() != StatusCode::NOT_MODIFIED {
        response
            .headers_mut()
            .insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
    }
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

    /// The content-encoding and the bytes, for a client that names one.
    async fn get_encoded(path: &str, accept: Option<&str>) -> (String, Vec<u8>) {
        let mut request = Request::builder().uri(path);
        if let Some(accept) = accept {
            request = request.header(header::ACCEPT_ENCODING, accept);
        }
        let response = router()
            .oneshot(request.body(Body::empty()).expect("a request"))
            .await
            .expect("a response");
        let encoding = response
            .headers()
            .get(header::CONTENT_ENCODING)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        let body = axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024)
            .await
            .expect("a body");
        (encoding, body.to_vec())
    }

    /// The directory half's `a_client_that_asks_for_gzip_gets_the_precompressed_asset`.
    /// The binary carries both files, so the appliance compresses nothing per
    /// request.
    #[tokio::test]
    async fn a_client_that_asks_for_gzip_gets_the_precompressed_asset() {
        let asset = DIST
            .get_dir("assets")
            .expect("vite writes assets/")
            .files()
            .find(|file| file.path().extension().is_some_and(|kind| kind == "js"))
            .expect("a bundle");
        let path = asset.path().to_str().expect("a utf-8 path");
        let gz = DIST
            .get_file(format!("{path}.gz"))
            .expect("npm run build gzips every bundle");

        let (encoding, body) = get_encoded(&format!("/{path}"), Some("gzip, deflate")).await;
        assert_eq!(encoding, "gzip");
        assert_eq!(body, gz.contents());

        let (encoding, body) = get_encoded(&format!("/{path}"), None).await;
        assert_eq!(encoding, "");
        assert_eq!(body, asset.contents());

        let (encoding, body) = get_encoded(&format!("/{path}"), Some("gzip;q=0")).await;
        assert_eq!(encoding, "", "q=0 refuses the coding");
        assert_eq!(body, asset.contents());
    }

    async fn send(
        path: &str,
        accept: Option<&str>,
        if_none_match: Option<&str>,
    ) -> (StatusCode, HeaderMap, Vec<u8>) {
        let mut request = Request::builder().uri(path);
        if let Some(accept) = accept {
            request = request.header(header::ACCEPT_ENCODING, accept);
        }
        if let Some(tag) = if_none_match {
            request = request.header(header::IF_NONE_MATCH, tag);
        }
        let response = router()
            .oneshot(request.body(Body::empty()).expect("a request"))
            .await
            .expect("a response");
        let status = response.status();
        let headers = response.headers().clone();
        let body = axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024)
            .await
            .expect("a body");
        (status, headers, body.to_vec())
    }

    fn named(headers: &HeaderMap, name: header::HeaderName) -> &str {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
    }

    fn every_file(dir: &'static Dir<'static>, into: &mut Vec<String>) {
        for file in dir.files() {
            let path = file.path().to_str().expect("a utf-8 path");
            if !path.ends_with(".gz") {
                into.push(format!("/{path}"));
            }
        }
        for child in dir.dirs() {
            every_file(child, into);
        }
    }

    fn a_bundle() -> String {
        let asset = DIST
            .get_dir("assets")
            .expect("vite writes assets/")
            .files()
            .find(|file| file.path().extension().is_some_and(|kind| kind == "js"))
            .expect("a bundle");
        format!("/{}", asset.path().to_str().expect("a utf-8 path"))
    }

    /// Y-372's done condition: before it, every open cost the whole first load.
    #[tokio::test]
    async fn a_second_open_costs_a_fraction_of_the_first() {
        let mut paths = vec!["/".to_owned()];
        every_file(&DIST, &mut paths);

        let mut first = 0;
        let mut tags = Vec::new();
        for path in &paths {
            let (status, headers, body) = send(path, Some("gzip"), None).await;
            assert_eq!(status, StatusCode::OK, "{path}");
            let tag = named(&headers, header::ETAG);
            assert!(!tag.is_empty(), "{path} carries no ETag");
            first += body.len();
            tags.push(tag.to_owned());
        }

        let mut second = 0;
        for (path, tag) in paths.iter().zip(&tags) {
            let (status, headers, body) = send(path, Some("gzip"), Some(tag)).await;
            assert_eq!(status, StatusCode::NOT_MODIFIED, "{path}");
            assert!(body.is_empty(), "{path}");
            assert_eq!(named(&headers, header::ETAG), tag);
            assert_eq!(named(&headers, header::CONTENT_ENCODING), "", "{path}");
            second += body.len();
        }

        assert!(second * 50 < first, "{second} bytes against {first}");
    }

    #[tokio::test]
    async fn hashed_assets_are_immutable_and_the_rest_revalidates() {
        let (_, headers, _) = send(&a_bundle(), None, None).await;
        assert_eq!(
            named(&headers, header::CACHE_CONTROL),
            "public, max-age=31536000, immutable"
        );

        for path in ["/", "/workspaces/yantra", "/sw.js", "/assets/x.js"] {
            let (_, headers, _) = send(path, Some("gzip"), None).await;
            assert_eq!(named(&headers, header::CACHE_CONTROL), "no-cache", "{path}");
        }
    }

    #[tokio::test]
    async fn only_a_matching_tag_gets_a_304() {
        let (_, headers, full) = send("/", None, None).await;
        let tag = named(&headers, header::ETAG).to_owned();

        let (status, _, body) = send("/", None, Some("\"0000000000000000\"")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, full);

        for asked in ["*".to_owned(), format!("W/{tag}"), format!("\"x\", {tag}")] {
            let (status, _, body) = send("/", None, Some(&asked)).await;
            assert_eq!(status, StatusCode::NOT_MODIFIED, "{asked}");
            assert!(body.is_empty());
        }
    }

    #[tokio::test]
    async fn each_representation_has_its_own_tag() {
        let path = a_bundle();
        let (_, gzip, _) = send(&path, Some("gzip"), None).await;
        let (_, identity, _) = send(&path, None, None).await;
        let gzip_tag = named(&gzip, header::ETAG);
        assert_ne!(gzip_tag, named(&identity, header::ETAG));

        let (status, headers, body) = send(&path, None, Some(gzip_tag)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(named(&headers, header::CONTENT_ENCODING), "");
        let asset = DIST
            .get_file(path.trim_start_matches('/'))
            .expect("the bundle");
        assert_eq!(body, asset.contents());
    }

    #[tokio::test]
    async fn every_answer_varies_on_accept_encoding() {
        let mut paths = vec!["/".to_owned(), "/workspaces/yantra".to_owned()];
        every_file(&DIST, &mut paths);
        for path in &paths {
            for accept in [None, Some("gzip")] {
                let (_, headers, _) = send(path, accept, None).await;
                assert_eq!(named(&headers, header::VARY), "accept-encoding", "{path}");
            }
        }
        let (_, headers, _) = send("/", None, Some("*")).await;
        assert_eq!(named(&headers, header::VARY), "accept-encoding");
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

    #[tokio::test]
    async fn it_serves_the_favicon_as_an_icon() {
        let (status, content_type, _) = get("/favicon.ico").await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(content_type, "image/x-icon");
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
