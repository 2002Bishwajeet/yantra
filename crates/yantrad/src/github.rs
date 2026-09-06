//! The GitHub grant this daemon holds, in memory and live
//! ([ADR-0023](../../../docs/adr/0023-the-github-grant-lives-beside-the-relay.md) §3).
//!
//! Set from the environment at start, replaced the moment a device flow the
//! daemon ran completes, and gone on logout. **The token never leaves this
//! process** (§4): no route serves it, and the one thing written is the line
//! in `/etc/yantra/daemon.env` that brings it back at the next start.

use std::sync::Arc;

use tokio::sync::{Notify, RwLock};
use yantra_core::attention::{Attention, Forge};
use yantra_core::github::{self, Device, Error, Github, Token};
use yantra_core::notify;

/// What is known about the grant. `login` is learned from `GET /user` — by
/// the sign-in that made the grant, or by the readiness look for one that
/// came from the environment — so it can lag the token by one look.
#[derive(Debug, Clone, Default)]
pub struct Held {
    pub token: Option<Token>,
    pub login: Option<String>,
    pub scopes: Vec<String>,
    /// A device flow is waiting for a code to be entered at github.com.
    pub pending: bool,
}

/// Beside the beats rather than inside the snapshot, for the same reason they
/// are: it is neither a look this daemon took nor a beat a machine sent. The
/// `Notify` wakes the looks that read GitHub, so a sign-in shows its
/// repositories now rather than at the next five-minute tick.
#[derive(Debug, Clone, Default)]
pub struct Grant {
    held: Arc<RwLock<Held>>,
    changed: Arc<Notify>,
}

impl Grant {
    /// `YANTRA_GITHUB_TOKEN`, which the unit's `EnvironmentFile=` put there.
    pub fn from_env() -> Self {
        Self::holding(github::from_env())
    }

    pub fn holding(token: Option<Token>) -> Self {
        Self {
            held: Arc::new(RwLock::new(Held {
                token,
                ..Held::default()
            })),
            changed: Arc::default(),
        }
    }

    pub async fn read(&self) -> Held {
        self.held.read().await.clone()
    }

    pub async fn token(&self) -> Option<Token> {
        self.held.read().await.token.clone()
    }

    /// Resolves when the grant is set or cleared. A waiter must already be
    /// waiting to be woken, which the looks are for all but the moment they
    /// are looking.
    pub async fn changed(&self) {
        self.changed.notified().await;
    }

    /// The readiness look learned the login of a grant that came from the
    /// environment.
    pub async fn learned(&self, login: String) {
        self.held.write().await.login = Some(login);
    }

    /// `false` when a flow is already waiting — a second code would race the
    /// first for the same file.
    pub async fn begin(&self) -> bool {
        let mut held = self.held.write().await;
        if held.pending {
            return false;
        }
        held.pending = true;
        true
    }

    async fn set(&self, grant: github::Grant, login: String) {
        *self.held.write().await = Held {
            token: Some(grant.token),
            login: Some(login),
            scopes: grant.scopes,
            pending: false,
        };
        self.changed.notify_waiters();
    }

    async fn abandon(&self) {
        self.held.write().await.pending = false;
    }

    pub async fn clear(&self) {
        *self.held.write().await = Held::default();
        self.changed.notify_waiters();
    }
}

/// The daemon's [`Forge`]: the grant as it is at the moment of the look, so a
/// sign-in or a logout changes the next reading rather than the next daemon.
impl Forge for Grant {
    async fn attention(&self) -> Result<Attention, Error> {
        let token = self.token().await.ok_or(Error::NoGrant)?;
        Github::default().attention(&token).await
    }
}

/// The rest of the flow after the code was shown: poll, learn the login,
/// write the line, set the grant. Spawned by `write.rs` and run by nothing
/// else. **The grant is live whether or not the write succeeded** (ADR-0023
/// §3): the person finished the sign-in on their phone, and a file the daemon
/// could not write is a fault for the journal, not a reason to make them do
/// it again.
pub async fn sign_in(grant: Grant, client_id: String, device: Device) {
    let api = Github::default();
    let outcome = async {
        let got = api.wait(&client_id, &device).await?;
        let login = api.login_name(&got.token).await?;
        Ok::<_, Error>((got, login))
    }
    .await;
    match outcome {
        Ok((got, login)) => {
            let file = std::path::Path::new(notify::RELAY_FILE);
            match notify::write_github(file, Some(&got.token)) {
                Ok(()) => tracing::info!("github grant for {login} written to {}", file.display()),
                Err(error) => tracing::warn!(
                    "github grant for {login} is live and was not written to {}: {error}",
                    file.display()
                ),
            }
            grant.set(got, login).await;
        }
        Err(error) => {
            tracing::warn!("github sign-in did not complete: {error}");
            grant.abandon().await;
        }
    }
}

#[cfg(test)]
// `expect` in a test is a deliberate abort with a message; the workspace lint
// targets the daemon, where the same call would take it down.
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    fn token() -> Token {
        Token::new("gho_notarealtoken".to_owned())
    }

    /// One flow at a time: the second `begin` is refused until the first is
    /// set, abandoned or cleared.
    #[tokio::test]
    async fn a_second_sign_in_waits_for_the_first() {
        let grant = Grant::default();
        assert!(grant.begin().await);
        assert!(!grant.begin().await);

        grant.abandon().await;
        assert!(grant.begin().await);

        grant.clear().await;
        assert!(!grant.read().await.pending);
    }

    /// A waiter already waiting is woken by a set and by a clear, which is
    /// what turns a sign-in into a repository list now rather than in five
    /// minutes.
    #[tokio::test]
    async fn setting_or_clearing_the_grant_wakes_a_waiting_look() {
        let grant = Grant::default();
        let waiter = grant.clone();
        let woken = tokio::spawn(async move { waiter.changed().await });
        tokio::task::yield_now().await;

        grant
            .set(
                github::Grant {
                    token: token(),
                    scopes: vec!["repo".to_owned()],
                },
                "octocat".to_owned(),
            )
            .await;

        tokio::time::timeout(std::time::Duration::from_secs(1), woken)
            .await
            .expect("woken within a second")
            .expect("the waiter did not panic");
        let held = grant.read().await;
        assert_eq!(held.login.as_deref(), Some("octocat"));
        assert_eq!(held.scopes, ["repo"]);
        assert!(!held.pending);

        let waiter = grant.clone();
        let woken = tokio::spawn(async move { waiter.changed().await });
        tokio::task::yield_now().await;
        grant.clear().await;
        tokio::time::timeout(std::time::Duration::from_secs(1), woken)
            .await
            .expect("woken within a second")
            .expect("the waiter did not panic");
        assert!(grant.token().await.is_none());
    }

    /// A grant with no token is a failed look carrying the remedy, never an
    /// empty inbox (R-23).
    #[tokio::test]
    async fn no_grant_is_a_failed_look_that_names_the_login() {
        let failure = Grant::default()
            .attention()
            .await
            .expect_err("nothing to ask with");
        assert!(matches!(failure, Error::NoGrant), "{failure}");
        assert!(failure.to_string().contains("yantra github login"));
    }

    /// The whole `Held` prints without the token: a derived `Debug` on the
    /// struct that holds it is exactly the log line §B4 is about.
    #[test]
    fn the_held_grant_never_prints_its_token() {
        let held = Held {
            token: Some(token()),
            ..Held::default()
        };
        let printed = format!("{held:?}");
        assert!(!printed.contains("gho_"), "{printed}");
    }
}
