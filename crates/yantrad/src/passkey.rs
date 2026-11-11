//! The owner's passkeys and sign-in sessions
//! ([ADR-0044](../../../docs/adr/0044-a-write-needs-the-owners-passkey.md)).
//!
//! **The daemon keeps the hash of each token, never the token** (decision 6),
//! so a copy of `passkeys.toml` signs nobody in. The file holds the passkeys'
//! public keys and the sessions; codes, ceremonies and agent tokens live in
//! memory only. Every change to the file is written whole and renamed into
//! place, as `layout.rs` does, at mode `0600` (decision 7).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{ConnectInfo, Path as Route, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use base64::Engine as _;
use sha2::{Digest, Sha256};
use tokio::sync::watch;
use webauthn_rs::prelude::{
    CreationChallengeResponse, Passkey, PasskeyAuthentication, PasskeyRegistration,
    PublicKeyCredential, RegisterPublicKeyCredential, RequestChallengeResponse, Url, Uuid,
    Webauthn, WebauthnBuilder, WebauthnError,
};
use yantra_core::inventory::Inventory;

use crate::heartbeat::Fleet;
use crate::write::{Authoriser, Peer, Refused, Who, allowed, chain, identify};

/// The one cookie (decision 4). `__Host-` makes the browser refuse it without
/// `Secure` and `Path=/`, or with a `Domain`.
pub const COOKIE: &str = "__Host-yantra_session";
/// 30 days from sign-in, never extended on use (decision 4).
pub const SESSION_LIFE: u64 = 30 * 24 * 60 * 60;
/// A code lives 10 minutes (decision 2).
const CODE_LIFE: u64 = 10 * 60;
/// The ceremony state stays 5 minutes (decision 1).
const CEREMONY_LIFE: u64 = 5 * 60;
/// Five wrong codes in a row void every open code (decision 2).
const WRONG_LIMIT: u32 = 5;
/// No 0, O, 1, I or L, so a code read off a screen is typed right.
const ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH: usize = 8;
const FILE: &str = "passkeys.toml";
const TEMP: &str = "passkeys.toml.tmp";
/// Shortens a code's life for the podman test, which cannot wait 10 minutes.
/// It can only shorten.
const CODE_LIFE_ENV: &str = "YANTRA_PASSKEY_CODE_SECONDS";
/// Every passkey belongs to the one owner, so one user handle names them all.
/// An authenticator then keeps one Yantra passkey and replaces it on enrol.
const OWNER: Uuid = Uuid::from_u128(0x7961_6e74_7261_2d6f_776e_6572_0000_0001);

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("that code is wrong, used or older than 10 minutes. Make a new one.")]
    WrongCode,
    #[error("the sign-in took longer than 5 minutes, or it already finished. Start again.")]
    NoCeremony,
    #[error("a passkey named {0} is already enrolled. Remove it first, or pick another name.")]
    Taken(String),
    #[error("a device name is 1 to 40 characters and no control character")]
    BadName,
    #[error("this passkey is not enrolled here")]
    Unknown,
    #[error("the browser's answer did not verify")]
    Webauthn(#[source] WebauthnError),
    #[error("the hub's name {0} cannot be a relying party")]
    Relying(String),
    #[error("could not write {}", .0.display())]
    Unwritable(PathBuf, #[source] std::io::Error),
}

/// One enrolled passkey: its name, when it was made, and its public key.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct Enrolled {
    name: String,
    made: u64,
    key: Passkey,
}

/// One signed-in device. `hash` is SHA-256 of its token in hex.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Session {
    pub id: String,
    pub passkey: String,
    pub device: String,
    hash: String,
    pub made: u64,
    pub ends: u64,
}

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct Saved {
    #[serde(default, rename = "passkey")]
    passkeys: Vec<Enrolled>,
    #[serde(default, rename = "session")]
    sessions: Vec<Session>,
}

/// The open codes of one kind: enrolment or join.
#[derive(Debug, Default)]
struct Codes {
    open: Vec<(String, u64)>,
    wrong: u32,
}

impl Codes {
    fn make(&mut self, now: u64, life: u64) -> String {
        let code = code();
        self.open.retain(|(_, ends)| *ends > now);
        self.open.push((code.clone(), now + life));
        code
    }

    /// Whether `code` is open. A wrong one counts toward [`WRONG_LIMIT`].
    fn check(&mut self, code: &str, now: u64) -> bool {
        self.open.retain(|(_, ends)| *ends > now);
        let code = normal(code);
        if self.open.iter().any(|(open, _)| *open == code) {
            self.wrong = 0;
            return true;
        }
        self.wrong += 1;
        if self.wrong >= WRONG_LIMIT {
            self.open.clear();
            self.wrong = 0;
        }
        false
    }

    /// Uses `code` once.
    fn take(&mut self, code: &str, now: u64) -> bool {
        if !self.check(code, now) {
            return false;
        }
        let code = normal(code);
        self.open.retain(|(open, _)| *open != code);
        true
    }
}

