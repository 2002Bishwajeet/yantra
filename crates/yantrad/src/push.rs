//! Web Push to the installed dashboard ([ADR-0047]).
//!
//! The daemon signs each push with one key (VAPID, RFC 8292) and encrypts the
//! text for one device (RFC 8291, `aes128gcm`), so the push service reads no
//! word of it. The key is in `/etc/yantra/daemon.env` beside the relay, and
//! the devices are rows in the thread store.
//!
//! **No published Web Push crate passes `cargo deny`.** `web-push-native`,
//! `jmap-web-push` and `web-push` build on `p256` 0.13, whose `crypto-bigint`
//! has RUSTSEC-2026-0387, or on OpenSSL. So the two RFCs are composed here
//! from the RustCrypto crates `webauthn-rs` already brings, and RFC 8291's
//! own example is the proof.
//!
//! The four routes have no CLI verb, as `POST /api/viewing` has none: a
//! browser makes a subscription for itself, and a terminal has none to give.
//!
//! [ADR-0047]: ../../../docs/adr/0047-the-dashboard-gets-web-push.md

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes128Gcm, Key as AesKey, Nonce};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hkdf::Hkdf;
use p256::ecdsa::signature::Signer as _;
use p256::ecdsa::{Signature, SigningKey};
use p256::elliptic_curve::sec1::ToSec1Point as _;
use p256::{PublicKey, SecretKey};
use sha2::Sha256;
use yantra_core::inventory::Inventory;
use yantra_core::notify::{self, Message};

use crate::store::{Device, Store};
use crate::write::{Authoriser, Peer, Refused, allowed, chain};

/// How long a push service keeps a push for a device that is offline, and how
/// long one signature lives. RFC 8292 allows a signature 24 hours.
const KEPT: Duration = Duration::from_secs(12 * 60 * 60);

/// One send to one push service, as the relay's send is bounded.
const TIMEOUT: Duration = Duration::from_secs(3);

/// The most devices the store keeps, so one look's sends stay in its budget.
pub(crate) const DEVICES: usize = 16;

/// The longest endpoint the daemon keeps, in bytes.
pub(crate) const ENDPOINT_MAX: usize = 2048;

/// RFC 8188's record size, as RFC 8291's example has it. One record holds the
/// text, its one delimiter byte and the 16-byte tag.
const RECORD: u32 = 4096;
const TEXT_MAX: usize = RECORD as usize - 17;

/// RFC 8292's `sub`: a contact for the sender. It names the project and never
/// the owner or the tailnet, because every push service reads it.
const CONTACT: &str = env!("CARGO_PKG_REPOSITORY");

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("the kernel gave no random bytes")]
    Random,

    #[error("the signing key could not be kept")]
    NotKept(#[from] notify::NotWritten),

    #[error(transparent)]
    Store(#[from] crate::store::Error),
}

/// The signing key. `Debug` prints neither half.
struct Key {
    signing: SigningKey,
    /// The public point, uncompressed, in URL-safe base64: what a browser
    /// takes as `applicationServerKey`.
    public: String,
}

impl Key {
    fn of(secret: &[u8]) -> Option<Self> {
        let signing = SigningKey::from_slice(secret).ok()?;
        let public = URL_SAFE_NO_PAD.encode(signing.verifying_key().to_sec1_point(false));
        Some(Self { signing, public })
    }

    fn parse(text: &str) -> Option<Self> {
        Self::of(&URL_SAFE_NO_PAD.decode(text).ok()?)
    }

    /// A new key and its 32 bytes in URL-safe base64, for the file.
    fn generate() -> Result<(Self, String), Error> {
        let (_, secret) = scalar()?;
        let key = Self::of(&secret).ok_or(Error::Random)?;
        Ok((key, URL_SAFE_NO_PAD.encode(secret)))
    }

    /// RFC 8292's `Authorization` value for a push to `endpoint`.
    fn authorization(&self, endpoint: &str, now: u64) -> Option<String> {
        let uri: Uri = endpoint.parse().ok()?;
        let audience = format!("{}://{}", uri.scheme_str()?, uri.authority()?);
        let claims = serde_json::json!({
            "aud": audience,
            "exp": now + KEPT.as_secs(),
            "sub": CONTACT,
        });
        let signed = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(br#"{"typ":"JWT","alg":"ES256"}"#),
            URL_SAFE_NO_PAD.encode(claims.to_string()),
        );
        let signature: Signature = self.signing.sign(signed.as_bytes());
        Some(format!(
            "vapid t={signed}.{}, k={}",
            URL_SAFE_NO_PAD.encode(signature.to_bytes()),
            self.public
        ))
    }
}

/// 32 random bytes that are a P-256 scalar. A draw outside the field has a
/// chance near 2^-32, so a second draw is enough.
fn scalar() -> Result<(SecretKey, [u8; 32]), Error> {
    for _ in 0..2 {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|_| Error::Random)?;
        if let Ok(secret) = SecretKey::from_slice(&bytes) {
            return Ok((secret, bytes));
        }
    }
    Err(Error::Random)
}

/// A subscription whose three fields are checked: an `https` endpoint, a
/// P-256 point and a 16-byte secret.
fn checked(endpoint: &str, p256dh: &str, auth: &str) -> Result<Device, &'static str> {
    let usable = endpoint.len() <= ENDPOINT_MAX
        && endpoint.starts_with("https://")
        && !endpoint.contains(|c: char| c.is_whitespace() || c.is_control())
        && endpoint
            .parse::<Uri>()
            .is_ok_and(|uri| uri.authority().is_some());
    if !usable {
        return Err("a push endpoint is an https address");
    }
    let device = Device {
        endpoint: endpoint.to_owned(),
        p256dh: p256dh.to_owned(),
        auth: auth.to_owned(),
    };
    keys(&device).ok_or("the subscription's keys are not a P-256 point and a 16-byte secret")?;
    Ok(device)
}

