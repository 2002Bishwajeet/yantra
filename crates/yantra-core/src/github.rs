//! GitHub, read with the grant this process holds
//! ([ADR-0023](../../../docs/adr/0023-the-github-grant-lives-beside-the-relay.md)).
//!
//! **The token is an OAuth App token from the device flow**: it does not
//! expire, it issues no refresh token, and it is the one credential a daemon
//! that restarts can hold without a timer (R13 §2.1). [`Token`] never prints
//! itself, no error below carries it, and nothing here writes it anywhere —
//! [`crate::notify::write_github`] is the one place it lands on disk.
//!
//! **The OAuth App is the owner's.** Its client id is not a secret, and the
//! device flow needs no client secret, so [`client_id`] is read from the
//! environment with a build-time default and the flow refuses when neither
//! names one.
//!
//! Every send is blocking and runs on a blocking thread, because the caller's
//! runtime is serving terminals on its workers (I-13).

use std::fmt;
use std::time::{Duration, Instant};

use crate::attention::{Attention, Forge, Item};

/// The variable the daemon reads the grant from, and the one
/// `/etc/yantra/daemon.env` carries it under.
pub const TOKEN: &str = "YANTRA_GITHUB_TOKEN";
/// The OAuth App's client id. A build may bake one in; the environment wins.
pub const CLIENT_ID: &str = "YANTRA_GITHUB_CLIENT_ID";
/// ADR-0023 §1: what the grant asks for, and nothing wider without a new consent.
pub const SCOPES: &str = "repo read:org notifications";

const TIMEOUT: Duration = Duration::from_secs(15);
/// What GitHub asks a poller to add to its interval on `slow_down`.
const SLOW_DOWN: Duration = Duration::from_secs(5);
/// `gh search` capped here too: a person triaging does not scroll past thirty.
const SEARCH_LIMIT: &str = "30";
/// Enough for 3000 repositories; a `Link` chain that never ends is a bug, not a
/// fleet.
const MAX_PAGES: usize = 30;

/// The grant. Its `Debug` is hand-written so a derived one on any struct that
/// holds it cannot put the value in a log line.
#[derive(Clone, PartialEq, Eq)]
pub struct Token(String);

impl Token {
    pub fn new(value: String) -> Self {
        Self(value)
    }

    pub(crate) fn reveal(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<token>")
    }
}

/// [`TOKEN`] from the environment, and from nowhere else. An empty value is no
/// grant: `logout` removes the line rather than blanking it, but a hand edit
/// might not.
pub fn from_env() -> Option<Token> {
    std::env::var(TOKEN)
        .ok()
        .filter(|value| !value.is_empty())
        .map(Token)
}

/// The environment first, then whatever the build baked in. `None` is a
/// deployment with no app registered, and every flow refuses on it.
pub fn client_id() -> Option<String> {
    std::env::var(CLIENT_ID)
        .ok()
        .or_else(|| option_env!("YANTRA_GITHUB_CLIENT_ID").map(str::to_owned))
        .filter(|value| !value.is_empty())
}

/// Step 1 of the device flow, as GitHub sends it. `device_code` is what the
/// poll presents and is never served — with the client id it is enough to
/// collect the token — so `Debug` hides it.
#[derive(Clone, PartialEq, Eq, serde::Deserialize)]
pub struct Device {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

impl fmt::Debug for Device {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Device")
            .field("device_code", &"<device code>")
            .field("user_code", &self.user_code)
            .field("verification_uri", &self.verification_uri)
            .field("expires_in", &self.expires_in)
            .field("interval", &self.interval)
            .finish()
    }
}

/// What the flow ends with. `scopes` is GitHub's own list, so a grant made
/// under an older consent reads as what it is.
#[derive(Debug, Clone)]
pub struct Grant {
    pub token: Token,
    pub scopes: Vec<String>,
}

/// One poll's answer. Only the two that keep the loop going are variants; the
/// rest are errors, because the loop cannot continue past them.
#[derive(Debug)]
pub enum Polled {
    Pending,
    SlowDown,
    Granted(Grant),
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct Repo {
    pub full_name: String,
    pub private: bool,
    /// `null` for a repository GitHub has not classified.
    pub language: Option<String>,
    /// RFC 3339 as GitHub sent it; `null` for a repository never pushed to.
    pub pushed_at: Option<String>,
    pub clone_url: String,
    pub default_branch: String,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("no OAuth App client id — set {CLIENT_ID} to the id of the app the owner registered")]
    NoClientId,