/// Upper case with spaces and dashes gone, so `abcd-efgh` is `ABCDEFGH`.
fn normal(code: &str) -> String {
    code.chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

enum Ceremony {
    Enrol {
        code: String,
        name: String,
        relying: String,
        state: PasskeyRegistration,
    },
    SignIn {
        device: Option<String>,
        relying: String,
        state: PasskeyAuthentication,
    },
}

#[derive(Default)]
struct Held {
    saved: Saved,
    enrol: Codes,
    join: Codes,
    /// Join codes taken, with the node that took each and when it would end.
    joined: Vec<(String, String, u64)>,
    ceremonies: HashMap<String, (u64, Ceremony)>,
    /// Agent token hash to its workspace (decision 12).
    agents: HashMap<String, String>,
    /// A sender per session with an open WebSocket; a revoke sends `true`.
    ended: HashMap<String, watch::Sender<bool>>,
}

/// The relying party: the hub's MagicDNS name and its dashboard origin.
pub struct Relying {
    pub id: String,
    webauthn: Webauthn,
}

impl std::fmt::Debug for Relying {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Relying")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

impl Relying {
    fn new(name: &str) -> Result<Self, Error> {
        let origin = format!("https://{name}:{}", crate::api::HTTPS_PORT);
        let url = Url::parse(&origin).map_err(|_| Error::Relying(name.to_owned()))?;
        let webauthn = WebauthnBuilder::new(name, &url)
            .and_then(|builder| builder.rp_name("Yantra").build())
            .map_err(|_| Error::Relying(name.to_owned()))?;
        Ok(Self {
            id: name.to_owned(),
            webauthn,
        })
    }
}

/// A token minted for one agent session or Chat turn. Dropping it ends it.
pub struct AgentToken {
    pub token: String,
    hash: String,
    passkeys: Passkeys,
}

/// Never prints the token.
impl std::fmt::Debug for AgentToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AgentToken")
    }
}

impl Drop for AgentToken {
    fn drop(&mut self) {
        self.passkeys.lock().agents.remove(&self.hash);
    }
}

struct Shared {
    /// `None` keeps everything in memory, for a test.
    file: Option<PathBuf>,
    state: Mutex<Held>,
    relying: Mutex<Option<Arc<Relying>>>,
    code_life: u64,
    /// Test-only: every request counts as signed in, so the route tests that
    /// predate ADR-0044 keep testing what they test.
    #[cfg(test)]
    trusting: bool,
}

/// The store, shared by the caller check and the sign-in routes.
#[derive(Clone)]
pub struct Passkeys(Arc<Shared>);

impl std::fmt::Debug for Passkeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Passkeys")
    }
}

/// `~/.config/yantra/passkeys.toml`.
pub fn path() -> Option<PathBuf> {
    yantra_core::layout::dir().ok().map(|dir| dir.join(FILE))
}