fn keys(device: &Device) -> Option<(PublicKey, [u8; 16])> {
    let point = URL_SAFE_NO_PAD.decode(&device.p256dh).ok()?;
    let auth = URL_SAFE_NO_PAD.decode(&device.auth).ok()?;
    Some((
        PublicKey::from_sec1_bytes(&point).ok()?,
        auth.try_into().ok()?,
    ))
}

/// RFC 8291 over RFC 8188: one `aes128gcm` record that only the device reads.
/// `ours` and `salt` are new for each push.
fn encrypt(
    text: &[u8],
    theirs: &PublicKey,
    auth: &[u8; 16],
    ours: &SecretKey,
    salt: [u8; 16],
) -> Option<Vec<u8>> {
    if text.len() > TEXT_MAX {
        return None;
    }
    let ua_public = theirs.to_sec1_point(false);
    let as_public = ours.public_key().to_sec1_point(false);
    let shared = p256::ecdh::diffie_hellman(ours.to_nonzero_scalar(), theirs.as_affine());

    let mut info = b"WebPush: info\0".to_vec();
    info.extend_from_slice(ua_public.as_bytes());
    info.extend_from_slice(as_public.as_bytes());
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(auth), shared.raw_secret_bytes())
        .expand(&info, &mut ikm)
        .ok()?;

    let content = Hkdf::<Sha256>::new(Some(&salt), &ikm);
    let (mut key, mut nonce) = ([0u8; 16], [0u8; 12]);
    content
        .expand(b"Content-Encoding: aes128gcm\0", &mut key)
        .ok()?;
    content
        .expand(b"Content-Encoding: nonce\0", &mut nonce)
        .ok()?;

    // 0x02 ends the last record, and this push has one.
    let mut record = text.to_vec();
    record.push(2);
    let sealed = Aes128Gcm::new(&AesKey::<Aes128Gcm>::from(key))
        .encrypt(&Nonce::from(nonce), record.as_slice())
        .ok()?;

    let mut body = salt.to_vec();
    body.extend_from_slice(&RECORD.to_be_bytes());
    body.push(as_public.len() as u8);
    body.extend_from_slice(as_public.as_bytes());
    body.extend_from_slice(&sealed);
    Some(body)
}

enum Outcome {
    Sent,
    /// The push service no longer has the subscription (404 or 410).
    Gone,
    Failed(String),
}

/// One push to one device, on a blocking thread (I-13). No failure quotes the
/// endpoint, because the endpoint is a capability.
fn deliver(key: &Key, device: &Device, text: &[u8]) -> Outcome {
    let failed = |why: &str| Outcome::Failed(why.to_owned());
    let Some((theirs, auth)) = keys(device) else {
        return failed("a stored subscription has unusable keys");
    };
    let Ok((ours, _)) = scalar() else {
        return failed("the kernel gave no random bytes");
    };
    let mut salt = [0u8; 16];
    if getrandom::fill(&mut salt).is_err() {
        return failed("the kernel gave no random bytes");
    }
    let Some(body) = encrypt(text, &theirs, &auth, &ours, salt) else {
        return failed("the push is too long to encrypt");
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    let Some(authorization) = key.authorization(&device.endpoint, now) else {
        return failed("a stored subscription has an unusable endpoint");
    };
    let sent = ureq::post(&device.endpoint)
        .config()
        .timeout_global(Some(TIMEOUT))
        // A redirect would leave the https endpoint that `checked` accepted.
        .max_redirects(0)
        .https_only(!cfg!(test))
        .build()
        .header("TTL", &KEPT.as_secs().to_string())
        .header("Content-Encoding", "aes128gcm")
        .header("Content-Type", "application/octet-stream")
        .header("Authorization", &authorization)
        .send(&body[..]);
    match sent {
        Ok(answer) if answer.status().is_redirection() => Outcome::Failed(format!(
            "the push service answered {}",
            answer.status().as_u16()
        )),
        Ok(_) => Outcome::Sent,
        Err(ureq::Error::StatusCode(404 | 410)) => Outcome::Gone,
        Err(ureq::Error::StatusCode(status)) => {
            Outcome::Failed(format!("the push service answered {status}"))
        }
        Err(error) => Outcome::Failed(format!(
            "the push service could not be reached: {}",
            notify::reason(&error)
        )),
    }
}

/// What a device's service worker reads: a title, a body, and the page a tap
/// opens.
fn payload(message: &Message) -> Vec<u8> {
    serde_json::json!({
        "title": message.title.as_deref().unwrap_or("Yantra"),
        "body": message.body,
        "url": message.path.as_deref().unwrap_or("/"),
    })
    .to_string()
    .into_bytes()
}

/// Why a test push did not arrive.
#[derive(Debug)]
pub enum Untested {
    /// The store has no such device, or the push service just said it is gone.
    Unknown,
    Failed(String),
}

/// The key, when there is one, and the devices. Cloned into each task that
/// tells someone something.
#[derive(Clone)]
pub struct Push {
    store: Store,
    key: Arc<tokio::sync::RwLock<Option<Arc<Key>>>>,
    /// `Fleet::env`: one writer of the environment file at a time.
    env: Arc<tokio::sync::Mutex<()>>,
    file: Arc<Path>,
}

impl std::fmt::Debug for Push {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Push").finish_non_exhaustive()
    }
}

