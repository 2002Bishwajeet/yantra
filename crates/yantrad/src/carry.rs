//! `POST /api/carry` and `POST /api/carry/{id}`: the browser keys a page on
//! `:7717` hands to itself on the HTTPS origin (Y-652).
//!
//! The two origins share no storage, and a URL fragment would put a draft in
//! the browser's history. So the old page leaves the keys here and the new page
//! takes them once. **In memory only**, and never logged: a draft is the
//! owner's words, so no body reaches a trace (Q5).

use std::collections::{BTreeMap, VecDeque};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use tokio::sync::Mutex;
use tokio::time::Instant;
use yantra_core::inventory::Inventory;

use crate::write::{Authoriser, Refused, allowed};

/// A draft is kilobytes; this refuses a flood.
const BODY_LIMIT: usize = 1024 * 1024;
/// The move takes a second; a slot nobody took in this time never will be.
const LIVES: Duration = Duration::from_secs(5 * 60);
/// Eight slots of 1 MiB bound what a stranger to the move can make it hold.
const HELD: usize = 8;

pub type Kept = BTreeMap<String, String>;

/// The slots, oldest first.
pub type Slots = Arc<Mutex<VecDeque<Slot>>>;

#[derive(Debug)]
pub struct Slot {
    id: String,
    made: Instant,
    kept: Kept,
}

#[derive(Clone)]
struct Carrier<I> {
    authoriser: Authoriser<I>,
    slots: Slots,
}

pub fn router<I, S>(authoriser: Authoriser<I>, slots: Slots) -> Router<S>
where
    I: Inventory + Clone + Send + Sync + 'static,
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/carry", post(keep::<I>))
        .route("/carry/{id}", post(take::<I>))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .with_state(Carrier { authoriser, slots })
}

#[derive(Debug, serde::Serialize)]
pub(crate) struct Carried {
    id: String,
}

#[derive(Debug, serde::Serialize)]
struct Failed {
    error: &'static str,
}

fn failed(status: StatusCode, error: &'static str) -> Response {
    (status, Json(Failed { error })).into_response()
}

async fn keep<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Carrier<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, Refused> {
    allowed(&state.authoriser, from.ip(), &headers).await?;
    // The serde error quotes the body, so it is not passed on.
    let Ok(kept) = serde_json::from_slice::<Kept>(&body) else {
        return Ok(failed(
            StatusCode::BAD_REQUEST,
            "the body is not an object of strings",
        ));
    };
    let Some(id) = yantra_core::room::session_id() else {
        return Ok(failed(
            StatusCode::INTERNAL_SERVER_ERROR,
            "this machine has no entropy for an id",
        ));
    };
    let mut slots = state.slots.lock().await;
    let now = Instant::now();
    slots.retain(|slot| now.duration_since(slot.made) < LIVES);
    while slots.len() >= HELD {
        slots.pop_front();
    }
    slots.push_back(Slot {
        id: id.clone(),
        made: now,
        kept,
    });
    Ok(Json(Carried { id }).into_response())
}

async fn take<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Carrier<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Refused> {
    allowed(&state.authoriser, from.ip(), &headers).await?;
    let mut slots = state.slots.lock().await;
    let at = slots.iter().position(|slot| slot.id == id);
    let slot = at.and_then(|at| slots.remove(at));
    Ok(match slot {
        Some(slot) if slot.made.elapsed() < LIVES => Json(slot.kept).into_response(),
        _ => failed(StatusCode::NOT_FOUND, "nothing is carried under that id"),
    })
}