impl Passkeys {
    /// Reads `file`. A missing file is no passkey; a file that does not parse
    /// is logged and read as empty, and the next enrolment replaces it, which
    /// is decision 9's recovery.
    pub fn open(file: PathBuf) -> Self {
        let saved = match std::fs::read_to_string(&file) {
            Ok(text) => toml::from_str(&text).unwrap_or_else(|error| {
                tracing::error!(
                    "{} does not parse, so no passkey is enrolled: {error}",
                    file.display()
                );
                Saved::default()
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Saved::default(),
            Err(error) => {
                tracing::error!("could not read {}: {error}", file.display());
                Saved::default()
            }
        };
        let life = std::env::var(CODE_LIFE_ENV)
            .ok()
            .and_then(|seconds| seconds.parse().ok())
            .map_or(CODE_LIFE, |seconds: u64| seconds.min(CODE_LIFE));
        Self::with(Some(file), saved, life)
    }

    /// A store that keeps nothing on disk.
    pub fn memory() -> Self {
        Self::with(None, Saved::default(), CODE_LIFE)
    }

    fn with(file: Option<PathBuf>, saved: Saved, code_life: u64) -> Self {
        Self(Arc::new(Shared {
            file,
            state: Mutex::new(Held {
                saved,
                ..Held::default()
            }),
            relying: Mutex::default(),
            code_life,
            #[cfg(test)]
            trusting: false,
        }))
    }

    /// Test-only: every request counts as signed in.
    #[cfg(test)]
    pub fn trusting() -> Self {
        let mut shared = Self::memory();
        if let Some(inner) = Arc::get_mut(&mut shared.0) {
            inner.trusting = true;
        }
        shared
    }

    #[cfg(test)]
    pub fn is_trusting(&self) -> bool {
        self.0.trusting
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Held> {
        self.0.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The relying party for the hub named `name`, built once per name.
    pub fn relying(&self, name: &str) -> Result<Arc<Relying>, Error> {
        let mut held = self
            .0
            .relying
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(relying) = held.as_ref().filter(|relying| relying.id == name) {
            return Ok(Arc::clone(relying));
        }
        let relying = Arc::new(Relying::new(name)?);
        *held = Some(Arc::clone(&relying));
        Ok(relying)
    }

    /// A new enrolment code (decisions 2, 3).
    pub fn enrol_code(&self) -> String {
        let life = self.0.code_life;
        self.lock().enrol.make(now(), life)
    }

    /// A new join code (decision 13).
    pub fn join_code(&self) -> String {
        let life = self.0.code_life;
        self.lock().join.make(now(), life)
    }

    /// Uses a join code once, for the machine whose node is `node`. The code
    /// then stays good for that node's [`Self::joined`] until it would have
    /// expired, so the script's last step can follow the join.
    pub fn take_join(&self, code: &str, node: &str) -> bool {
        let now = now();
        let life = self.0.code_life;
        let mut state = self.lock();
        if !state.join.take(code, now) {
            return false;
        }
        state.joined.retain(|(_, _, ends)| *ends > now);
        state
            .joined
            .push((normal(code), node.to_owned(), now + life));
        true
    }

    /// Whether `code` joined the machine whose node is `node`, recently.
    pub fn joined(&self, code: &str, node: &str) -> bool {
        let (code, now) = (normal(code), now());
        let state = self.lock();
        state
            .joined
            .iter()
            .any(|(taken, by, ends)| *taken == code && by == node && *ends > now)
    }

    /// The live session `token` names. An ended one is dropped and the file
    /// written.
    pub fn session(&self, token: &str) -> Option<Session> {
        self.session_at(token, now())
    }

    fn session_at(&self, token: &str, now: u64) -> Option<Session> {
        let hash = hash(token);
        let mut state = self.lock();
        let found = state.saved.sessions.iter().position(|s| s.hash == hash)?;
        if state.saved.sessions[found].ends > now {
            return Some(state.saved.sessions[found].clone());
        }
        let ended = state.saved.sessions.remove(found);
        end(&mut state, &ended.id);
        self.save(&state).ok();
        None
    }

    /// The workspace an agent token is bound to (decision 12).
    pub fn agent(&self, token: &str) -> Option<String> {
        self.lock().agents.get(&hash(token)).cloned()
    }

    /// A token for one agent session or Chat turn in `workspace`.
    pub fn mint_agent(&self, workspace: &str) -> AgentToken {
        let token = token();
        let hash = hash(&token);
        self.lock()
            .agents
            .insert(hash.clone(), workspace.to_owned());
        AgentToken {
            token,
            hash,
            passkeys: self.clone(),
        }
    }

    /// A receiver that turns `true` when session `id` is revoked or removed.
    pub fn ended(&self, id: &str) -> watch::Receiver<bool> {
        let mut state = self.lock();
        let live = state.saved.sessions.iter().any(|s| s.id == id);
        let sender = state
            .ended
            .entry(id.to_owned())
            .or_insert_with(|| watch::channel(false).0);
        if !live {
            sender.send_replace(true);
        }
        sender.subscribe()
    }

    /// The passkeys, as (name, made), and the live sessions.
    pub fn list(&self) -> (Vec<(String, u64)>, Vec<Session>) {
        let now = now();
        let state = self.lock();
        let keys = state
            .saved
            .passkeys
            .iter()
            .map(|key| (key.name.clone(), key.made))
            .collect();
        let sessions = state
            .saved
            .sessions
            .iter()
            .filter(|s| s.ends > now)
            .cloned()
            .collect();
        (keys, sessions)
    }

    /// Ends session `id`. `false` when there was none.
    pub fn revoke(&self, id: &str) -> Result<bool, Error> {
        self.revoke_where(|s| s.id == id).map(|ended| ended > 0)
    }

    /// Ends every session but `keep`, and says how many ended.
    pub fn revoke_others(&self, keep: &str) -> Result<usize, Error> {
        self.revoke_where(|s| s.id != keep)
    }

    /// Removes passkey `name` and every session it made (decision 9).
    pub fn remove(&self, name: &str) -> Result<bool, Error> {
        let mut state = self.lock();
        let before = state.saved.passkeys.len();
        state.saved.passkeys.retain(|key| key.name != name);
        if state.saved.passkeys.len() == before {
            return Ok(false);
        }
        end_where(&mut state, |s| s.passkey == name);
        self.save(&state)?;
        Ok(true)
    }

    fn revoke_where(&self, revoked: impl Fn(&Session) -> bool) -> Result<usize, Error> {
        let mut state = self.lock();
        let ended = end_where(&mut state, revoked);
        if ended > 0 {
            self.save(&state)?;
        }
        Ok(ended)
    }

    /// The first half of an enrolment: the code must be open, and is used at
    /// the finish, so a cancelled prompt does not spend it.
    pub fn enrol_start(
        &self,
        relying: &Relying,
        code: &str,
        name: &str,
    ) -> Result<(String, CreationChallengeResponse), Error> {
        let name = device_name(name)?;
        let now = now();
        let mut state = self.lock();
        if !state.enrol.check(code, now) {
            return Err(Error::WrongCode);
        }
        if state.saved.passkeys.iter().any(|key| key.name == name) {
            return Err(Error::Taken(name));
        }
        let (challenge, registration) = relying
            .webauthn
            .start_passkey_registration(OWNER, "owner", "Yantra owner", None)
            .map_err(Error::Webauthn)?;
        let id = ceremony(
            &mut state,
            now,
            Ceremony::Enrol {
                code: normal(code),
                name,
                relying: relying.id.clone(),
                state: registration,
            },
        );
        Ok((id, challenge))
    }

    /// The second half: verifies the new passkey, saves it and signs in.
    pub fn enrol_finish(
        &self,
        relying: &Relying,
        id: &str,
        credential: &RegisterPublicKeyCredential,
    ) -> Result<(String, Session), Error> {
        let now = now();
        let mut state = self.lock();
        let Some(Ceremony::Enrol {
            code,
            name,
            relying: made_for,
            state: registration,
        }) = take_ceremony(&mut state, id, now)
        else {
            return Err(Error::NoCeremony);
        };
        if made_for != relying.id {
            return Err(Error::NoCeremony);
        }
        let key = relying
            .webauthn
            .finish_passkey_registration(credential, &registration)
            .map_err(Error::Webauthn)?;
        if !state.enrol.take(&code, now) {
            return Err(Error::WrongCode);
        }
        if state
            .saved
            .passkeys
            .iter()
            .any(|enrolled| enrolled.name == name)
        {
            return Err(Error::Taken(name));
        }
        state.saved.passkeys.push(Enrolled {
            name: name.clone(),
            made: now,
            key,
        });
        let signed = sign_in(&mut state, &name, &name, now);
        self.save(&state)?;
        Ok(signed)
    }

    /// The first half of a sign-in, with every enrolled passkey allowed.
    pub fn sign_in_start(
        &self,
        relying: &Relying,
        device: Option<&str>,
    ) -> Result<(String, RequestChallengeResponse), Error> {
        let device = device.map(device_name).transpose()?;
        let now = now();
        let mut state = self.lock();
        let keys: Vec<Passkey> = state.saved.passkeys.iter().map(|k| k.key.clone()).collect();
        if keys.is_empty() {
            return Err(Error::Unknown);
        }
        let (challenge, authentication) = relying
            .webauthn
            .start_passkey_authentication(&keys)
            .map_err(Error::Webauthn)?;
        let id = ceremony(
            &mut state,
            now,
            Ceremony::SignIn {
                device,
                relying: relying.id.clone(),
                state: authentication,
            },
        );
        Ok((id, challenge))
    }

    /// The second half: verifies the assertion and makes a session.
    pub fn sign_in_finish(
        &self,
        relying: &Relying,
        id: &str,
        credential: &PublicKeyCredential,
    ) -> Result<(String, Session), Error> {
        let now = now();
        let mut state = self.lock();
        let Some(Ceremony::SignIn {
            device,
            relying: made_for,
            state: authentication,
        }) = take_ceremony(&mut state, id, now)
        else {
            return Err(Error::NoCeremony);
        };
        if made_for != relying.id {
            return Err(Error::NoCeremony);
        }
        let result = relying
            .webauthn
            .finish_passkey_authentication(credential, &authentication)
            .map_err(Error::Webauthn)?;
        let enrolled = state
            .saved
            .passkeys
            .iter_mut()
            .find(|key| key.key.cred_id() == result.cred_id())
            .ok_or(Error::Unknown)?;
        enrolled.key.update_credential(&result);
        let name = enrolled.name.clone();
        let device = device.unwrap_or_else(|| name.clone());
        let signed = sign_in(&mut state, &name, &device, now);
        self.save(&state)?;
        Ok(signed)
    }

    fn save(&self, state: &Held) -> Result<(), Error> {
        let Some(file) = &self.0.file else {
            return Ok(());
        };
        write(file, &state.saved)
    }
}

/// Drops every session `ended` picks and closes its sockets; how many.
fn end_where(state: &mut Held, ended: impl Fn(&Session) -> bool) -> usize {
    let ids: Vec<String> = state
        .saved
        .sessions
        .iter()
        .filter(|s| ended(s))
        .map(|s| s.id.clone())
        .collect();
    state.saved.sessions.retain(|s| !ended(s));
    for id in &ids {
        end(state, id);
    }
    ids.len()
}

/// Written whole to a temporary file at `0600` and renamed over the old one.
fn write(file: &Path, saved: &Saved) -> Result<(), Error> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt as _;

    let failed = |error| Error::Unwritable(file.to_owned(), error);
    let text = toml::to_string(saved).map_err(|error| failed(std::io::Error::other(error)))?;
    let dir = file.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir).map_err(failed)?;
    let temp = dir.join(TEMP);
    let _ = std::fs::remove_file(&temp);
    let mut out = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)
        .map_err(failed)?;
    out.write_all(text.as_bytes()).map_err(failed)?;
    out.sync_all().map_err(failed)?;
    std::fs::rename(&temp, file).map_err(failed)
}

fn sign_in(state: &mut Held, passkey: &str, device: &str, now: u64) -> (String, Session) {
    let token = token();
    state.saved.sessions.retain(|s| s.ends > now);
    let session = Session {
        id: id(),
        passkey: passkey.to_owned(),
        device: device.to_owned(),
        hash: hash(&token),
        made: now,
        ends: now + SESSION_LIFE,
    };
    state.saved.sessions.push(session.clone());
    (token, session)
}

fn end(state: &mut Held, id: &str) {
    if let Some(sender) = state.ended.remove(id) {
        sender.send_replace(true);
    }
}

fn ceremony(state: &mut Held, now: u64, ceremony: Ceremony) -> String {
    state
        .ceremonies
        .retain(|_, (made, _)| *made + CEREMONY_LIFE > now);
    let id = id();
    state.ceremonies.insert(id.clone(), (now, ceremony));
    id
}

fn take_ceremony(state: &mut Held, id: &str, now: u64) -> Option<Ceremony> {
    let (made, ceremony) = state.ceremonies.remove(id)?;
    (made + CEREMONY_LIFE > now).then_some(ceremony)
}

fn device_name(name: &str) -> Result<String, Error> {
    let name = name.trim();
    let usable =
        !name.is_empty() && name.chars().count() <= 40 && !name.chars().any(char::is_control);
    usable.then(|| name.to_owned()).ok_or(Error::BadName)
}

/// SHA-256 in hex.
fn hash(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// A failed `getrandom` aborts: an authoriser with no randomness must not
/// hand out a guessable token.
#[allow(clippy::expect_used)]
fn random<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).expect("the kernel's random source answers");
    bytes
}