impl Push {
    /// `configured` is `YANTRA_VAPID_KEY` from the environment. `file` is
    /// where a new key is written, a parameter so a test names a scratch one.
    pub fn new(
        store: Store,
        env: Arc<tokio::sync::Mutex<()>>,
        file: &Path,
        configured: Option<&str>,
    ) -> Self {
        let key = configured.and_then(|text| {
            let key = Key::parse(text);
            if key.is_none() {
                tracing::warn!(
                    "{} is not a signing key, so the next device to turn notifications on gets a new one",
                    notify::VAPID_KEY
                );
            }
            key
        });
        Self {
            store,
            key: Arc::new(tokio::sync::RwLock::new(key.map(Arc::new))),
            env,
            file: file.into(),
        }
    }

    async fn key(&self) -> Option<Arc<Key>> {
        self.key.read().await.clone()
    }

    /// The public key a browser subscribes with. The first call makes the
    /// pair and writes the private half to the environment file (ADR-0047
    /// decision 2). A key that could not be written is not used: a restart
    /// would lose it and every device with it.
    pub async fn public_key(&self) -> Result<String, Error> {
        if let Some(key) = self.key().await {
            return Ok(key.public.clone());
        }
        // Both locks, as every writer of this file takes them.
        let _write = self.env.lock().await;
        if let Some(key) = self.key().await {
            return Ok(key.public.clone());
        }
        let (key, secret) = Key::generate()?;
        // A device kept from an older key cannot be pushed to with this one.
        // They go first, so a failed delete leaves no key that outlives them.
        self.store.remove_devices().await?;
        notify::write_vapid(&self.file, &secret)?;
        let public = key.public.clone();
        *self.key.write().await = Some(Arc::new(key));
        tracing::info!(
            "made the Web Push signing key and wrote it to {}",
            self.file.display()
        );
        Ok(public)
    }

    /// Sends `message` to every device whose endpoint is not in `watching`,
    /// at once. A device its push service no longer knows is removed. The
    /// first failure is the answer, and no push is tried twice.
    pub async fn send(&self, message: &Message, watching: &HashSet<String>) -> Result<(), String> {
        let Some(key) = self.key().await else {
            return Ok(());
        };
        let devices = self.store.devices().await.map_err(|error| chain(&error))?;
        let text: Arc<[u8]> = payload(message).into();
        let sends: Vec<_> = devices
            .into_iter()
            .filter(|device| !watching.contains(&device.endpoint))
            .map(|device| {
                let (key, text) = (key.clone(), text.clone());
                tokio::task::spawn_blocking(move || {
                    let outcome = deliver(&key, &device, &text);
                    (device, outcome)
                })
            })
            .collect();
        let mut failed = None;
        for send in sends {
            match send.await {
                Ok((_, Outcome::Sent)) => {}
                Ok((device, Outcome::Gone)) => self.forget(&device.endpoint).await,
                Ok((_, Outcome::Failed(why))) => failed = failed.or(Some(why)),
                Err(_) => failed = failed.or(Some("a push did not finish".to_owned())),
            }
        }
        failed.map_or(Ok(()), Err)
    }

    /// One push to the device that asked, so its owner sees one arrive.
    pub async fn test(&self, endpoint: &str) -> Result<(), Untested> {
        let failed = |why: String| Untested::Failed(why);
        let key = self.key().await.ok_or(Untested::Unknown)?;
        let device = self
            .store
            .device(endpoint)
            .await
            .map_err(|error| failed(chain(&error)))?
            .ok_or(Untested::Unknown)?;
        let text = payload(&Message {
            body: "Notifications work on this device.".to_owned(),
            title: Some("Yantra".to_owned()),
            priority: None,
            click: None,
            path: Some("/settings/notifications".to_owned()),
        });
        let outcome = tokio::task::spawn_blocking(move || deliver(&key, &device, &text))
            .await
            .map_err(|_| failed("the push did not finish".to_owned()))?;
        match outcome {
            Outcome::Sent => Ok(()),
            Outcome::Gone => {
                self.forget(endpoint).await;
                Err(Untested::Unknown)
            }
            Outcome::Failed(why) => Err(failed(why)),
        }
    }

    async fn forget(&self, endpoint: &str) {
        match self.store.remove_device(endpoint).await {
            Ok(_) => tracing::info!("a device's push subscription is gone, so it was removed"),
            Err(error) => tracing::warn!(
                "a push subscription that is gone was not removed: {}",
                chain(&error)
            ),
        }
    }
}

#[derive(Clone)]
struct Pushing<I> {
    authoriser: Authoriser<I>,
    push: Option<Push>,
}

impl<I> Pushing<I> {
    /// `None` only in a test that built no store.
    fn push(&self) -> Result<&Push, Refused> {
        self.push.as_ref().ok_or_else(|| {
            refused(
                StatusCode::INTERNAL_SERVER_ERROR,
                "this daemon has no store",
            )
        })
    }
}

fn refused(status: StatusCode, said: &str) -> Refused {
    Refused::Verb {
        status,
        said: said.to_owned(),
    }
}

/// Every route passes the owner alone (ADR-0047 decision 4): an agent token
/// is 403 and a caller with no session is 401.
pub fn router<I, S>(authoriser: Authoriser<I>, push: Option<Push>) -> Router<S>
where
    I: Inventory + Clone + Send + Sync + 'static,
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/push/key", get(public_key::<I>))
        .route(
            "/push/subscriptions",
            post(subscribe::<I>).delete(unsubscribe::<I>),
        )
        .route("/push/test", post(test::<I>))
        .with_state(Pushing { authoriser, push })
}