    #[error("no GitHub grant — run `yantra github login`")]
    NoGrant,

    #[error(
        "GitHub refused the grant — it was revoked or replaced, so sign in again with `yantra github login`"
    )]
    Refused,

    #[error("the code expired before it was entered at github.com — start again")]
    Expired,

    #[error("the sign-in was refused at github.com")]
    Denied,

    #[error("GitHub refused the device flow: {error}")]
    Rejected { error: String },

    #[error("GitHub answered {status} to {what}")]
    Status { status: u16, what: &'static str },

    #[error("GitHub could not be reached: {reason}")]
    Unreachable { reason: String },

    #[error("could not read {what} from what GitHub sent")]
    Parse {
        what: &'static str,
        #[source]
        source: serde_json::Error,
    },
}

/// Where the two halves of GitHub are. Two hosts because they are two: the
/// device flow is on `github.com` and everything read with the token is on
/// `api.github.com`.
#[derive(Debug, Clone)]
pub struct Github {
    web: String,
    api: String,
}

impl Default for Github {
    fn default() -> Self {
        Self::at("https://github.com", "https://api.github.com")
    }
}

impl Github {
    /// Both halves at another address, which is how the tests put a loopback
    /// listener where GitHub would be.
    pub fn at(web: &str, api: &str) -> Self {
        Self {
            web: web.trim_end_matches('/').to_owned(),
            api: api.trim_end_matches('/').to_owned(),
        }
    }

    /// Step 1: ask for a code the person types at `verification_uri`.
    pub async fn begin(&self, client_id: &str) -> Result<Device, Error> {
        let url = format!("{}/login/device/code", self.web);
        let client_id = client_id.to_owned();
        blocking(move || {
            let mut response = agent()
                .post(&url)
                .header("Accept", "application/json")
                .send_form([("client_id", client_id.as_str()), ("scope", SCOPES)])
                .map_err(unreachable)?;
            let body: serde_json::Value = read_json(&mut response, "the device code")?;
            if let Some(error) = body["error"].as_str() {
                return Err(Error::Rejected {
                    error: error.to_owned(),
                });
            }
            ok(&response, "the device code")?;
            serde_json::from_value(body).map_err(|source| Error::Parse {
                what: "the device code",
                source,
            })
        })
        .await
    }

    /// Step 3, once. [`Self::wait`] is the loop.
    pub async fn poll(&self, client_id: &str, device_code: &str) -> Result<Polled, Error> {
        let url = format!("{}/login/oauth/access_token", self.web);
        let client_id = client_id.to_owned();
        let device_code = device_code.to_owned();
        blocking(move || {
            let mut response = agent()
                .post(&url)
                .header("Accept", "application/json")
                .send_form([
                    ("client_id", client_id.as_str()),
                    ("device_code", device_code.as_str()),
                    ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ])
                .map_err(unreachable)?;
            ok(&response, "the poll")?;
            classify(read_json(&mut response, "the poll")?)
        })
        .await
    }

    /// Polls no faster than GitHub asked until the person has answered, one
    /// way or the other. **A `slow_down` widens the interval and keeps it
    /// widened** — that is the whole of what GitHub asks for it.
    pub async fn wait(&self, client_id: &str, device: &Device) -> Result<Grant, Error> {
        let deadline = Instant::now() + Duration::from_secs(device.expires_in);
        let mut interval = Duration::from_secs(device.interval);
        loop {
            if Instant::now() >= deadline {
                return Err(Error::Expired);
            }
            tokio::time::sleep(interval).await;
            let polled = self.poll(client_id, &device.device_code).await?;
            interval = widened(interval, &polled);
            if let Polled::Granted(grant) = polled {
                return Ok(grant);
            }
        }
    }