/// 32 random bytes, URL-safe base64 with no padding (decision 4).
fn token() -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random::<32>())
}

fn id() -> String {
    random::<8>()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Eight characters from [`ALPHABET`], drawn without bias.
fn code() -> String {
    let limit = (256 / ALPHABET.len() * ALPHABET.len()) as u8;
    let mut code = String::with_capacity(CODE_LENGTH);
    while code.len() < CODE_LENGTH {
        for byte in random::<16>() {
            if byte < limit && code.len() < CODE_LENGTH {
                code.push(ALPHABET[byte as usize % ALPHABET.len()] as char);
            }
        }
    }
    code
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs())
}

/// The `Set-Cookie` value for `token`, with all five attributes.
pub fn cookie(token: &str) -> String {
    format!("{COOKIE}={token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age={SESSION_LIFE}")
}

/// The `Set-Cookie` value that clears the cookie.
pub fn cleared() -> String {
    format!("{COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0")
}

/// The session token in a `Cookie` header, if any.
pub fn token_in(headers: &axum::http::HeaderMap) -> Option<&str> {
    headers
        .get_all(axum::http::header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .find_map(|pair| {
            let (name, value) = pair.trim().split_once('=')?;
            (name == COOKIE && !value.is_empty()).then_some(value)
        })
}

/// The token in `Authorization: Bearer <token>`, if any.
pub fn bearer(headers: &axum::http::HeaderMap) -> Option<&str> {
    let value = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    let (scheme, token) = value.split_once(' ')?;
    (scheme.eq_ignore_ascii_case("bearer") && !token.trim().is_empty()).then(|| token.trim())
}

/// The sign-in routes (decisions 1 to 4, 9 and 13). The gate in `write.rs`
/// lets the four ceremony halves through unchecked; every other route here
/// needs the owner.
pub fn router<I, S>(authoriser: Authoriser<I>, fleet: Fleet) -> Router<S>
where
    I: Inventory + Clone + Send + Sync + 'static,
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/passkey", get(listed::<I>))
        .route("/passkey/code", post(enrol_code::<I>))
        .route("/passkey/{name}", delete(removed::<I>))
        .route("/passkey/register/start", post(register_start::<I>))
        .route("/passkey/register/finish", post(register_finish::<I>))
        .route("/passkey/login/start", post(login_start::<I>))
        .route("/passkey/login/finish", post(login_finish::<I>))
        .route("/sessions/{id}", delete(revoked::<I>))
        .route("/sessions/revoke-others", post(revoked_others::<I>))
        .route("/join/code", post(join_code::<I>))
        .with_state(Signing { authoriser, fleet })
}

