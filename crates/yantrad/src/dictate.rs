//! `GET /api/dictate` — the Chat composer's hold-to-talk, turned into text by
//! `yantra-stt` at `YANTRA_STT_URL` ([ADR-0043] §4).
//!
//! **Dictation is a write**, because it sends audio to a program, so
//! [`allowed`] is called before the upgrade. The workspace name is checked
//! there too, because it becomes a file name.
//!
//! **Binary frames are audio**, 16 kHz mono s16le, held in RAM up to
//! [`MAX_BYTES`]. The text frame `end` is the release: the audio and the
//! workspace's hotwords go to the service, and its text comes back as one text
//! frame, `{"text": "..."}`. Anything else is `{"error": kind, "said": reason}`
//! and a close. The buffer goes with the function on every path.
//!
//! **No audio, transcript or hotword is ever logged** (§7): the lifecycle is
//! logged, and the reason a request failed. `main.rs`'s `unlogged` keeps ureq
//! and tungstenite silent, because at TRACE they write every byte they carry.
//!
//! `GET /api/dictate/health` is §6's read, made by the daemon: the HTTPS page
//! cannot reach the service's plain-HTTP tailnet address itself.
//!
//! [ADR-0043]: ../../../docs/adr/0043-dictation-runs-a-local-speech-model.md

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::Response;
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use serde_json::json;
use tokio::time::MissedTickBehavior;
use yantra_core::inventory::Inventory;
use yantra_core::stt::{self, MAX_BYTES};
use yantra_core::workspace;

use crate::terminal::{MISSES, PING_EVERY};
use crate::write::{Authoriser, Peer, Refused, allowed, chain};

/// §6: a service that does not answer in two seconds is off.
const HEALTH_WITHIN: Duration = Duration::from_secs(2);

/// Sixty seconds of audio decodes in a few; this bounds a service that hangs.
const DECODE_WITHIN: Duration = Duration::from_secs(60);

/// The hotwords cost an ssh round trip; an utterance does not wait longer.
const WORDS_WITHIN: Duration = Duration::from_secs(5);

type Words = Pin<Box<dyn Future<Output = Vec<String>> + Send>>;

/// What builds the hotwords for a workspace and a thread: [`stt::for_workspace`], or a test's list.
type Hotwords = Arc<dyn Fn(Option<String>, Option<String>) -> Words + Send + Sync>;

#[derive(Clone)]
struct Dictate<I> {
    authoriser: Authoriser<I>,
    /// `YANTRA_STT_URL`, or `None` when it is unset or empty.
    service: Option<Arc<str>>,
    hotwords: Hotwords,
}

pub fn router<I, S>(authoriser: Authoriser<I>) -> Router<S>
where
    I: Inventory + Clone + Send + Sync + 'static,
    S: Clone + Send + Sync + 'static,
{
    let service = std::env::var("YANTRA_STT_URL").ok();
    router_with(
        authoriser,
        service,
        Arc::new(|workspace, thread| Box::pin(hotwords(workspace, thread))),
    )
}

fn router_with<I, S>(
    authoriser: Authoriser<I>,
    service: Option<String>,
    hotwords: Hotwords,
) -> Router<S>
where
    I: Inventory + Clone + Send + Sync + 'static,
    S: Clone + Send + Sync + 'static,
{
    let service = service
        .map(|url| url.trim().trim_end_matches('/').to_owned())
        .filter(|url| !url.is_empty())
        .map(Arc::from);
    Router::new()
        .route("/dictate", get(talk::<I>))
        .route("/dictate/health", get(health::<I>))
        .with_state(Dictate {
            authoriser,
            service,
            hotwords,
        })
}

/// A workspace that cannot be read gives no hotwords, and the utterance is still heard.
async fn hotwords(workspace: Option<String>, thread: Option<String>) -> Vec<String> {
    let Some(name) = workspace else {
        return Vec::new();
    };
    match stt::for_workspace(&name, thread.as_deref()).await {
        Ok(words) => words,
        Err(error) => {
            tracing::warn!("dictate found no hotwords in {name}: {}", chain(&error));
            Vec::new()
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Reach {
    Off,
    Unreachable,
    Ready,
}

#[derive(Serialize)]
struct Health {
    state: Reach,
}

async fn health<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Dictate<I>>,
) -> Json<Health> {
    let state = match state.service {
        None => Reach::Off,
        Some(url) => {
            let asked = tokio::task::spawn_blocking(move || {
                agent(HEALTH_WITHIN)
                    .get(format!("{url}/health"))
                    .call()
                    .is_ok_and(|answer| answer.status().is_success())
            });
            if asked.await.unwrap_or(false) {
                Reach::Ready
            } else {
                Reach::Unreachable
            }
        }
    };
    Json(Health { state })
}

fn agent(within: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(within))
        .http_status_as_error(false)
        .user_agent("yantrad")
        .build()
        .into()
}

#[derive(Debug, Default, PartialEq, Eq)]
struct Asked {
    workspace: Option<String>,
    thread: Option<String>,
}

fn read_query(uri: &Uri) -> Asked {
    let mut asked = Asked::default();
    for pair in uri.query().unwrap_or_default().split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        let value = crate::chat::decoded(value).filter(|value| !value.is_empty());
        match key {
            "workspace" => asked.workspace = value,
            "thread" => asked.thread = value,
            _ => {}
        }
    }
    asked
}

