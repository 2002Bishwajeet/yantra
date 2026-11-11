//! `POST /transcribe` and `GET /health` ([ADR-0043] §2).
//!
//! The body is raw 16 kHz mono s16le PCM, and `?hotwords=` holds the hotword
//! list, one per line. The answer is `{"text": "..."}`. Nothing is kept, and
//! no sample, transcript or hotword is logged (§7).
//!
//! [ADR-0043]: ../../../docs/adr/0043-dictation-runs-a-local-speech-model.md

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use yantra_core::stt::MAX_BYTES;

/// The model, or a test's stand-in for it.
pub trait Recognise: Send + Sync + 'static {
    /// One utterance's text: 16 kHz mono samples in [-1, 1], and the hotwords
    /// one per line. `None` is a decode that failed.
    fn transcribe(&self, samples: &[f32], hotwords: &str) -> Option<String>;
}

struct Service<R> {
    recogniser: Arc<R>,
    /// One decode at a time: each already uses every thread it was given.
    turn: Mutex<()>,
}

#[derive(Deserialize)]
struct Asked {
    #[serde(default)]
    hotwords: String,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(Deserialize, PartialEq, Eq))]
pub struct Heard {
    pub text: String,
}

type Refused = (StatusCode, &'static str);

pub fn router<R: Recognise>(recogniser: Arc<R>) -> Router {
    Router::new()
        .route("/transcribe", post(transcribe::<R>))
        .route("/health", get(|| async { StatusCode::OK }))
        .layer(DefaultBodyLimit::max(MAX_BYTES))
        .with_state(Arc::new(Service {
            recogniser,
            turn: Mutex::new(()),
        }))
}

async fn transcribe<R: Recognise>(
    State(service): State<Arc<Service<R>>>,
    Query(asked): Query<Asked>,
    audio: Bytes,
) -> Result<Json<Heard>, Refused> {
    if !audio.len().is_multiple_of(2) {
        return Err((StatusCode::BAD_REQUEST, "the body is not s16le samples"));
    }
    // sherpa-onnx's C string cannot hold one, and its wrapper panics on it.
    if asked.hotwords.contains('\0') {
        return Err((StatusCode::BAD_REQUEST, "a hotword holds a NUL"));
    }
    if audio.is_empty() {
        return Ok(Json(Heard {
            text: String::new(),
        }));
    }
    let samples: Vec<f32> = audio
        .chunks_exact(2)
        .map(|pair| f32::from(i16::from_le_bytes([pair[0], pair[1]])) / 32768.0)
        .collect();

    let _turn = service.turn.lock().await;
    let recogniser = Arc::clone(&service.recogniser);
    let text =
        tokio::task::spawn_blocking(move || recogniser.transcribe(&samples, &asked.hotwords))
            .await
            .ok()
            .flatten();
    match text {
        Some(text) => Ok(Json(Heard {
            text: text.trim().to_owned(),
        })),
        None => {
            tracing::warn!("a decode failed");
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                "the model did not decode the audio",
            ))
        }
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use std::sync::Mutex as Plain;
    use tower::ServiceExt;

    /// Records what the model was given, and answers `said`.
    #[derive(Default)]
    struct Fake {
        heard: Plain<Vec<(Vec<f32>, String)>>,
        said: Option<String>,
    }

    impl Recognise for Fake {
        fn transcribe(&self, samples: &[f32], hotwords: &str) -> Option<String> {
            self.heard
                .lock()
                .expect("the record")
                .push((samples.to_vec(), hotwords.to_owned()));
            self.said.clone()
        }
    }

    fn saying(said: Option<&str>) -> Arc<Fake> {
        Arc::new(Fake {
            said: said.map(str::to_owned),
            ..Fake::default()
        })
    }

    async fn post(fake: &Arc<Fake>, query: &str, body: Vec<u8>) -> (StatusCode, Vec<u8>) {
        let response = router(Arc::clone(fake))
            .oneshot(
                Request::post(format!("/transcribe{query}"))
                    .body(Body::from(body))
                    .expect("a request"),
            )
            .await
            .expect("an answer");
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("a body");
        (status, body.to_vec())
    }

    #[tokio::test]
    async fn the_samples_and_the_hotwords_reach_the_model_and_its_text_comes_back() {
        let fake = saying(Some(" use tokio here \n"));
        let pcm: Vec<u8> = [0i16, 16384, -32768]
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect();
        let (status, body) = post(&fake, "?hotwords=tokio%0AControlPersist", pcm).await;
        assert_eq!(status, StatusCode::OK);
        let heard: Heard = serde_json::from_slice(&body).expect("JSON");
        assert_eq!(heard.text, "use tokio here");
        let given = fake.heard.lock().expect("the record");
        assert_eq!(given[0].0, [0.0, 0.5, -1.0]);
        assert_eq!(given[0].1, "tokio\nControlPersist");
    }

    #[tokio::test]
    async fn no_hotwords_is_an_empty_list_and_no_audio_is_no_text() {
        let fake = saying(Some("hello"));
        let (status, _) = post(&fake, "", vec![0, 0]).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(fake.heard.lock().expect("the record")[0].1, "");

        let (status, body) = post(&fake, "", Vec::new()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, br#"{"text":""}"#);
        assert_eq!(fake.heard.lock().expect("the record").len(), 1);
    }

    #[tokio::test]
    async fn an_odd_body_a_nul_and_a_failed_decode_are_refused() {
        let fake = saying(None);
        assert_eq!(
            post(&fake, "", vec![1, 2, 3]).await.0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            post(&fake, "?hotwords=a%00b", vec![0, 0]).await.0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            post(&fake, "", vec![0, 0]).await.0,
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    #[tokio::test]
    async fn a_clip_over_sixty_seconds_is_refused_before_the_model() {
        let fake = saying(Some("never"));
        let (status, _) = post(&fake, "", vec![0; MAX_BYTES + 2]).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert!(fake.heard.lock().expect("the record").is_empty());
        let (status, _) = post(&fake, "", vec![0; MAX_BYTES]).await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn health_answers_ok() {
        let response = router(saying(None))
            .oneshot(
                Request::get("/health")
                    .body(Body::empty())
                    .expect("a request"),
            )
            .await
            .expect("an answer");
        assert_eq!(response.status(), StatusCode::OK);
    }
}