#[derive(Clone)]
struct Signing<I> {
    authoriser: Authoriser<I>,
    fleet: Fleet,
}

impl<I: Inventory> Signing<I> {
    fn passkeys(&self) -> &Passkeys {
        self.authoriser.passkeys()
    }

    /// The relying party for the hub's MagicDNS name, from the last tailnet look.
    async fn relying(&self) -> Result<Arc<Relying>, Refused> {
        let name = {
            let model = self.fleet.model.read().await;
            crate::api::this_node_name(&model, &self.fleet.facts.listening_on).map(str::to_owned)
        };
        let name = name.ok_or_else(|| {
            Refused::Unlooked("the hub does not know its MagicDNS name yet".to_owned())
        })?;
        self.passkeys().relying(&name).map_err(refused)
    }
}

fn refused(error: Error) -> Refused {
    let status = match &error {
        Error::WrongCode | Error::Unknown => StatusCode::UNAUTHORIZED,
        Error::NoCeremony | Error::BadName | Error::Webauthn(_) => StatusCode::BAD_REQUEST,
        Error::Taken(_) => StatusCode::CONFLICT,
        Error::Relying(_) => StatusCode::SERVICE_UNAVAILABLE,
        Error::Unwritable(..) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    Refused::Verb {
        status,
        said: chain(&error),
    }
}

#[derive(Debug, serde::Serialize)]
struct Code {
    code: String,
    /// Seconds.
    expires_in: u64,
}

async fn enrol_code<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Signing<I>>,
    ConnectInfo(from): ConnectInfo<Peer>,
    headers: HeaderMap,
) -> Result<Json<Code>, Refused> {
    let caller = allowed(&state.authoriser, &from, &headers).await?;
    tracing::info!("an enrolment code for {}", caller.node);
    Ok(Json(Code {
        code: state.passkeys().enrol_code(),
        expires_in: state.passkeys().0.code_life,
    }))
}