async fn talk<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Dictate<I>>,
    ConnectInfo(from): ConnectInfo<Peer>,
    headers: HeaderMap,
    uri: Uri,
    upgrade: WebSocketUpgrade,
) -> Result<Response, Refused> {
    let caller = allowed(&state.authoriser, &from, &headers).await?;
    let asked = read_query(&uri);
    if let Some(name) = &asked.workspace
        && !workspace::usable_name(name)
    {
        return Err(Refused::Verb {
            status: StatusCode::BAD_REQUEST,
            said: format!("`{name}` is not a workspace name"),
        });
    }
    let who = caller.node;
    tracing::info!("dictate for {who} started");

    Ok(upgrade.on_upgrade(move |mut socket| async move {
        // Asked at once, so the ssh round trip runs while the person speaks.
        let words = Lookup(tokio::spawn((state.hotwords)(
            asked.workspace,
            asked.thread,
        )));
        let said = match listen(&mut socket, state.service, words).await {
            Ok(None) => {
                tracing::info!("dictate for {who} ended");
                return;
            }
            Ok(Some(text)) => {
                tracing::info!("dictate for {who} ended");
                json!({ "text": text })
            }
            Err(failed) => {
                tracing::warn!("dictate for {who} failed: {}", failed.said);
                json!({ "error": failed.kind, "said": failed.said })
            }
        };
        let _ = socket.send(Message::Text(said.to_string().into())).await;
        crate::mic::close(&mut socket).await;
    }))
}

/// Why an utterance gave no text: the kinds the composer tells apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Kind {
    Off,
    Unreachable,
    TooLong,
    Silent,
    Failed,
}

#[derive(Debug)]
struct Failed {
    kind: Kind,
    said: String,
}

impl Failed {
    fn new(kind: Kind, said: impl Into<String>) -> Self {
        Self {
            kind,
            said: said.into(),
        }
    }
}

enum Heard {
    Socket(Option<Result<Message, axum::Error>>),
    Quiet,
}

/// The hotword lookup, stopped when the utterance ends without needing it.
struct Lookup(tokio::task::JoinHandle<Vec<String>>);

impl Drop for Lookup {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// The utterance's text; `None` when the person left before `end`.
async fn listen(
    socket: &mut WebSocket,
    service: Option<Arc<str>>,
    mut words: Lookup,
) -> Result<Option<String>, Failed> {
    let mut audio = Vec::new();
    let mut unanswered = 0u8;
    let mut pings = tokio::time::interval(PING_EVERY);
    pings.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        let heard = tokio::select! {
            message = socket.recv() => Heard::Socket(message),
            _ = pings.tick() => Heard::Quiet,
        };
        match heard {
            Heard::Socket(Some(Ok(Message::Binary(frame)))) => {
                if audio.len() + frame.len() > MAX_BYTES {
                    return Err(Failed::new(
                        Kind::TooLong,
                        "the clip is longer than 60 seconds",
                    ));
                }
                audio.extend_from_slice(&frame);
            }
            Heard::Socket(Some(Ok(Message::Text(text)))) if text.as_str() == "end" => break,
            Heard::Socket(Some(Ok(Message::Pong(_)))) => unanswered = 0,
            Heard::Socket(None | Some(Err(_) | Ok(Message::Close(_)))) => {
                return Ok(None);
            }
            Heard::Socket(Some(Ok(_))) => {}
            Heard::Quiet => {
                if unanswered >= MISSES {
                    return Ok(None);
                }
                unanswered += 1;
                if socket.send(Message::Ping(Bytes::new())).await.is_err() {
                    return Ok(None);
                }
            }
        }
    }