    /// `GET /user`'s `login`, which is the one thing about the account that is
    /// shown (ADR-0023 §2). A 401 is [`Error::Refused`]: the grant is gone.
    pub async fn login_name(&self, token: &Token) -> Result<String, Error> {
        let url = format!("{}/user", self.api);
        let token = token.clone();
        blocking(move || {
            let mut response = get(&url, &token, &[]).map_err(unreachable)?;
            ok(&response, "/user")?;
            let user: User = read_json(&mut response, "the account")?;
            Ok(user.login)
        })
        .await
    }

    /// Every repository the account can see, newest push first, following the
    /// `Link` header page by page. `affiliation` is spelled out because the
    /// default omits nothing today and might tomorrow.
    pub async fn repos(&self, token: &Token) -> Result<Vec<Repo>, Error> {
        let first = format!("{}/user/repos", self.api);
        let token = token.clone();
        blocking(move || {
            let mut repos = Vec::new();
            let mut next = Some((
                first,
                vec![
                    ("visibility", "all"),
                    ("affiliation", "owner,collaborator,organization_member"),
                    ("sort", "pushed"),
                    ("per_page", "100"),
                ],
            ));
            let mut pages = 0;
            while let Some((url, query)) = next.take() {
                pages += 1;
                if pages > MAX_PAGES {
                    break;
                }
                let mut response = get(&url, &token, &query).map_err(unreachable)?;
                ok(&response, "/user/repos")?;
                // The `next` URL carries its own query, so nothing is added to it.
                next = next_link(&response).map(|url| (url, Vec::new()));
                let page: Vec<Repo> = read_json(&mut response, "the repository list")?;
                repos.extend(page);
            }
            Ok(repos)
        })
        .await
    }

    /// The work inbox over the REST API. Three independent reads, so they are
    /// three blocking threads rather than one that triples the worst case.
    pub async fn attention(&self, token: &Token) -> Result<Attention, Error> {
        let (reviews, issues, notifications) = tokio::try_join!(
            self.search(token, "is:pr is:open review-requested:@me"),
            self.search(token, "is:issue is:open assignee:@me"),
            self.unread(token),
        )?;
        Ok(Attention {
            reviews,
            issues,
            notifications,
        })
    }

    async fn search(&self, token: &Token, q: &'static str) -> Result<Vec<Item>, Error> {
        let url = format!("{}/search/issues", self.api);
        let token = token.clone();
        blocking(move || {
            let mut response = get(
                &url,
                &token,
                &[("q", q), ("per_page", SEARCH_LIMIT), ("sort", "updated")],
            )
            .map_err(unreachable)?;
            ok(&response, "/search/issues")?;
            let found: Search = read_json(&mut response, "the search")?;
            Ok(found.items.into_iter().map(Item::from).collect())
        })
        .await
    }

    /// A count and never a list (D6 §3.1). One item per page makes the last
    /// page's number the count, and an inbox with no `Link` holds that page's
    /// length, which is zero or one.
    async fn unread(&self, token: &Token) -> Result<u32, Error> {
        let url = format!("{}/notifications", self.api);
        let token = token.clone();
        blocking(move || {
            let mut response = get(&url, &token, &[("per_page", "1")]).map_err(unreachable)?;
            ok(&response, "/notifications")?;
            if let Some(last) = last_page(&response) {
                return Ok(last);
            }
            let page: Vec<serde_json::Value> = read_json(&mut response, "the notifications")?;
            Ok(u32::try_from(page.len()).unwrap_or(u32::MAX))
        })
        .await
    }
}

/// The [`Forge`] for a caller holding one token — the CLI, reading
/// [`from_env`]. The daemon's grant can change under it, so the daemon wraps
/// its own.
#[derive(Debug, Clone)]
pub struct Api {
    pub github: Github,
    pub token: Token,
}

impl Forge for Api {
    async fn attention(&self) -> Result<Attention, Error> {
        self.github.attention(&self.token).await
    }
}

fn widened(interval: Duration, polled: &Polled) -> Duration {
    match polled {
        Polled::SlowDown => interval + SLOW_DOWN,
        Polled::Pending | Polled::Granted(_) => interval,
    }
}