#[derive(Debug, serde::Serialize)]
struct JoinCode {
    code: String,
    expires_in: u64,
    /// What the owner pastes on the new machine.
    command: String,
}

async fn join_code<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Signing<I>>,
    ConnectInfo(from): ConnectInfo<Peer>,
    headers: HeaderMap,
) -> Result<Json<JoinCode>, Refused> {
    allowed(&state.authoriser, &from, &headers).await?;
    let origin = crate::write::dashboard_origin(&state.fleet)
        .await
        .ok_or_else(|| {
            Refused::Unlooked("the hub does not know its MagicDNS name yet".to_owned())
        })?;
    let code = state.passkeys().join_code();
    Ok(Json(JoinCode {
        command: format!("curl -fsSL '{origin}/join?code={code}' | sh"),
        code,
        expires_in: state.passkeys().0.code_life,
    }))
}

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct EnrolStart {
    code: String,
    device: String,
}

#[derive(Debug, serde::Deserialize, Default)]
#[serde(deny_unknown_fields, default)]
struct SignInStart {
    device: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Finish<T> {
    ceremony: String,
    credential: T,
}

#[derive(Debug, serde::Serialize)]
struct Begun<T> {
    ceremony: String,
    options: T,
}

#[derive(Debug, serde::Serialize)]
struct Shown {
    id: String,
    passkey: String,
    device: String,
    made: u64,
    ends: u64,
    this_device: bool,
}

impl Shown {
    fn of(session: Session, this: Option<&str>) -> Self {
        Self {
            this_device: this == Some(session.id.as_str()),
            id: session.id,
            passkey: session.passkey,
            device: session.device,
            made: session.made,
            ends: session.ends,
        }
    }
}

async fn register_start<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Signing<I>>,
    Json(asked): Json<EnrolStart>,
) -> Result<Json<Begun<CreationChallengeResponse>>, Refused> {
    let relying = state.relying().await?;
    let (ceremony, options) = state
        .passkeys()
        .enrol_start(&relying, &asked.code, &asked.device)
        .map_err(refused)?;
    Ok(Json(Begun { ceremony, options }))
}

async fn register_finish<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Signing<I>>,
    Json(asked): Json<Finish<RegisterPublicKeyCredential>>,
) -> Result<Response, Refused> {
    let relying = state.relying().await?;
    let (token, session) = state
        .passkeys()
        .enrol_finish(&relying, &asked.ceremony, &asked.credential)
        .map_err(refused)?;
    tracing::info!("enrolled the passkey {}", session.passkey);
    Ok(signed_in(&token, session))
}

async fn login_start<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Signing<I>>,
    asked: Option<Json<SignInStart>>,
) -> Result<Json<Begun<RequestChallengeResponse>>, Refused> {
    let relying = state.relying().await?;
    let asked = asked.map(|Json(asked)| asked).unwrap_or_default();
    let (ceremony, options) = state
        .passkeys()
        .sign_in_start(&relying, asked.device.as_deref())
        .map_err(refused)?;
    Ok(Json(Begun { ceremony, options }))
}

async fn login_finish<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Signing<I>>,
    Json(asked): Json<Finish<PublicKeyCredential>>,
) -> Result<Response, Refused> {
    let relying = state.relying().await?;
    let (token, session) = state
        .passkeys()
        .sign_in_finish(&relying, &asked.ceremony, &asked.credential)
        .map_err(refused)?;
    tracing::info!("{} signed in with {}", session.device, session.passkey);
    Ok(signed_in(&token, session))
}

fn signed_in(token: &str, session: Session) -> Response {
    (
        [(header::SET_COOKIE, cookie(token))],
        Json(serde_json::json!({"session": Shown::of(session.clone(), Some(&session.id))})),
    )
        .into_response()
}

/// The owner, and the session this request carries, if any.
async fn owner<I: Inventory>(
    state: &Signing<I>,
    from: &Peer,
    headers: &HeaderMap,
) -> Result<Option<Session>, Refused> {
    match identify(&state.authoriser, from, headers).await? {
        Who::Owner(_, session) => Ok(session),
        Who::Agent { .. } => Err(Refused::AgentScope),
    }
}

async fn listed<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Signing<I>>,
    ConnectInfo(from): ConnectInfo<Peer>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Refused> {
    let this = owner(&state, &from, &headers).await?;
    let this = this.as_ref().map(|session| session.id.as_str());
    let relying = state.relying().await.ok();
    let (keys, sessions) = state.passkeys().list();
    Ok(Json(serde_json::json!({
        "relying_party": relying.map(|relying| relying.id.clone()),
        "passkeys": keys
            .into_iter()
            .map(|(name, made)| serde_json::json!({"name": name, "made": made}))
            .collect::<Vec<_>>(),
        "sessions": sessions
            .into_iter()
            .map(|session| Shown::of(session, this))
            .collect::<Vec<_>>(),
    })))
}