    let Some(service) = service else {
        return Err(Failed::new(
            Kind::Off,
            "YANTRA_STT_URL is not set on the daemon",
        ));
    };
    if audio.is_empty() {
        return Err(Failed::new(
            Kind::Silent,
            "no audio arrived before the release",
        ));
    }
    let words = tokio::time::timeout(WORDS_WITHIN, &mut words.0)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();
    let text = tokio::task::spawn_blocking(move || transcribe(&service, &audio, &words))
        .await
        .map_err(|_| Failed::new(Kind::Failed, "the request to the service did not finish"))??;
    if text.trim().is_empty() {
        return Err(Failed::new(Kind::Silent, "the service heard no words"));
    }
    Ok(Some(text))
}

/// One `POST /transcribe`. Its error names the status and never the URL,
/// whose query holds the hotwords.
fn transcribe(service: &str, audio: &[u8], words: &[String]) -> Result<String, Failed> {
    let answer = agent(DECODE_WITHIN)
        .post(format!("{service}/transcribe"))
        .query("hotwords", words.join("\n"))
        .content_type("application/octet-stream")
        .send(audio);
    let mut answer = match answer {
        Ok(answer) => answer,
        Err(ureq::Error::Timeout(_)) => {
            return Err(Failed::new(
                Kind::Unreachable,
                "the service did not answer in time",
            ));
        }
        Err(_) => {
            return Err(Failed::new(
                Kind::Unreachable,
                "the service could not be reached",
            ));
        }
    };
    let status = answer.status();
    let body = answer.body_mut().read_to_string().unwrap_or_default();
    if !status.is_success() {
        let said: String = body.chars().take(200).collect();
        return Err(Failed::new(
            Kind::Failed,
            format!("the service answered {status}: {said}"),
        ));
    }
    serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|heard| heard.get("text")?.as_str().map(str::to_owned))
        .ok_or_else(|| Failed::new(Kind::Failed, "the service answered without a text"))
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use axum::extract::RawQuery;
    use axum::routing::post;
    use std::sync::Mutex;
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::time::timeout;
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    use crate::terminal::tests::{
        BINARY, Capture, LOCAL, ME, PING, TEXT, caller, connect_to, direct, frame, pong, send,
    };

    const CLOSE: u8 = 0x8;
    const DICTATE: &str = "/api/dictate?workspace=site&thread=t1";

    /// What the fake service was sent: the body and the raw query.
    type Sent = Arc<Mutex<Vec<(Vec<u8>, String)>>>;

    /// A `yantra-stt` on a local port that answers `status` and `body`.
    async fn service(status: StatusCode, body: &'static str) -> (String, Sent) {
        let sent = Sent::default();
        let record = Arc::clone(&sent);
        let app = Router::new()
            .route(
                "/transcribe",
                post(move |RawQuery(query): RawQuery, audio: Bytes| {
                    let record = Arc::clone(&record);
                    async move {
                        record
                            .lock()
                            .expect("the record")
                            .push((audio.to_vec(), query.unwrap_or_default()));
                        (status, body)
                    }
                }),
            )
            .route("/health", get(|| async { StatusCode::OK }));
        let listener = TcpListener::bind((LOCAL, 0)).await.expect("a free port");
        let address = listener.local_addr().expect("it is bound");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{address}/"), sent)
    }

    fn words(list: &'static [&'static str]) -> Hotwords {
        Arc::new(move |_, _| {
            Box::pin(async move { list.iter().map(|&word| word.to_owned()).collect() })
        })
    }

    fn api(service: Option<String>, hotwords: Hotwords) -> Router {
        router_with(direct(Some(caller(ME, &[]))), service, hotwords)
    }

    async fn upgraded(api: Router, path: &str) -> BufReader<TcpStream> {
        let mut socket = connect_to(api, path, "").await;
        let mut line = String::new();
        loop {
            line.clear();
            let read = socket.read_line(&mut line).await.expect("a header");
            assert!(read > 0, "the response ended before its headers did");
            assert!(!line.starts_with("HTTP/1.1 4"), "{line}");
            if line == "\r\n" {
                return socket;
            }
        }
    }

    async fn status(api: Router, path: &str) -> String {
        let mut line = String::new();
        connect_to(api, path, "")
            .await
            .read_line(&mut line)
            .await
            .expect("an HTTP response");
        line
    }

    /// The text frames the daemon sends until its close, answering its pings.
    async fn said(socket: &mut BufReader<TcpStream>) -> Vec<serde_json::Value> {
        let mut seen = Vec::new();
        loop {
            let (opcode, payload) = timeout(Duration::from_secs(30), frame(socket))
                .await
                .expect("the daemon ends the socket")
                .expect("a frame");
            match opcode {
                PING => pong(socket).await,
                CLOSE => return seen,
                _ => {
                    assert_eq!(opcode, TEXT, "a text frame");
                    seen.push(serde_json::from_slice(&payload).expect("JSON"));
                }
            }
        }
    }

    async fn speak(api: Router, frames: &[&[u8]]) -> Vec<serde_json::Value> {
        let mut socket = upgraded(api, DICTATE).await;
        for audio in frames {
            send(&mut socket, BINARY, audio).await;
        }
        send(&mut socket, TEXT, b"end").await;
        said(&mut socket).await
    }

    #[tokio::test]
    async fn the_audio_and_the_hotwords_reach_the_service_and_its_text_comes_back() {
        let (url, sent) = service(StatusCode::OK, r#"{"text":"use tokio"}"#).await;
        let seen = speak(
            api(Some(url), words(&["tokio", "ControlPersist"])),
            &[&[1, 0, 2, 0], &[3, 0]],
        )
        .await;
        assert_eq!(seen, [serde_json::json!({"text": "use tokio"})]);
        let sent = sent.lock().expect("the record");
        assert_eq!(sent[0].0, [1, 0, 2, 0, 3, 0]);
        assert_eq!(sent[0].1, "hotwords=tokio%0AControlPersist");
    }

    fn error(seen: &[serde_json::Value]) -> (&str, &str) {
        assert_eq!(seen.len(), 1, "{seen:?}");
        (
            seen[0]["error"].as_str().expect("a kind"),
            seen[0]["said"].as_str().expect("a reason"),
        )
    }

    #[tokio::test]
    async fn each_failure_is_one_reason_and_a_close() {
        let (url, _) = service(StatusCode::OK, r#"{"text":"  "}"#).await;
        assert_eq!(
            error(&speak(api(Some(url.clone()), words(&[])), &[&[0, 0]]).await).0,
            "silent"
        );
        assert_eq!(
            error(&speak(api(Some(url), words(&[])), &[]).await).0,
            "silent"
        );

        assert_eq!(
            error(&speak(api(None, words(&[])), &[&[0, 0]]).await).0,
            "off"
        );

        let (url, _) = service(
            StatusCode::INTERNAL_SERVER_ERROR,
            "the model did not decode the audio",
        )
        .await;
        let seen = speak(api(Some(url), words(&[])), &[&[0, 0]]).await;
        let (kind, said) = error(&seen);
        assert_eq!(kind, "failed");
        assert!(
            said.contains("500") && said.contains("did not decode"),
            "{said}"
        );

        // Nothing listens on port 9 of this machine.
        let seen = speak(
            api(Some("http://127.0.0.1:9".into()), words(&[])),
            &[&[0, 0]],
        )
        .await;
        assert_eq!(error(&seen).0, "unreachable");
    }

    #[tokio::test]
    async fn a_clip_over_sixty_seconds_is_refused_and_never_sent() {
        let (url, sent) = service(StatusCode::OK, r#"{"text":"never"}"#).await;
        let mut socket = upgraded(api(Some(url), words(&[])), DICTATE).await;
        let chunk = [0u8; 125];
        for _ in 0..=MAX_BYTES / chunk.len() {
            send(&mut socket, BINARY, &chunk).await;
        }
        let seen = said(&mut socket).await;
        assert_eq!(error(&seen).0, "too-long");
        assert!(sent.lock().expect("the record").is_empty());
    }

    #[tokio::test]
    async fn a_caller_who_is_not_the_owner_or_a_bad_name_is_not_upgraded() {
        let refused = router_with(direct(Some(caller(ME + 1, &[]))), None, words(&[]));
        assert!(status(refused, DICTATE).await.starts_with("HTTP/1.1 403"));
        let stranger = router_with(direct(None), None, words(&[]));
        assert!(status(stranger, DICTATE).await.starts_with("HTTP/1.1 403"));
        let said = status(api(None, words(&[])), "/api/dictate?workspace=..%2Fetc").await;
        assert!(said.starts_with("HTTP/1.1 400"), "{said}");
        let owner = status(api(None, words(&[])), DICTATE).await;
        assert!(owner.starts_with("HTTP/1.1 101"), "{owner}");
    }

    #[tokio::test]
    async fn health_is_off_unreachable_or_ready() {
        use tower::ServiceExt;
        async fn asked(service: Option<String>) -> serde_json::Value {
            let response = api(service, words(&[]))
                .oneshot(
                    axum::http::Request::get("/dictate/health")
                        .body(axum::body::Body::empty())
                        .expect("a request"),
                )
                .await
                .expect("an answer");
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("a body");
            serde_json::from_slice(&body).expect("JSON")
        }
        assert_eq!(asked(None).await["state"], "off");
        assert_eq!(asked(Some("  ".into())).await["state"], "off");
        assert_eq!(
            asked(Some("http://127.0.0.1:9".into())).await["state"],
            "unreachable"
        );
        let (url, _) = service(StatusCode::OK, "").await;
        assert_eq!(asked(Some(url)).await["state"], "ready");
    }

    #[test]
    fn the_workspace_and_the_thread_are_read_from_the_query() {
        let uri: Uri = "/api/dictate?workspace=site&thread=a%2Fb&x=1"
            .parse()
            .expect("a URI");
        assert_eq!(
            read_query(&uri),
            Asked {
                workspace: Some("site".into()),
                thread: Some("a/b".into()),
            }
        );
        assert_eq!(
            read_query(&"/api/dictate".parse().expect("a URI")),
            Asked::default()
        );
    }

    /// The row's outcome on the real fleet: a clip goes through `/api/dictate`
    /// to the running `yantra-stt`, with the hotwords [`hotwords`] builds over
    /// ssh from a real workspace. `YANTRA_STT_CLIP` is raw 16 kHz mono s16le.
    #[tokio::test]
    #[ignore = "needs yantra-stt; set YANTRA_STT_URL, YANTRA_STT_CLIP and YANTRA_STT_WORKSPACE"]
    async fn a_real_clip_comes_back_as_text_through_the_route() {
        let url = std::env::var("YANTRA_STT_URL").expect("YANTRA_STT_URL");
        let clip = std::fs::read(std::env::var("YANTRA_STT_CLIP").expect("YANTRA_STT_CLIP"))
            .expect("the clip");
        let workspace = std::env::var("YANTRA_STT_WORKSPACE").expect("YANTRA_STT_WORKSPACE");

        let words = hotwords(Some(workspace.clone()), None).await;
        println!("{} hotwords: {words:?}", words.len());
        assert!(!words.is_empty(), "{workspace} gave no hotwords");

        let api = api(
            Some(url),
            Arc::new(|workspace, thread| Box::pin(hotwords(workspace, thread))),
        );
        let mut socket = upgraded(api, &format!("/api/dictate?workspace={workspace}")).await;
        for chunk in clip.chunks(124) {
            send(&mut socket, BINARY, chunk).await;
        }
        send(&mut socket, TEXT, b"end").await;
        let seen = said(&mut socket).await;
        println!("{seen:?}");
        let text = seen[0]["text"].as_str().expect("a text, not an error");
        assert!(!text.trim().is_empty());
    }

    /// **§7.** The lifecycle is logged; the audio, the text and the hotwords never are.
    #[tokio::test]
    async fn dictation_logs_its_lifecycle_and_never_its_audio_text_or_hotwords() {
        let capture = Capture::default();
        let writer = capture.clone();
        // Global, with `log` bridged, because ureq logs from the blocking thread.
        tracing_subscriber::fmt()
            .with_ansi(false)
            .with_max_level(tracing::Level::TRACE)
            .with_writer(move || writer.clone())
            .finish()
            .with(crate::unlogged())
            .try_init()
            .expect("no other subscriber in this process");

        let (url, sent) = service(StatusCode::OK, r#"{"text":"marker-of-the-text"}"#).await;
        let seen = speak(
            api(Some(url), words(&["markerHotword"])),
            &[b"marker-of-the-audio"],
        )
        .await;
        assert_eq!(seen, [serde_json::json!({"text": "marker-of-the-text"})]);
        assert_eq!(
            sent.lock().expect("the record")[0].0,
            b"marker-of-the-audio"
        );
        // The control: the capture sees a thread that is not this test's.
        tokio::task::spawn_blocking(|| tracing::trace!("a blocking thread logged"))
            .await
            .expect("the thread ran");
        for _ in 0..50 {
            if String::from_utf8_lossy(&capture.0.lock().expect("the log")).contains("ended") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        let logged = String::from_utf8_lossy(&capture.0.lock().expect("the log")).into_owned();
        assert!(
            logged.contains("dictate for nSOME000000011CNTRL started"),
            "{logged}"
        );
        assert!(
            logged.contains("dictate for nSOME000000011CNTRL ended"),
            "{logged}"
        );
        assert!(logged.contains("a blocking thread logged"), "{logged}");
        for marker in [
            "marker-of-the-audio",
            "marker-of-the-text",
            "markerHotword",
            "19 bytes",
            "content-length",
        ] {
            assert!(!logged.contains(marker), "{marker} was logged: {logged}");
        }
    }
}