/// GitHub answers the poll with `200` either way and says which in the body,
/// so the eight error names are read here rather than off a status.
fn classify(answer: TokenAnswer) -> Result<Polled, Error> {
    match (answer.error.as_deref(), answer.access_token) {
        (Some("authorization_pending"), _) => Ok(Polled::Pending),
        (Some("slow_down"), _) => Ok(Polled::SlowDown),
        (Some("expired_token"), _) => Err(Error::Expired),
        (Some("access_denied"), _) => Err(Error::Denied),
        (Some(error), _) => Err(Error::Rejected {
            error: error.to_owned(),
        }),
        (None, Some(token)) => Ok(Polled::Granted(Grant {
            token: Token(token),
            scopes: answer
                .scope
                .unwrap_or_default()
                .split(',')
                .filter(|scope| !scope.is_empty())
                .map(str::to_owned)
                .collect(),
        })),
        (None, None) => Err(Error::Rejected {
            error: "an answer naming neither a token nor an error".to_owned(),
        }),
    }
}

/// The poll's body, both shapes. No `deny_unknown_fields`: this is someone
/// else's output, and `error_description` and `error_uri` are deliberately
/// unread — the name is the whole of what is acted on.
#[derive(serde::Deserialize)]
struct TokenAnswer {
    access_token: Option<String>,
    scope: Option<String>,
    error: Option<String>,
}

#[derive(serde::Deserialize)]
struct User {
    login: String,
}

#[derive(serde::Deserialize)]
struct Search {
    items: Vec<Found>,
}

/// The five fields the inbox draws, and no more — `body`, `user` and `labels`
/// are in the same answer and not naming them is how they never reach a log.
#[derive(serde::Deserialize)]
struct Found {
    number: u64,
    title: String,
    html_url: String,
    updated_at: String,
    /// `https://api.github.com/repos/{owner}/{name}`; the search answer has no
    /// `full_name` of its own.
    repository_url: String,
}

impl From<Found> for Item {
    fn from(found: Found) -> Self {
        let repo = found
            .repository_url
            .split_once("/repos/")
            .map_or(found.repository_url.as_str(), |(_, rest)| rest)
            .to_owned();
        Self {
            repo,
            number: found.number,
            title: found.title,
            url: found.html_url,
            updated_at: found.updated_at,
        }
    }
}

type Response = ureq::http::Response<ureq::Body>;

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        // Statuses are read here: a 401 is a different answer from a 503.
        .http_status_as_error(false)
        .user_agent("yantra")
        .build()
        .into()
}

fn get(url: &str, token: &Token, query: &[(&str, &str)]) -> Result<Response, ureq::Error> {
    let mut request = agent()
        .get(url)
        .header("Authorization", &format!("Bearer {}", token.reveal()))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28");
    for (key, value) in query {
        request = request.query(key, value);
    }
    request.call()
}

fn ok(response: &Response, what: &'static str) -> Result<(), Error> {
    match response.status().as_u16() {
        200 => Ok(()),
        401 => Err(Error::Refused),
        status => Err(Error::Status { status, what }),
    }
}

fn read_json<T: serde::de::DeserializeOwned>(
    response: &mut Response,
    what: &'static str,
) -> Result<T, Error> {
    let text = response.body_mut().read_to_string().map_err(unreachable)?;
    serde_json::from_str(&text).map_err(|source| Error::Parse { what, source })
}

fn link(response: &Response) -> Option<&str> {
    response.headers().get("link")?.to_str().ok()
}

/// `<url>; rel="next", <url>; rel="last"` — the URL for one relation.
fn rel(header: &str, wanted: &str) -> Option<String> {
    header.split(',').find_map(|part| {
        let (url, params) = part.split_once(';')?;
        params.contains(&format!("rel=\"{wanted}\"")).then(|| {
            url.trim()
                .trim_start_matches('<')
                .trim_end_matches('>')
                .to_owned()
        })
    })
}

fn next_link(response: &Response) -> Option<String> {
    rel(link(response)?, "next")
}

/// The `page=` of `rel="last"`, which with one item per page is the count.
fn last_page(response: &Response) -> Option<u32> {
    let last = rel(link(response)?, "last")?;
    let (_, query) = last.split_once('?')?;
    query
        .split('&')
        .find_map(|pair| pair.strip_prefix("page=")?.parse().ok())
}