async fn removed<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Signing<I>>,
    ConnectInfo(from): ConnectInfo<Peer>,
    headers: HeaderMap,
    Route(name): Route<String>,
) -> Result<Response, Refused> {
    let this = owner(&state, &from, &headers).await?;
    if !state.passkeys().remove(&name).map_err(refused)? {
        return Err(not_found(format!("no passkey is named {name}")));
    }
    tracing::info!("removed the passkey {name} and its sessions");
    let mine = this.is_some_and(|session| session.passkey == name);
    Ok(gone(mine))
}

async fn revoked<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Signing<I>>,
    ConnectInfo(from): ConnectInfo<Peer>,
    headers: HeaderMap,
    Route(id): Route<String>,
) -> Result<Response, Refused> {
    let this = owner(&state, &from, &headers).await?;
    if !state.passkeys().revoke(&id).map_err(refused)? {
        return Err(not_found(format!("no session has the id {id}")));
    }
    tracing::info!("revoked the session {id}");
    Ok(gone(this.is_some_and(|session| session.id == id)))
}

async fn revoked_others<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Signing<I>>,
    ConnectInfo(from): ConnectInfo<Peer>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Refused> {
    let this = owner(&state, &from, &headers).await?;
    let keep = this.map(|session| session.id).unwrap_or_default();
    let ended = state.passkeys().revoke_others(&keep).map_err(refused)?;
    tracing::info!("signed out {ended} other sessions");
    Ok(Json(serde_json::json!({"revoked": ended})))
}

/// 204, and the cookie cleared when the session ended was this one.
fn gone(mine: bool) -> Response {
    if mine {
        (StatusCode::NO_CONTENT, [(header::SET_COOKIE, cleared())]).into_response()
    } else {
        StatusCode::NO_CONTENT.into_response()
    }
}

fn not_found(said: String) -> Refused {
    Refused::Verb {
        status: StatusCode::NOT_FOUND,
        said,
    }
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::unwrap_used)]
pub(crate) mod tests {
    use super::*;
    use webauthn_authenticator_rs::WebauthnAuthenticator;
    use webauthn_authenticator_rs::softpasskey::SoftPasskey;

    pub(crate) const HUB: &str = "hub.example.ts.net";

    pub(crate) fn origin() -> Url {
        Url::parse(&format!("https://{HUB}:8443")).expect("an origin")
    }