#[cfg(test)]
pub(crate) fn answers() -> Vec<(&'static str, &'static str, serde_json::Value)> {
    vec![
        (
            "carried",
            "Carried",
            serde_json::json!(Carried {
                id: "0123456789abcdef0123456789abcdef".to_owned(),
            }),
        ),
        (
            "carriedKeys",
            "Record<string, string>",
            serde_json::json!(Kept::from([(
                "yantra.chat.draft.site".to_owned(),
                "a draft".to_owned(),
            )])),
        ),
    ]
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, header};
    use serde_json::{Value, json};
    use tower::ServiceExt as _;

    use crate::terminal::tests::{LOCAL, ME, caller, direct};

    fn owner(slots: &Slots) -> Router {
        router(direct(Some(caller(ME, &[]))), slots.clone())
    }

    async fn post(app: &Router, uri: &str, body: impl Into<Body>) -> (StatusCode, Value) {
        let mut request = Request::post(uri)
            .header(header::CONTENT_TYPE, "application/json")
            .body(body.into())
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
        let body = axum::body::to_bytes(response.into_body(), 2 << 20)
            .await
            .expect("the body is in memory");
        (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
    }

    async fn keep(app: &Router, kept: Value) -> String {
        let (status, body) = post(app, "/carry", kept.to_string()).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["id"].as_str().expect("an id").to_owned()
    }

    fn draft() -> Value {
        json!({"yantra.chat.draft.site": "half a thought"})
    }

    #[tokio::test]
    async fn a_slot_is_taken_once_and_then_is_404() {
        let app = owner(&Slots::default());
        let id = keep(&app, draft()).await;
        assert_eq!(id.len(), 32, "128 bits in hex");
        assert!(id.bytes().all(|b| b.is_ascii_hexdigit()), "{id}");

        let (status, body) = post(&app, &format!("/carry/{id}"), Body::empty()).await;
        assert_eq!((status, body), (StatusCode::OK, draft()));

        let (status, body) = post(&app, &format!("/carry/{id}"), Body::empty()).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(body["error"].is_string(), "{body}");
    }

    #[tokio::test(start_paused = true)]
    async fn an_expired_slot_is_404() {
        let app = owner(&Slots::default());
        let id = keep(&app, draft()).await;
        tokio::time::advance(LIVES).await;
        let (status, body) = post(&app, &format!("/carry/{id}"), Body::empty()).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(body["error"].is_string(), "{body}");
    }

    #[tokio::test]
    async fn the_ninth_slot_evicts_the_oldest() {
        let slots = Slots::default();
        let app = owner(&slots);
        let mut ids = Vec::new();
        for _ in 0..=HELD {
            ids.push(keep(&app, draft()).await);
        }
        assert_eq!(slots.lock().await.len(), HELD);
        let (status, _) = post(&app, &format!("/carry/{}", ids[0]), Body::empty()).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "the oldest went");
        let (status, _) = post(&app, &format!("/carry/{}", ids[1]), Body::empty()).await;
        assert_eq!(status, StatusCode::OK, "the next one stayed");
    }

    #[tokio::test]
    async fn a_body_over_1_mib_is_413() {
        let slots = Slots::default();
        let big = json!({"yantra.chat.draft.site": "x".repeat(BODY_LIMIT)});
        let (status, _) = post(&owner(&slots), "/carry", big.to_string()).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert!(slots.lock().await.is_empty());
    }

    #[tokio::test]
    async fn a_value_that_is_not_a_string_is_400() {
        let slots = Slots::default();
        let app = owner(&slots);
        for bad in [
            json!({"yantra.prefs": 1}),
            json!({"yantra.prefs": {"theme": "dark"}}),
            json!(["yantra.prefs"]),
            json!("yantra.prefs"),
        ] {
            let (status, body) = post(&app, "/carry", bad.to_string()).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
            assert!(body["error"].is_string(), "{body}");
        }
        assert!(slots.lock().await.is_empty());
    }

    #[tokio::test]
    async fn a_caller_who_is_not_the_owner_is_403_both_ways() {
        let slots = Slots::default();
        let id = keep(&owner(&slots), draft()).await;
        let stranger = router(direct(Some(caller(ME + 1, &[]))), slots.clone());
        let (status, _) = post(&stranger, "/carry", draft().to_string()).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = post(&stranger, &format!("/carry/{id}"), Body::empty()).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(
            slots.lock().await.len(),
            1,
            "a refused take leaves the slot"
        );
    }
}