fn unreachable(error: ureq::Error) -> Error {
    Error::Unreachable {
        reason: crate::notify::reason(&error),
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, Error> + Send + 'static,
) -> Result<T, Error> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| Error::Unreachable {
            reason: "the request did not finish".to_owned(),
        })?
}

#[cfg(test)]
// `expect` in a test is a deliberate abort with a message; the workspace lint
// targets library code, where the same call would take the daemon down.
#[allow(clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener};
    use std::thread::{self, JoinHandle};

    /// Captured from the documentation's own examples on 2026-08-08 (R13 §3.3).
    const DEVICE: &str = r#"{"device_code":"3584d83530557fdd1f46af8289938c8ef79f9dc5","user_code":"WDJB-MJHT","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}"#;
    const PENDING: &str = r#"{"error":"authorization_pending","error_description":"The authorization request is still pending.","error_uri":"https://docs.github.com/developers/apps/authorizing-oauth-apps#error-codes-for-the-device-flow"}"#;
    const SLOW: &str = r#"{"error":"slow_down","error_description":"Too many requests have been made in the same timeframe.","interval":10}"#;
    const GRANTED: &str = r#"{"access_token":"gho_16C7e42F292c6912E7710c838347Ae178B4a","token_type":"bearer","scope":"repo,read:org,notifications"}"#;

    fn answer(json: &str) -> TokenAnswer {
        serde_json::from_str(json).expect("captured JSON parses")
    }

    #[test]
    fn the_device_code_parses_as_captured() {
        let device: Device = serde_json::from_str(DEVICE).expect("captured JSON parses");
        assert_eq!(device.user_code, "WDJB-MJHT");
        assert_eq!(device.verification_uri, "https://github.com/login/device");
        assert_eq!((device.expires_in, device.interval), (900, 5));
        assert!(
            !format!("{device:?}").contains("3584d835"),
            "the device code is never printed"
        );
    }

    /// The eight names GitHub documents, sorted into the two that continue
    /// and the ones that end the loop.
    #[test]
    fn the_poll_is_classified_by_the_error_name() {
        assert!(matches!(classify(answer(PENDING)), Ok(Polled::Pending)));
        assert!(matches!(classify(answer(SLOW)), Ok(Polled::SlowDown)));
        assert!(matches!(
            classify(answer(r#"{"error":"expired_token"}"#)),
            Err(Error::Expired)
        ));
        assert!(matches!(
            classify(answer(r#"{"error":"access_denied"}"#)),
            Err(Error::Denied)
        ));
        match classify(answer(r#"{"error":"device_flow_disabled"}"#)) {
            Err(Error::Rejected { error }) => assert_eq!(error, "device_flow_disabled"),
            other => panic!("{other:?}"),
        }
        match classify(answer(GRANTED)) {
            Ok(Polled::Granted(grant)) => {
                assert_eq!(
                    grant.token.reveal(),
                    "gho_16C7e42F292c6912E7710c838347Ae178B4a"
                );
                assert_eq!(grant.scopes, ["repo", "read:org", "notifications"]);
                assert!(!format!("{grant:?}").contains("gho_"), "{grant:?}");
            }
            other => panic!("{other:?}"),
        }
    }

    /// GitHub says *add five seconds*, and says it once; the interval stays
    /// widened for every poll after.
    #[test]
    fn slow_down_widens_the_interval_and_pending_keeps_it() {
        let five = Duration::from_secs(5);
        let ten = widened(five, &Polled::SlowDown);
        assert_eq!(ten, Duration::from_secs(10));
        assert_eq!(widened(ten, &Polled::Pending), ten);
        assert_eq!(widened(ten, &Polled::SlowDown), Duration::from_secs(15));
    }

    #[test]
    fn a_link_header_is_read_for_one_relation() {
        let header = r#"<https://api.github.com/user/repos?page=2&per_page=100>; rel="next", <https://api.github.com/user/repos?page=4&per_page=100>; rel="last""#;
        assert_eq!(
            rel(header, "next").as_deref(),
            Some("https://api.github.com/user/repos?page=2&per_page=100")
        );
        assert_eq!(
            rel(header, "last").as_deref(),
            Some("https://api.github.com/user/repos?page=4&per_page=100")
        );
        assert!(rel(header, "prev").is_none());
    }

    #[test]
    fn a_search_hit_names_its_repository_from_the_api_url() {
        let found: Search = serde_json::from_str(
            r#"{"total_count":1,"items":[{"number":54,"title":"feat","html_url":"https://github.com/utopia-php/messaging/pull/54","updated_at":"2024-04-19T15:49:30Z","repository_url":"https://api.github.com/repos/utopia-php/messaging","user":{"login":"someone"}}]}"#,
        )
        .expect("captured JSON parses");
        let item = Item::from(found.items.into_iter().next().expect("one hit"));
        assert_eq!(item.repo, "utopia-php/messaging");
        assert_eq!(item.number, 54);
        assert_eq!(item.url, "https://github.com/utopia-php/messaging/pull/54");
    }

    #[test]
    fn an_empty_client_id_is_no_client_id() {
        assert!(
            client_id().is_none_or(|id| !id.is_empty()),
            "a blank id must never reach the flow"
        );
    }

    /// A bound port, so a scripted reply can name it in a `Link` header
    /// before anything is served.
    fn listen() -> (TcpListener, SocketAddr) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let address = listener.local_addr().expect("the port it got");
        (listener, address)
    }

    /// One scripted reply per connection, in order: a status, extra header
    /// lines, and a JSON body. Plain HTTP on loopback — what is under test is
    /// the request that leaves and how the answer is read, and nothing about
    /// TLS. Returns every request as it arrived.
    fn serve(
        listener: TcpListener,
        replies: Vec<(&'static str, String, String)>,
    ) -> JoinHandle<Vec<String>> {
        thread::spawn(move || {
            let mut seen = Vec::new();
            for (status, headers, body) in replies {
                let (mut stream, _) = listener.accept().expect("a connection");
                let mut request = Vec::new();
                let mut byte = [0u8; 1];
                while !complete(&request) {
                    match stream.read(&mut byte) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => request.push(byte[0]),
                    }
                }
                seen.push(String::from_utf8_lossy(&request).into_owned());
                stream
                    .write_all(
                        format!(
                            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .expect("the answer is written");
            }
            seen
        })
    }

    fn complete(request: &[u8]) -> bool {
        let text = String::from_utf8_lossy(request);
        let Some((headers, body)) = text.split_once("\r\n\r\n") else {
            return false;
        };
        let length = headers
            .lines()
            .find_map(|line| {
                line.to_ascii_lowercase()
                    .strip_prefix("content-length:")?
                    .trim()
                    .parse::<usize>()
                    .ok()
            })
            .unwrap_or(0);
        body.len() >= length
    }

    fn reply(status: &'static str, body: &str) -> (&'static str, String, String) {
        (status, String::new(), body.to_owned())
    }

    fn at(address: SocketAddr) -> Github {
        let base = format!("http://{address}");
        Github::at(&base, &base)
    }

    fn token() -> Token {
        Token::new("gho_notarealtoken".to_owned())
    }

    fn device(expires_in: u64) -> Device {
        Device {
            device_code: "dc".to_owned(),
            user_code: "WDJB-MJHT".to_owned(),
            verification_uri: "https://github.com/login/device".to_owned(),
            expires_in,
            interval: 0,
        }
    }

    /// Step 1 on the wire: the form GitHub documents, the JSON `Accept`
    /// without which it answers URL-encoded, and the scopes ADR-0023 fixes.
    #[tokio::test]
    async fn begin_posts_the_client_id_and_the_three_scopes() {
        let (listener, address) = listen();
        let served = serve(listener, vec![reply("200 OK", DEVICE)]);

        let device = at(address).begin("Iv1.abc").await.expect("a device code");

        assert_eq!(device.user_code, "WDJB-MJHT");
        let request = served.join().expect("the listener thread").remove(0);
        assert!(
            request.starts_with("POST /login/device/code HTTP/1.1\r\n"),
            "{request}"
        );
        assert!(
            request.to_lowercase().contains("accept: application/json"),
            "{request}"
        );
        let body = request.rsplit("\r\n\r\n").next().unwrap_or_default();
        assert!(body.starts_with("client_id=Iv1.abc&scope=repo"), "{body}");
        assert!(body.contains("read%3Aorg"), "{body}");
        assert!(body.ends_with("notifications"), "{body}");
    }

    /// The loop against scripted answers: pending, then the grant — and the
    /// token arrives whole. `slow_down` is not scripted here because it would
    /// cost the five seconds it asks for; [`widened`] has its own test.
    #[tokio::test]
    async fn wait_polls_through_pending_to_the_grant() {
        let (listener, address) = listen();
        let served = serve(
            listener,
            vec![reply("200 OK", PENDING), reply("200 OK", GRANTED)],
        );

        let grant = at(address)
            .wait("Iv1.abc", &device(60))
            .await
            .expect("granted");

        assert_eq!(
            grant.token.reveal(),
            "gho_16C7e42F292c6912E7710c838347Ae178B4a"
        );
        let seen = served.join().expect("the listener thread");
        assert_eq!(seen.len(), 2);
        assert!(
            seen[0].contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code"),
            "{}",
            seen[0]
        );
        assert!(seen[0].contains("device_code=dc"), "{}", seen[0]);
    }

    #[tokio::test]
    async fn a_code_already_past_its_expiry_is_not_polled() {
        let (listener, address) = listen();
        drop(listener);

        let expired = at(address)
            .wait("Iv1.abc", &device(0))
            .await
            .expect_err("nothing is asked");

        assert!(matches!(expired, Error::Expired), "{expired}");
    }

    #[tokio::test]
    async fn a_person_who_refused_ends_the_wait_by_name() {
        let (listener, address) = listen();
        let _served = serve(
            listener,
            vec![reply("200 OK", r#"{"error":"access_denied"}"#)],
        );

        let denied = at(address)
            .wait("Iv1.abc", &device(60))
            .await
            .expect_err("refused");

        assert!(matches!(denied, Error::Denied), "{denied}");
    }

    /// The token goes out as a bearer, the API version is pinned, and `login`
    /// is the one field read.
    #[tokio::test]
    async fn the_login_name_is_read_with_a_bearer_and_a_pinned_api_version() {
        let (listener, address) = listen();
        let served = serve(
            listener,
            vec![reply(
                "200 OK",
                r#"{"login":"octocat","id":1,"email":"octocat@github.com"}"#,
            )],
        );

        let login = at(address).login_name(&token()).await.expect("the login");

        assert_eq!(login, "octocat");
        let request = served.join().expect("the listener thread").remove(0);
        assert!(request.starts_with("GET /user HTTP/1.1\r\n"), "{request}");
        let headers = request.to_lowercase();
        assert!(
            headers.contains("authorization: bearer gho_notarealtoken"),
            "{headers}"
        );
        assert!(
            headers.contains("x-github-api-version: 2022-11-28"),
            "{headers}"
        );
    }

    /// A 401 is GitHub saying the grant is gone, which is a different remedy
    /// from a GitHub that could not be reached (R-23).
    #[tokio::test]
    async fn a_401_is_a_refused_grant_and_a_closed_port_is_unreachable() {
        let (listener, address) = listen();
        let _served = serve(
            listener,
            vec![reply(
                "401 Unauthorized",
                r#"{"message":"Bad credentials"}"#,
            )],
        );
        let refused = at(address).login_name(&token()).await.expect_err("401");
        assert!(matches!(refused, Error::Refused), "{refused}");
        assert!(
            refused.to_string().contains("yantra github login"),
            "{refused}"
        );

        let (listener, gone) = listen();
        drop(listener);
        let unreachable = at(gone)
            .login_name(&token())
            .await
            .expect_err("nothing listens");
        assert!(
            matches!(unreachable, Error::Unreachable { .. }),
            "{unreachable}"
        );
    }

    const PAGE_ONE: &str = r#"[{"full_name":"o/a","private":true,"language":"Rust","pushed_at":"2026-09-01T00:00:00Z","clone_url":"https://github.com/o/a.git","default_branch":"main","size":1}]"#;
    const PAGE_TWO: &str = r#"[{"full_name":"o/b","private":false,"language":null,"pushed_at":null,"clone_url":"https://github.com/o/b.git","default_branch":"master"}]"#;

    /// Two pages joined by `Link`, the second fetched at the URL GitHub named
    /// rather than one rebuilt here — and the query the first page asks for.
    #[tokio::test]
    async fn repos_follow_the_link_header_to_the_last_page() {
        let (listener, address) = listen();
        let link = format!(
            "Link: <http://{address}/user/repos?page=2&per_page=100>; rel=\"next\", <http://{address}/user/repos?page=2&per_page=100>; rel=\"last\"\r\n"
        );
        let served = serve(
            listener,
            vec![
                ("200 OK", link, PAGE_ONE.to_owned()),
                reply("200 OK", PAGE_TWO),
            ],
        );

        let repos = at(address).repos(&token()).await.expect("two pages");

        assert_eq!(
            repos
                .iter()
                .map(|r| r.full_name.as_str())
                .collect::<Vec<_>>(),
            ["o/a", "o/b"]
        );
        assert_eq!(repos[1].language, None);
        assert_eq!(repos[1].pushed_at, None);
        let seen = served.join().expect("the listener thread");
        let first = seen[0].lines().next().unwrap_or_default();
        assert!(
            first.starts_with("GET /user/repos?visibility=all&affiliation=owner"),
            "{first}"
        );
        assert!(first.contains("sort=pushed&per_page=100"), "{first}");
        assert!(
            seen[1].starts_with("GET /user/repos?page=2&per_page=100 HTTP/1.1"),
            "{}",
            seen[1]
        );
    }

    /// The inbox: two searches and a count read off `Link` with one item per
    /// page, so a hundred unread costs one small answer rather than a hundred
    /// titles.
    #[tokio::test]
    async fn attention_is_two_searches_and_a_count_read_off_the_link_header() {
        let (listener, address) = listen();
        let hit = r#"{"total_count":1,"items":[{"number":54,"title":"feat","html_url":"https://github.com/utopia-php/messaging/pull/54","updated_at":"2024-04-19T15:49:30Z","repository_url":"https://api.github.com/repos/utopia-php/messaging"}]}"#;
        let link = format!(
            "Link: <http://{address}/notifications?page=2&per_page=1>; rel=\"next\", <http://{address}/notifications?page=27&per_page=1>; rel=\"last\"\r\n"
        );
        // The three reads run concurrently and arrive in any order, so every
        // reply must answer any of them: the search body serves both queries,
        // and the count reads `Link` without parsing the body at all.
        let answer = || ("200 OK", link.clone(), hit.to_owned());
        let served = serve(listener, vec![answer(), answer(), answer()]);

        let attention = at(address).attention(&token()).await.expect("the inbox");

        let seen = served.join().expect("the listener thread");
        let asked: Vec<&str> = seen
            .iter()
            .map(|r| r.lines().next().unwrap_or_default())
            .collect();
        assert!(
            asked
                .iter()
                .any(|line| line.contains("q=is%3Apr%20is%3Aopen%20review-requested%3A%40me")),
            "{asked:?}"
        );
        assert!(
            asked
                .iter()
                .any(|line| line.contains("q=is%3Aissue%20is%3Aopen%20assignee%3A%40me")),
            "{asked:?}"
        );
        assert!(
            asked
                .iter()
                .any(|line| line.starts_with("GET /notifications?per_page=1")),
            "{asked:?}"
        );
        // Each search got the same one hit; which list it landed in is the
        // query it came from, not the body.
        assert_eq!(attention.reviews.len() + attention.issues.len(), 2);
        assert_eq!(attention.reviews[0].repo, "utopia-php/messaging");
        assert_eq!(attention.notifications, 27);
    }

    /// No `Link` is an inbox that fits on one page of one, so the count is
    /// the page's length: zero or one.
    #[tokio::test]
    async fn an_empty_inbox_counts_zero_from_the_page_itself() {
        let (listener, address) = listen();
        let _served = serve(listener, vec![reply("200 OK", "[]")]);

        let unread = at(address).unread(&token()).await.expect("a count");

        assert_eq!(unread, 0);
    }
}