    fn scratch(label: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("yantrad-passkey-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join(FILE)
    }

    /// Enrols one soft passkey named `name` and returns its token.
    pub(crate) fn enrolled(passkeys: &Passkeys, name: &str) -> (SoftPasskey, String, Session) {
        let relying = passkeys.relying(HUB).expect("a usable name");
        let code = passkeys.enrol_code();
        let (id, challenge) = passkeys
            .enrol_start(&relying, &code, name)
            .expect("an open code");
        let mut soft = SoftPasskey::new(true);
        let credential = soft
            .do_registration(origin(), challenge)
            .expect("the soft authenticator registers");
        let (token, session) = passkeys
            .enrol_finish(&relying, &id, &credential)
            .expect("the passkey verifies");
        (soft, token, session)
    }

    #[test]
    fn an_enrolment_signs_in_and_the_token_names_its_session() {
        let passkeys = Passkeys::memory();
        let (_, token, session) = enrolled(&passkeys, "iPhone");

        assert_eq!(passkeys.session(&token), Some(session.clone()));
        assert_eq!(session.ends - session.made, SESSION_LIFE);
        assert_eq!(session.passkey, "iPhone");
    }

    #[test]
    fn a_forged_token_and_the_stored_hash_are_refused() {
        let passkeys = Passkeys::memory();
        let (_, token, _) = enrolled(&passkeys, "iPhone");

        assert!(passkeys.session(&super::token()).is_none());
        assert!(passkeys.session(&hash(&token)).is_none());
        assert!(passkeys.session("").is_none());
    }

    #[test]
    fn an_expired_session_is_refused_and_dropped() {
        let passkeys = Passkeys::memory();
        let (_, token, session) = enrolled(&passkeys, "iPhone");

        assert!(passkeys.session_at(&token, session.ends).is_none());
        assert!(passkeys.session(&token).is_none(), "it is gone, not hidden");
    }

    #[test]
    fn a_sign_in_with_the_enrolled_passkey_makes_a_second_session() {
        let passkeys = Passkeys::memory();
        let (mut soft, first, _) = enrolled(&passkeys, "iPhone");
        let relying = passkeys.relying(HUB).expect("a usable name");

        let (id, challenge) = passkeys
            .sign_in_start(&relying, Some("Mac"))
            .expect("a passkey is enrolled");
        let answer = soft
            .do_authentication(origin(), challenge)
            .expect("the soft authenticator signs");
        let (second, session) = passkeys
            .sign_in_finish(&relying, &id, &answer)
            .expect("the assertion verifies");

        assert_eq!(session.device, "Mac");
        assert_ne!(first, second);
        assert!(passkeys.session(&first).is_some() && passkeys.session(&second).is_some());
        assert!(
            passkeys.sign_in_finish(&relying, &id, &answer).is_err(),
            "a ceremony is used once"
        );
    }

    #[test]
    fn a_code_is_used_once() {
        let mut codes = Codes::default();
        let code = codes.make(0, CODE_LIFE);

        assert_eq!(code.len(), CODE_LENGTH);
        assert!(code.bytes().all(|byte| ALPHABET.contains(&byte)));
        assert!(codes.take(&code.to_lowercase(), 1), "case does not matter");
        assert!(!codes.take(&code, 2));
    }

    #[test]
    fn a_code_expires_after_ten_minutes() {
        let mut codes = Codes::default();
        let code = codes.make(0, CODE_LIFE);

        assert!(codes.check(&code, CODE_LIFE - 1));
        assert!(!codes.take(&code, CODE_LIFE));
    }

    #[test]
    fn five_wrong_codes_in_a_row_void_every_open_code() {
        let mut codes = Codes::default();
        let (one, two) = (codes.make(0, CODE_LIFE), codes.make(0, CODE_LIFE));
        for _ in 0..4 {
            assert!(!codes.check("WRONGONE", 1));
        }
        assert!(codes.check(&one, 1), "four wrong do not");
        for _ in 0..5 {
            assert!(!codes.check("WRONGONE", 1));
        }

        assert!(!codes.take(&one, 1));
        assert!(!codes.take(&two, 1));
    }

    #[test]
    fn a_join_code_joins_once_and_then_names_only_the_node_that_took_it() {
        let passkeys = Passkeys::memory();
        let code = passkeys.join_code();

        assert!(!passkeys.joined(&code, "nMAC"), "not taken yet");
        assert!(passkeys.take_join(&code, "nMAC"));
        assert!(!passkeys.take_join(&code, "nMAC"), "used once");
        assert!(passkeys.joined(&code, "nMAC"));
        assert!(!passkeys.joined(&code, "nOTHER"));
        assert!(
            !passkeys.take_join(&passkeys.enrol_code(), "nMAC"),
            "kinds differ"
        );
    }

    #[test]
    fn a_wrong_code_cannot_start_an_enrolment() {
        let passkeys = Passkeys::memory();
        let relying = passkeys.relying(HUB).expect("a usable name");

        assert!(matches!(
            passkeys.enrol_start(&relying, "AAAAAAAA", "iPhone"),
            Err(Error::WrongCode)
        ));
    }

    #[test]
    fn removing_a_passkey_revokes_its_sessions_and_closes_their_sockets() {
        let passkeys = Passkeys::memory();
        let (_, token, session) = enrolled(&passkeys, "iPhone");
        let ended = passkeys.ended(&session.id);

        assert!(passkeys.remove("iPhone").expect("in memory"));

        assert!(passkeys.session(&token).is_none());
        assert!(*ended.borrow());
    }

    #[test]
    fn sign_out_everywhere_else_keeps_this_session() {
        let passkeys = Passkeys::memory();
        let (mut soft, here, kept) = enrolled(&passkeys, "iPhone");
        let relying = passkeys.relying(HUB).expect("name");
        let (id, challenge) = passkeys.sign_in_start(&relying, None).expect("enrolled");
        let answer = soft.do_authentication(origin(), challenge).expect("signs");
        let (there, _) = passkeys.sign_in_finish(&relying, &id, &answer).expect("ok");

        assert_eq!(passkeys.revoke_others(&kept.id).expect("in memory"), 1);

        assert!(passkeys.session(&here).is_some());
        assert!(passkeys.session(&there).is_none());
    }

    #[test]
    fn an_agent_token_ends_when_it_is_dropped() {
        let passkeys = Passkeys::memory();
        let minted = passkeys.mint_agent("web");
        let token = minted.token.clone();

        assert_eq!(passkeys.agent(&token).as_deref(), Some("web"));
        assert!(passkeys.session(&token).is_none(), "it is not a session");
        drop(minted);
        assert!(passkeys.agent(&token).is_none());
    }

    #[test]
    fn the_file_is_0600_and_holds_hashes_and_never_a_token() {
        use std::os::unix::fs::PermissionsExt as _;

        let file = scratch("file");
        let passkeys = Passkeys::open(file.clone());
        let (_, token, _) = enrolled(&passkeys, "iPhone");

        let text = std::fs::read_to_string(&file).expect("written");
        let mode = std::fs::metadata(&file)
            .expect("there")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        assert!(!text.contains(&token));
        assert!(text.contains(&hash(&token)));

        let again = Passkeys::open(file);
        assert!(
            again.session(&token).is_some(),
            "a restart keeps the session"
        );
        assert_eq!(again.list().0.len(), 1);
    }

    #[test]
    fn the_cookie_carries_all_five_attributes() {
        let cookie = cookie("abc");

        assert!(cookie.starts_with("__Host-yantra_session=abc; "));
        for attribute in [
            "Secure",
            "HttpOnly",
            "SameSite=Strict",
            "Path=/",
            "Max-Age=2592000",
        ] {
            assert!(
                cookie.split("; ").any(|part| part == attribute),
                "{attribute}"
            );
        }
    }

    #[test]
    fn the_token_is_read_from_among_other_cookies() {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(
            axum::http::header::COOKIE,
            "a=b; __Host-yantra_session=tok; c=d"
                .parse()
                .expect("a header"),
        );

        assert_eq!(token_in(&headers), Some("tok"));
    }
}