#[derive(Debug, serde::Serialize)]
pub(crate) struct PushKey {
    key: String,
}

/// **A `GET` that may write, once**, as `GET /join` is: the key is made when
/// the first device asks for it. Authorised like a write for that reason.
async fn public_key<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Pushing<I>>,
    ConnectInfo(from): ConnectInfo<Peer>,
    headers: HeaderMap,
) -> Result<Json<PushKey>, Refused> {
    allowed(&state.authoriser, &from, &headers).await?;
    let key = state
        .push()?
        .public_key()
        .await
        .map_err(|error| refused(StatusCode::INTERNAL_SERVER_ERROR, &chain(&error)))?;
    Ok(Json(PushKey { key }))
}

/// `PushSubscription.toJSON()` without its `expirationTime`.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Subscribe {
    endpoint: String,
    keys: Keys,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Keys {
    p256dh: String,
    auth: String,
}

async fn subscribe<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Pushing<I>>,
    ConnectInfo(from): ConnectInfo<Peer>,
    headers: HeaderMap,
    Json(sent): Json<Subscribe>,
) -> Result<StatusCode, Refused> {
    let caller = allowed(&state.authoriser, &from, &headers).await?;
    let push = state.push()?;
    let device = checked(&sent.endpoint, &sent.keys.p256dh, &sent.keys.auth)
        .map_err(|why| refused(StatusCode::BAD_REQUEST, why))?;
    if push.key().await.is_none() {
        return Err(refused(
            StatusCode::CONFLICT,
            "this daemon has no signing key yet, so no subscription can be for it",
        ));
    }
    let kept = push
        .store
        .put_device(device, DEVICES)
        .await
        .map_err(|error| refused(StatusCode::INTERNAL_SERVER_ERROR, &chain(&error)))?;
    if !kept {
        return Err(refused(
            StatusCode::CONFLICT,
            "16 devices get notifications already. Turn one off first.",
        ));
    }
    tracing::info!("push: a device subscribed for {}", caller.node);
    Ok(StatusCode::NO_CONTENT)
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Named {
    pub(crate) endpoint: String,
}

/// 204 whether or not the store had the device, so a second tap is not an error.
async fn unsubscribe<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Pushing<I>>,
    ConnectInfo(from): ConnectInfo<Peer>,
    headers: HeaderMap,
    Json(named): Json<Named>,
) -> Result<StatusCode, Refused> {
    let caller = allowed(&state.authoriser, &from, &headers).await?;
    state
        .push()?
        .store
        .remove_device(&named.endpoint)
        .await
        .map_err(|error| refused(StatusCode::INTERNAL_SERVER_ERROR, &chain(&error)))?;
    tracing::info!("push: a device unsubscribed for {}", caller.node);
    Ok(StatusCode::NO_CONTENT)
}

async fn test<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Pushing<I>>,
    ConnectInfo(from): ConnectInfo<Peer>,
    headers: HeaderMap,
    Json(named): Json<Named>,
) -> Result<StatusCode, Refused> {
    allowed(&state.authoriser, &from, &headers).await?;
    match state.push()?.test(&named.endpoint).await {
        Ok(()) => Ok(StatusCode::NO_CONTENT),
        Err(Untested::Unknown) => Err(refused(
            StatusCode::NOT_FOUND,
            "this device is not on the list",
        )),
        Err(Untested::Failed(why)) => Err(refused(StatusCode::BAD_GATEWAY, &why)),
    }
}

#[cfg(test)]
pub(crate) fn answers() -> Vec<(&'static str, &'static str, serde_json::Value)> {
    let key = PushKey {
        key: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"
            .to_owned(),
    };
    vec![(
        "pushKey",
        "PushKey",
        serde_json::to_value(key).unwrap_or_default(),
    )]
}

