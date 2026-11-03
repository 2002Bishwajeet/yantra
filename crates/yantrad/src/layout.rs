//! `GET` and `PUT /api/layout`: the dashboard layout, kept in
//! [`yantra_core::layout`]'s `dashboard.json`
//! ([ADR-0036](../../../docs/adr/0036-the-dashboard-layout-syncs-through-the-daemon.md)).
//!
//! The `PUT` is a write, so it calls [`allowed`] first (ADR-0016). A `PUT`
//! names the `rev` it read, and an older `rev` gets 409 with the layout on
//! disk. The lock makes the read, the compare and the write one step.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{ConnectInfo, DefaultBodyLimit, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use tokio::sync::Mutex;
use yantra_core::inventory::Inventory;
use yantra_core::layout::{self, Error, Layout};

use crate::write::{Authoriser, Refused, allowed, chain};

/// A layout is a few kilobytes; 64 KiB leaves room and refuses a flood.
const BODY_LIMIT: usize = 64 * 1024;

#[derive(Clone)]
struct Layouts<I> {
    authoriser: Authoriser<I>,
    /// `None` is no config directory, and then every call fails.
    dir: Option<PathBuf>,
    lock: Arc<Mutex<()>>,
}

pub fn router<I, S>(authoriser: Authoriser<I>) -> Router<S>
where
    I: Inventory + Clone + Send + Sync + 'static,
    S: Clone + Send + Sync + 'static,
{
    let dir = layout::dir()
        .inspect_err(|error| tracing::warn!("no dashboard layout can be kept: {error}"))
        .ok();
    router_in(authoriser, dir)
}

fn router_in<I, S>(authoriser: Authoriser<I>, dir: Option<PathBuf>) -> Router<S>
where
    I: Inventory + Clone + Send + Sync + 'static,
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/layout", get(read::<I>).put(replace::<I>))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .with_state(Layouts {
            authoriser,
            dir,
            lock: Arc::default(),
        })
}

async fn read<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Layouts<I>>,
) -> Response {
    let _held = state.lock.lock().await;
    let read = blocking(state.dir, |dir| layout::read_in(&dir)).await;
    match read {
        Ok(layout) => Json(layout).into_response(),
        Err(Error::Corrupt(reason)) => {
            tracing::warn!("the dashboard layout reads as the default: {reason}");
            Json(Layout::default()).into_response()
        }
        Err(error) => answer(error),
    }
}

async fn replace<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Layouts<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, Refused> {
    allowed(&state.authoriser, from.ip(), &headers).await?;
    let sent = match Layout::parse(&body) {
        Ok(sent) => sent,
        Err(error) => return Ok(answer(error)),
    };
    let _held = state.lock.lock().await;
    let saved = blocking(state.dir, move |dir| layout::replace_in(&dir, &sent)).await;
    Ok(match saved {
        Ok(saved) => {
            tracing::info!("the dashboard layout is at rev {}", saved.rev);
            Json(saved).into_response()
        }
        Err(error) => answer(error),
    })
}

async fn blocking<T: Send + 'static>(
    dir: Option<PathBuf>,
    run: impl FnOnce(PathBuf) -> Result<T, Error> + Send + 'static,
) -> Result<T, Error> {
    let dir = dir.ok_or(Error::NoConfigDir)?;
    tokio::task::spawn_blocking(move || run(dir))
        .await
        .unwrap_or_else(|joined| Err(Error::Unwritable(std::io::Error::other(joined))))
}

fn answer(error: Error) -> Response {
    match error {
        Error::Stale(current) => (StatusCode::CONFLICT, Json(*current)).into_response(),
        Error::Invalid(_) => (StatusCode::BAD_REQUEST, error.to_string()).into_response(),
        error => {
            let said = chain(&error);
            tracing::warn!("the dashboard layout: {said}");
            (StatusCode::INTERNAL_SERVER_ERROR, said).into_response()
        }
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Method, Request, header};
    use tower::ServiceExt as _;

    use crate::terminal::tests::{LOCAL, ME, caller, direct};

    fn scratch(label: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("yantrad-layout-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    async fn send(app: &Router, method: Method, body: Option<String>) -> (StatusCode, String) {
        let mut request = Request::builder()
            .method(method)
            .uri("/layout")
            .header(header::CONTENT_TYPE, "application/json")
            .body(body.map_or_else(Body::empty, Body::from))
            .expect("a request");
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from((LOCAL, 61620))));
        let response = app
            .clone()
            .oneshot(request)
            .await
            .expect("the router is infallible");
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .expect("the body is in memory");
        (status, String::from_utf8_lossy(&body).into_owned())
    }

    fn owner(dir: &std::path::Path) -> Router {
        router_in(direct(Some(caller(ME, &[]))), Some(dir.to_path_buf()))
    }

    fn parsed(body: &str) -> Layout {
        serde_json::from_str(body).expect("a layout")
    }

    fn at(rev: u64) -> String {
        serde_json::to_string(&Layout {
            rev,
            phone: Vec::new(),
            ..Layout::default()
        })
        .expect("json")
    }

    #[tokio::test]
    async fn a_read_with_no_file_is_the_default_at_rev_0() {
        let (status, body) = send(&owner(&scratch("get")), Method::GET, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(parsed(&body), Layout::default());
    }

    #[tokio::test]
    async fn a_write_at_the_read_rev_is_what_the_next_read_gets() {
        let app = owner(&scratch("round-trip"));
        let (status, body) = send(&app, Method::PUT, Some(at(0))).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let saved = parsed(&body);
        assert_eq!((saved.rev, saved.phone.len()), (1, 0));
        let (_, body) = send(&app, Method::GET, None).await;
        assert_eq!(parsed(&body), saved);
    }

    #[tokio::test]
    async fn a_stale_write_is_409_with_the_layout_on_disk() {
        let app = owner(&scratch("stale"));
        send(&app, Method::PUT, Some(at(0))).await;
        let mut other = Layout::default();
        other.desktop.truncate(1);
        let (status, body) = send(
            &app,
            Method::PUT,
            Some(serde_json::to_string(&other).expect("json")),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        let current = parsed(&body);
        assert_eq!((current.rev, current.phone.len()), (1, 0));
    }

    #[tokio::test]
    async fn a_bad_shape_is_400_and_writes_nothing() {
        let dir = scratch("bad");
        let app = owner(&dir);
        for bad in [
            at(0).replace("\"M\"", "\"XL\""),
            at(0).replace("\"v\":1", "\"v\":2"),
            "{".to_owned(),
            String::new(),
        ] {
            let (status, _) = send(&app, Method::PUT, Some(bad.clone())).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
        }
        assert!(!dir.exists(), "nothing was written");
    }

    #[tokio::test]
    async fn a_write_from_a_caller_who_is_not_the_owner_is_403() {
        let dir = scratch("refused");
        for refused in [
            Some(caller(ME + 1, &[])),
            Some(caller(ME, &["tag:ci"])),
            None,
        ] {
            let app = router_in(direct(refused), Some(dir.clone()));
            let (status, _) = send(&app, Method::PUT, Some(at(0))).await;
            assert_eq!(status, StatusCode::FORBIDDEN);
        }
        assert!(!dir.exists(), "nothing was written");
    }
}