#[cfg(test)]
#[allow(clippy::expect_used)]
pub(crate) mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{IpAddr, SocketAddr, TcpListener};
    use std::thread;

    use axum::body::Body;
    use axum::http::{Method, Request, header};
    use p256::ecdsa::VerifyingKey;
    use p256::ecdsa::signature::Verifier as _;
    use tower::ServiceExt as _;
    use yantra_core::inventory::{Caller, Fake};

    use crate::passkey::Passkeys;

    fn b64(text: &str) -> Vec<u8> {
        URL_SAFE_NO_PAD.decode(text).expect("URL-safe base64")
    }

    // RFC 8291, section 5 and appendix A.
    const UA_PRIVATE: &str = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
    const UA_PUBLIC: &str =
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const AUTH: &str = "BTBZMqHH6r4Tts7J_aSIgg";
    const AS_PRIVATE: &str = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
    const SALT: &str = "DGv6ra1nlYgDCS1FRnbzlw";
    const TEXT: &str = "When I grow up, I want to be a watermelon";
    const BODY: &str = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

    /// The device's side of [`encrypt`], which only a test needs.
    pub(crate) fn decrypt(body: &[u8], theirs: &SecretKey, auth: &[u8; 16]) -> Vec<u8> {
        let (salt, rest) = body.split_at(16);
        let (_record, rest) = rest.split_at(4);
        let (as_public, sealed) = rest[1..].split_at(usize::from(rest[0]));
        let ours = PublicKey::from_sec1_bytes(as_public).expect("the sender's point");
        let shared = p256::ecdh::diffie_hellman(theirs.to_nonzero_scalar(), ours.as_affine());
        let mut info = b"WebPush: info\0".to_vec();
        info.extend_from_slice(theirs.public_key().to_sec1_point(false).as_bytes());
        info.extend_from_slice(as_public);
        let mut ikm = [0u8; 32];
        Hkdf::<Sha256>::new(Some(auth), shared.raw_secret_bytes())
            .expand(&info, &mut ikm)
            .expect("32 bytes");
        let content = Hkdf::<Sha256>::new(Some(salt), &ikm);
        let (mut key, mut nonce) = ([0u8; 16], [0u8; 12]);
        content
            .expand(b"Content-Encoding: aes128gcm\0", &mut key)
            .expect("16 bytes");
        content
            .expand(b"Content-Encoding: nonce\0", &mut nonce)
            .expect("12 bytes");
        let mut text = Aes128Gcm::new(&AesKey::<Aes128Gcm>::from(key))
            .decrypt(&Nonce::from(nonce), sealed)
            .expect("the tag matches");
        assert_eq!(text.pop(), Some(2), "the last record's delimiter");
        text
    }

    #[test]
    fn the_encryption_gives_rfc_8291s_own_example_byte_for_byte() {
        let theirs = PublicKey::from_sec1_bytes(&b64(UA_PUBLIC)).expect("the example's point");
        let ours = SecretKey::from_slice(&b64(AS_PRIVATE)).expect("the example's scalar");
        let auth: [u8; 16] = b64(AUTH).try_into().expect("16 bytes");
        let salt: [u8; 16] = b64(SALT).try_into().expect("16 bytes");

        let body = encrypt(TEXT.as_bytes(), &theirs, &auth, &ours, salt).expect("it encrypts");

        assert_eq!(URL_SAFE_NO_PAD.encode(&body), BODY);
        let device = SecretKey::from_slice(&b64(UA_PRIVATE)).expect("the example's scalar");
        assert_eq!(decrypt(&body, &device, &auth), TEXT.as_bytes());
    }

    #[test]
    fn a_text_longer_than_one_record_is_refused() {
        let theirs = PublicKey::from_sec1_bytes(&b64(UA_PUBLIC)).expect("the example's point");
        let (ours, _) = scalar().expect("random bytes");
        let long = vec![b'a'; TEXT_MAX + 1];
        assert!(encrypt(&long, &theirs, &[0; 16], &ours, [0; 16]).is_none());
        assert!(encrypt(&long[1..], &theirs, &[0; 16], &ours, [0; 16]).is_some());
    }

    #[test]
    fn a_key_survives_the_file_and_a_wrong_one_is_no_key() {
        let (key, secret) = Key::generate().expect("random bytes");
        assert_eq!(secret.len(), 43);
        assert_eq!(key.public.len(), 87, "65 bytes, uncompressed");
        assert_eq!(Key::parse(&secret).expect("it parses").public, key.public);
        for wrong in [
            "",
            "notarealkey",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        ] {
            assert!(Key::parse(wrong).is_none(), "{wrong:?}");
        }
    }

    #[test]
    fn a_subscription_needs_https_a_point_and_a_16_byte_secret() {
        let https = "https://web.push.apple.com/QGk";
        assert!(checked(https, UA_PUBLIC, AUTH).is_ok());
        for endpoint in [
            "http://web.push.apple.com/QGk",
            "https://",
            "https://web.push.apple.com/a b",
            "file:///etc/passwd",
            "",
        ] {
            assert!(checked(endpoint, UA_PUBLIC, AUTH).is_err(), "{endpoint:?}");
        }
        assert!(checked(https, AUTH, AUTH).is_err(), "no point");
        assert!(checked(https, UA_PUBLIC, UA_PRIVATE).is_err(), "32 bytes");
        assert!(checked(https, UA_PUBLIC, "not base64!").is_err());
    }

    /// A device whose keys this test holds, at `endpoint`.
    pub(crate) fn device(endpoint: &str) -> (Device, SecretKey, [u8; 16]) {
        let (secret, _) = scalar().expect("random bytes");
        let mut auth = [0u8; 16];
        getrandom::fill(&mut auth).expect("random bytes");
        let device = Device {
            endpoint: endpoint.to_owned(),
            p256dh: URL_SAFE_NO_PAD.encode(secret.public_key().to_sec1_point(false)),
            auth: URL_SAFE_NO_PAD.encode(auth),
        };
        (device, secret, auth)
    }

    /// A `Push` over a store and an environment file of its own.
    pub(crate) fn scratch() -> (Push, std::path::PathBuf) {
        let (store, path) = crate::store::tests::scratch();
        let file = path.with_file_name("daemon.env");
        let push = Push::new(store, Arc::default(), &file, None);
        (push, file)
    }

    #[tokio::test]
    async fn the_store_keeps_a_device_once_and_stops_at_its_limit() {
        let (push, _) = scratch();
        let (first, ..) = device("https://push.example/a");
        let (second, ..) = device("https://push.example/b");

        assert!(push.store.put_device(first.clone(), 1).await.expect("sql"));
        let mut again = first.clone();
        again.auth = second.auth.clone();
        assert!(push.store.put_device(again.clone(), 1).await.expect("sql"));
        assert!(!push.store.put_device(second, 1).await.expect("sql"));
        assert_eq!(push.store.devices().await.expect("sql"), [again.clone()]);
        assert_eq!(
            push.store.device(&first.endpoint).await.expect("sql"),
            Some(again)
        );

        assert!(
            push.store
                .remove_device(&first.endpoint)
                .await
                .expect("sql")
        );
        assert!(
            !push
                .store
                .remove_device(&first.endpoint)
                .await
                .expect("sql")
        );
        assert!(push.store.devices().await.expect("sql").is_empty());
    }

    #[tokio::test]
    async fn the_key_is_made_once_written_down_and_read_back() {
        let (push, file) = scratch();
        let (old, ..) = device("https://push.example/old");
        push.store.put_device(old, DEVICES).await.expect("sql");

        let public = push.public_key().await.expect("a key");
        assert_eq!(push.public_key().await.expect("a key"), public);
        assert!(
            push.store.devices().await.expect("sql").is_empty(),
            "a device from before the key cannot be pushed to"
        );

        let written = std::fs::read_to_string(&file).expect("the file");
        let line = written
            .lines()
            .find_map(|line| line.strip_prefix("YANTRA_VAPID_KEY='"))
            .expect("the key's line");
        let secret = line.trim_end_matches('\'');
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(&file).expect("the file").permissions();
        assert_eq!(mode.mode() & 0o777, 0o600);

        let (store, _) = crate::store::tests::scratch();
        let restarted = Push::new(store, Arc::default(), &file, Some(secret));
        assert_eq!(restarted.public_key().await.expect("a key"), public);
    }

    #[tokio::test]
    async fn a_key_that_cannot_be_written_is_not_used() {
        let (store, path) = crate::store::tests::scratch();
        let file = path.with_file_name("no-such-directory").join("daemon.env");
        let push = Push::new(store, Arc::default(), &file, None);
        let (old, ..) = device("https://push.example/old");
        push.store.put_device(old, DEVICES).await.expect("sql");

        assert!(matches!(push.public_key().await, Err(Error::NotKept(_))));
        assert!(push.key().await.is_none());
        assert!(
            push.store.devices().await.expect("sql").is_empty(),
            "the devices go before the key is written"
        );
    }

    /// One request as a push service sees it: the head and the bytes.
    pub(crate) fn request(listener: &TcpListener, status: &str) -> (String, Vec<u8>) {
        let (mut stream, _) = listener.accept().expect("the daemon connects");
        let mut seen = Vec::new();
        let mut byte = [0u8; 1];
        let (head, length) = loop {
            stream.read_exact(&mut byte).expect("a request");
            seen.push(byte[0]);
            if seen.ends_with(b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&seen).into_owned();
                let length: usize = header_of(&head, "content-length")
                    .and_then(|length| length.parse().ok())
                    .expect("a length");
                break (head, length);
            }
        };
        let mut body = vec![0u8; length];
        stream.read_exact(&mut body).expect("the body");
        stream
            .write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\n\r\n").as_bytes())
            .expect("the push service answers");
        (head, body)
    }

    fn header_of<'a>(head: &'a str, name: &str) -> Option<&'a str> {
        head.lines().find_map(|line| {
            let (found, value) = line.split_once(':')?;
            found.eq_ignore_ascii_case(name).then(|| value.trim())
        })
    }

    /// A push service on a loopback port that answers each request with the
    /// next status, and a `Push` with a key and one device at it.
    pub(crate) async fn pushing_to(
        statuses: &'static [&'static str],
    ) -> (
        Push,
        Device,
        SecretKey,
        [u8; 16],
        thread::JoinHandle<Vec<(String, Vec<u8>)>>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let address = listener.local_addr().expect("the port it got");
        let served = thread::spawn(move || {
            statuses
                .iter()
                .map(|status| request(&listener, status))
                .collect()
        });
        let (push, device, secret, auth) = pushing_at(address).await;
        (push, device, secret, auth, served)
    }

    /// A `Push` with a key and one device whose push service is at `address`.
    pub(crate) async fn pushing_at(address: SocketAddr) -> (Push, Device, SecretKey, [u8; 16]) {
        let (push, _) = scratch();
        push.public_key().await.expect("a key");
        let (device, secret, auth) = another(&push, address, "abc").await;
        (push, device, secret, auth)
    }

    /// One more device in `push`'s store, at `/push/{name}` on `address`.
    pub(crate) async fn another(
        push: &Push,
        address: SocketAddr,
        name: &str,
    ) -> (Device, SecretKey, [u8; 16]) {
        let (device, secret, auth) = device(&format!("http://{address}/push/{name}"));
        push.store
            .put_device(device.clone(), DEVICES)
            .await
            .expect("sql");
        (device, secret, auth)
    }

    fn said(title: &str, body: &str, path: Option<&str>) -> Message {
        Message {
            body: body.to_owned(),
            title: Some(title.to_owned()),
            priority: None,
            click: None,
            path: path.map(str::to_owned),
        }
    }

    /// The whole send over one real socket: the three headers a push service
    /// needs, a signature its key verifies, and a body only the device reads.
    #[tokio::test]
    async fn a_push_is_signed_for_its_service_and_only_the_device_reads_it() {
        let (push, device, secret, auth, served) = pushing_to(&["201 Created"]).await;

        push.send(
            &said("Approval needed", "api: waiting", Some("/w/api")),
            &HashSet::new(),
        )
        .await
        .expect("it lands");

        let (head, body) = served.join().expect("the listener").remove(0);
        assert!(head.starts_with("POST /push/abc "), "{head}");
        assert_eq!(header_of(&head, "ttl"), Some("43200"));
        assert_eq!(header_of(&head, "content-encoding"), Some("aes128gcm"));

        let text: serde_json::Value =
            serde_json::from_slice(&decrypt(&body, &secret, &auth)).expect("JSON");
        assert_eq!(
            text,
            serde_json::json!({"title": "Approval needed", "body": "api: waiting", "url": "/w/api"})
        );
        assert!(
            !String::from_utf8_lossy(&body).contains("waiting"),
            "the push service reads no word"
        );

        let authorization = header_of(&head, "authorization").expect("signed");
        let (token, k) = authorization
            .strip_prefix("vapid t=")
            .and_then(|rest| rest.split_once(", k="))
            .expect("RFC 8292's shape");
        assert_eq!(k, push.public_key().await.expect("a key"));
        let parts: Vec<&str> = token.split('.').collect();
        let signed = format!("{}.{}", parts[0], parts[1]);
        let signature = Signature::from_slice(&b64(parts[2])).expect("r and s");
        VerifyingKey::from_sec1_bytes(&b64(k))
            .expect("the public key")
            .verify(signed.as_bytes(), &signature)
            .expect("the key signed it");
        let header: serde_json::Value = serde_json::from_slice(&b64(parts[0])).expect("JSON");
        assert_eq!(header, serde_json::json!({"typ": "JWT", "alg": "ES256"}));
        let claims: serde_json::Value = serde_json::from_slice(&b64(parts[1])).expect("JSON");
        assert_eq!(claims["aud"], device.endpoint.trim_end_matches("/push/abc"));
        assert_eq!(claims["sub"], CONTACT);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("after 1970")
            .as_secs();
        let exp = claims["exp"].as_u64().expect("a time");
        assert!(
            exp > now && exp <= now + 24 * 60 * 60,
            "RFC 8292's day: {exp}"
        );
    }

    /// ADR-0047 decision 7: 404 and 410 both remove the device, and any
    /// other refusal keeps it and is the failure the caller logs.
    #[tokio::test]
    async fn a_device_its_push_service_forgot_is_removed_and_a_refusal_is_not() {
        for gone in ["410 Gone", "404 Not Found"] {
            let statuses: &'static [&'static str] = Box::leak(Box::new([gone]));
            let (push, _, _, _, served) = pushing_to(statuses).await;
            push.send(&said("t", "b", None), &HashSet::new())
                .await
                .expect("not a failure");
            served.join().expect("the listener");
            assert!(
                push.store.devices().await.expect("sql").is_empty(),
                "{gone}"
            );
        }

        let (push, device, _, _, served) = pushing_to(&["503 Service Unavailable"]).await;
        let failed = push
            .send(&said("t", "b", None), &HashSet::new())
            .await
            .expect_err("refused");
        served.join().expect("the listener");
        assert_eq!(failed, "the push service answered 503");
        assert!(!failed.contains(&device.endpoint));
        assert_eq!(push.store.devices().await.expect("sql"), [device]);
    }

    /// The endpoint was checked as https, and a redirect names another
    /// address. So a 3xx is a failure, and nothing goes to where it points.
    #[tokio::test]
    async fn a_redirect_is_a_failure_and_is_not_followed() {
        let elsewhere = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let there = elsewhere.local_addr().expect("the port it got");
        let status: &'static str =
            Box::leak(format!("302 Found\r\nLocation: http://{there}/taken").into_boxed_str());
        let statuses: &'static [&'static str] = Box::leak(Box::new([status]));
        let (push, device, _, _, served) = pushing_to(statuses).await;

        let failed = push
            .send(&said("t", "b", None), &HashSet::new())
            .await
            .expect_err("a 302");

        served.join().expect("the listener");
        assert_eq!(failed, "the push service answered 302");
        elsewhere
            .set_nonblocking(true)
            .expect("a nonblocking check");
        assert!(elsewhere.accept().is_err(), "the redirect was followed");
        assert_eq!(push.store.devices().await.expect("sql"), [device]);
    }

    #[tokio::test]
    async fn with_no_key_or_no_device_nothing_is_sent() {
        let (push, _) = scratch();
        push.send(&said("t", "b", None), &HashSet::new())
            .await
            .expect("nothing to do");
        push.public_key().await.expect("a key");
        push.send(&said("t", "b", None), &HashSet::new())
            .await
            .expect("nothing to do");
        assert!(matches!(
            push.test("https://push.example/a").await,
            Err(Untested::Unknown)
        ));
    }

    const MINE: [u8; 4] = [100, 64, 0, 2];
    const GUEST: [u8; 4] = [100, 64, 0, 9];
    const ME: u64 = 7;

    fn app(passkeys: Passkeys, push: Push) -> Router {
        let caller = |node: &str, user| Caller {
            node: node.to_owned(),
            user,
            tags: Vec::new(),
        };
        let fake = Fake {
            machines: Vec::new(),
            addresses: Vec::new(),
            callers: [
                (IpAddr::from(MINE), caller("nMINE", ME)),
                (IpAddr::from(GUEST), caller("nGUEST", ME + 1)),
            ]
            .into_iter()
            .collect(),
            owner: ME,
        };
        router(
            Authoriser::new(fake, &[], Path::new("yantrad.sock"), passkeys),
            Some(push),
        )
    }

    async fn ask(
        app: &Router,
        method: Method,
        path: &str,
        body: Option<serde_json::Value>,
        from: [u8; 4],
        credential: Option<(header::HeaderName, String)>,
    ) -> (StatusCode, String) {
        let mut request = Request::builder().method(method).uri(path);
        if let Some((name, value)) = credential {
            request = request.header(name, value);
        }
        if body.is_some() {
            request = request.header(header::CONTENT_TYPE, "application/json");
        }
        let mut request = request
            .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
            .expect("a request");
        request
            .extensions_mut()
            .insert(ConnectInfo(Peer::from(SocketAddr::from((from, 61620)))));
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

    fn subscription(device: &Device) -> serde_json::Value {
        serde_json::json!({
            "endpoint": device.endpoint,
            "keys": {"p256dh": device.p256dh, "auth": device.auth},
        })
    }

    /// ADR-0047 decision 4 on all four routes: the owner's session passes,
    /// and no session, an agent token and a guest's node are each refused.
    #[tokio::test]
    async fn only_the_owners_session_reaches_a_push_route() {
        let passkeys = Passkeys::memory();
        let (_, session, _) = crate::passkey::tests::enrolled(&passkeys, "iPhone");
        let agent = passkeys.mint_agent("web");
        let (push, _) = scratch();
        let app = app(passkeys, push.clone());
        let (device, ..) = device("https://push.example/a");
        let cookie = || {
            Some((
                header::COOKIE,
                format!("{}={session}", crate::passkey::COOKIE),
            ))
        };
        let bearer = || Some((header::AUTHORIZATION, format!("Bearer {}", agent.token)));
        let named = serde_json::json!({"endpoint": device.endpoint});
        let routes = [
            (Method::GET, "/push/key", None),
            (
                Method::POST,
                "/push/subscriptions",
                Some(subscription(&device)),
            ),
            (Method::POST, "/push/test", Some(named.clone())),
            (Method::DELETE, "/push/subscriptions", Some(named)),
        ];

        for (method, path, body) in &routes {
            let refusals = [
                (MINE, None, StatusCode::UNAUTHORIZED),
                (MINE, bearer(), StatusCode::FORBIDDEN),
                (GUEST, None, StatusCode::UNAUTHORIZED),
                (GUEST, cookie(), StatusCode::FORBIDDEN),
            ];
            for (from, credential, expected) in refusals {
                let (status, said) =
                    ask(&app, method.clone(), path, body.clone(), from, credential).await;
                assert_eq!(status, expected, "{method} {path} from {from:?}: {said}");
            }
        }
        assert!(push.key().await.is_none(), "a refused caller makes no key");
        assert!(push.store.devices().await.expect("sql").is_empty());

        let (status, said) = ask(&app, Method::GET, "/push/key", None, MINE, cookie()).await;
        assert_eq!(status, StatusCode::OK, "{said}");
        let key: serde_json::Value = serde_json::from_str(&said).expect("JSON");
        assert_eq!(key["key"], push.public_key().await.expect("a key"));

        let (status, said) = ask(
            &app,
            Method::POST,
            "/push/subscriptions",
            Some(subscription(&device)),
            MINE,
            cookie(),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{said}");
        assert_eq!(
            push.store.devices().await.expect("sql"),
            std::slice::from_ref(&device)
        );

        let (status, said) = ask(
            &app,
            Method::DELETE,
            "/push/subscriptions",
            Some(serde_json::json!({"endpoint": device.endpoint})),
            MINE,
            cookie(),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{said}");
        assert!(push.store.devices().await.expect("sql").is_empty());
    }

    #[tokio::test]
    async fn the_routes_refuse_a_bad_subscription_and_name_an_unknown_device() {
        let (push, _) = scratch();
        let app = app(Passkeys::trusting(), push.clone());
        let (device, ..) = device("https://push.example/a");

        let (status, said) = ask(
            &app,
            Method::POST,
            "/push/subscriptions",
            Some(subscription(&device)),
            MINE,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "no key yet: {said}");

        push.public_key().await.expect("a key");
        let mut plain = subscription(&device);
        plain["endpoint"] = "http://127.0.0.1:7717/api/update".into();
        let (status, said) = ask(
            &app,
            Method::POST,
            "/push/subscriptions",
            Some(plain),
            MINE,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{said}");

        let mut extra = subscription(&device);
        extra["expirationTime"] = serde_json::Value::Null;
        let (status, _) = ask(
            &app,
            Method::POST,
            "/push/subscriptions",
            Some(extra),
            MINE,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

        let (status, said) = ask(
            &app,
            Method::POST,
            "/push/test",
            Some(serde_json::json!({"endpoint": device.endpoint})),
            MINE,
            None,
        )
        .await;
        assert_eq!(
            (status, said.as_str()),
            (StatusCode::NOT_FOUND, "this device is not on the list")
        );
    }

    /// `POST /api/push/test` end to end: a push reaches the device's push
    /// service, and one the service refuses is a 502 that names no endpoint.
    #[tokio::test]
    async fn a_test_push_arrives_and_a_refused_one_is_a_502() {
        let (push, device, secret, auth, served) =
            pushing_to(&["201 Created", "403 Forbidden"]).await;
        let app = app(Passkeys::trusting(), push);
        let named = serde_json::json!({"endpoint": device.endpoint});

        let (status, said) = ask(
            &app,
            Method::POST,
            "/push/test",
            Some(named.clone()),
            MINE,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{said}");
        let (status, said) = ask(&app, Method::POST, "/push/test", Some(named), MINE, None).await;
        assert_eq!(
            (status, said.as_str()),
            (StatusCode::BAD_GATEWAY, "the push service answered 403")
        );

        let (_, body) = served.join().expect("the listener").remove(0);
        let text: serde_json::Value =
            serde_json::from_slice(&decrypt(&body, &secret, &auth)).expect("JSON");
        assert_eq!(text["body"], "Notifications work on this device.");
        assert_eq!(text["url"], "/settings/notifications");
    }
}
