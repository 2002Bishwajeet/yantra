//! Launching Claude Code in a session a human can attach to.
//!
//! [ADR-0011] settles the shape: the agent is an ordinary interactive TUI in the
//! tmux session `up` already opens, and **Yantra sends it no input**. That last
//! part is why I-23's trust dialog needs no handling here — the dialog swallows
//! *automated* keystrokes, and there are none. Whoever attaches answers it. The
//! hazard returns the day Yantra drives the agent, and not before.
//!
//! Claude Code only, per the one-agent-first guardrail. The interface to extract
//! comes from a second working implementation, never from guessing ahead of one.
//!
//! [ADR-0011]: ../../../docs/adr/0011-claude-code-runs-as-a-tui-in-tmux.md

use crate::ssh::Exec;
use crate::tmux::sq;

/// Searched in order when `PATH` fails.
///
/// **`$HOME` is in this list, and in [`crate::tmux`]'s deliberately is not.**
/// tmux's reasoning — a `$HOME` install is on `PATH` by construction — is simply
/// false here: Claude Code's installer puts the binary in `~/.local/bin` and
/// puts that directory on `PATH` by editing a shell rc file, which a
/// non-interactive ssh session never reads (**I-34**). Measured on both machines
/// in this fleet: the binary is at `~/.local/bin/claude` on each, and
/// `ssh <mac> 'command -v claude'` answers nothing at all.
const CANDIDATES: [&str; 6] = [
    "$HOME/.local/bin",    // the official install script
    "$HOME/.claude/local", // `claude migrate-installer` leaves it here
    "/opt/homebrew/bin",   // npm global under Homebrew node, Apple Silicon
    "/usr/local/bin",      // npm global, Intel macOS and generic
    "/opt/local/bin",      // MacPorts
    "/usr/bin",            // distro package
];

/// A located `claude` binary and the operations that use it. Holding the path
/// *is* the cache, exactly as in [`crate::tmux::Tmux`] and for the same reason:
/// it lives as long as the connection it was found through.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claude {
    path: String,
}

/// What the far side will run, and the id it will run under.
///
/// The id is chosen here rather than discovered afterwards, which is what makes
/// the transcript path predictable — `claude` writes to
/// `~/.claude/projects/<repo, non-alphanumerics → ->/<session_id>.jsonl`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub session_id: String,
    pub command: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Auth {
    pub logged_in: bool,
    pub method: String,
}

/// Only the two fields Yantra acts on.
///
/// Unknown fields are tolerated because this is someone else's output format,
/// as in [`crate::inventory`] — and here that tolerance is also a privacy
/// boundary. `claude auth status` prints the account's email, org id and org
/// name alongside these two; naming only two fields is how the rest never
/// enters Yantra's memory, its errors, or a log line.
#[derive(Debug, serde::Deserialize)]
struct Status {
    #[serde(rename = "loggedIn")]
    logged_in: bool,
    #[serde(rename = "authMethod", default)]
    auth_method: String,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("claude was not found on PATH or in any of: {searched}")]
    NotFound { searched: String },

    #[error("`claude auth status` on that machine printed something other than its own JSON")]
    Unreadable,

    #[error("claude on that machine is not logged in (auth method: `{method}`)")]
    NotLoggedIn { method: String },

    #[error("could not generate a session id")]
    Random(#[source] std::io::Error),

    #[error(transparent)]
    Ssh(#[from] crate::ssh::Error),
}

impl Claude {
    /// Finds `claude` on the far side in one round trip (I-34).
    pub async fn resolve<E: Exec>(exec: &E) -> Result<Self, Error> {
        // `$HOME` is left unquoted in the loop so the remote shell expands it;
        // every path here is a constant, so there is nothing to inject.
        let probe = format!(
            "p=$(command -v claude 2>/dev/null)\n\
             case \"$p\" in /*) printf '%s\\n' \"$p\"; exit 0 ;; esac\n\
             for d in {dirs}; do\n\
             \x20 [ -x \"$d/claude\" ] && {{ printf '%s\\n' \"$d/claude\"; exit 0; }}\n\
             done\n\
             exit 1\n",
            dirs = CANDIDATES.join(" "),
        );

        let out = exec.exec(&probe).await?;
        let path = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        if out.success() && path.starts_with('/') {
            return Ok(Self { path });
        }
        Err(Error::NotFound {
            searched: CANDIDATES.join(", "),
        })
    }

    pub fn path(&self) -> &str {
        &self.path
    }

    /// Asks the agent whether it can talk to Anthropic at all.
    ///
    /// The JSON is on stdout whether or not it is logged in, and the exit status
    /// is 1 in the negative case — so the status is not what is read here.
    pub async fn auth<E: Exec>(&self, exec: &E) -> Result<Auth, Error> {
        let out = exec
            .exec(&format!("{} auth status", sq(&self.path)))
            .await?;
        let status: Status = serde_json::from_slice(&out.stdout).map_err(|_| Error::Unreadable)?;
        Ok(Auth {
            logged_in: status.logged_in,
            method: status.auth_method,
        })
    }
}

/// Resolve, check, and produce the command the session will run.
///
/// The auth check is a gate rather than a diagnostic, and it earns that by
/// **I-44**: on macOS an agent launched over SSH cannot read the login keychain,
/// so it comes up unauthenticated while looking entirely healthy. Verified
/// against the machine that has the problem — `claude auth status` there answers
/// `loggedIn: false`. Refusing turns a silent useless session into a refusal
/// that names its reason.
pub async fn prepare<E: Exec>(exec: &E, repo: &str) -> Result<Launch, Error> {
    let claude = Claude::resolve(exec).await?;
    let auth = claude.auth(exec).await?;
    if !auth.logged_in {
        return Err(Error::NotLoggedIn {
            method: auth.method,
        });
    }
    let session_id = new_session_id()?;
    Ok(Launch {
        command: launch_command(claude.path(), repo, &session_id),
        session_id,
    })
}

/// `cd` because `claude` has no cwd flag, and `exec` so the pane's process *is*
/// the agent — which is what lets I-4's `remain-on-exit` report how it ended.
///
/// The `cd` is not redundant with tmux's `-c`: `respawn-pane` without `-c` reuses
/// the pane's start directory, and the fleet runs two tmux versions (I-42), so
/// this does not rest on that behaviour being identical in both.
fn launch_command(claude: &str, repo: &str, session_id: &str) -> String {
    format!(
        "cd {} && exec {} --session-id {}",
        sq(repo),
        sq(claude),
        sq(session_id)
    )
}

/// A version-4 UUID, because that is what `--session-id` takes.
fn new_session_id() -> Result<String, Error> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|e| Error::Random(std::io::Error::other(e)))?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex = |r: &[u8]| -> String { r.iter().map(|x| format!("{x:02x}")).collect() };
    Ok(format!(
        "{}-{}-{}-{}-{}",
        hex(&b[0..4]),
        hex(&b[4..6]),
        hex(&b[6..8]),
        hex(&b[8..10]),
        hex(&b[10..16])
    ))
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn a_session_id_is_a_v4_uuid() {
        let id = new_session_id().expect("the OS has entropy");
        assert_eq!(id.len(), 36);
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(
            parts.iter().map(|p| p.len()).collect::<Vec<_>>(),
            [8, 4, 4, 4, 12]
        );
        assert!(id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
        assert!(id[14..15].starts_with('4'), "version nibble: {id}");
        assert!(
            ['8', '9', 'a', 'b'].contains(&id[19..20].chars().next().unwrap_or('z')),
            "variant nibble: {id}"
        );
        assert_ne!(
            id,
            new_session_id().expect("the OS has entropy"),
            "two launches must not share a transcript"
        );
    }

    /// A repo path comes from a config file and reaches a remote shell, so this
    /// is the same trust boundary I-26 drew — not a tidiness check.
    #[test]
    fn a_hostile_repo_path_cannot_break_out_of_the_command() {
        // Asserted as an exact string rather than by hunting for the payload:
        // the correctly-escaped form still *contains* `; rm -rf ~; `, inside
        // quotes, so a substring search cannot tell safe from unsafe. Whether a
        // shell agrees is proved on a real one in `tests/agent.rs`.
        assert_eq!(
            launch_command("/usr/bin/claude", "/tmp/x'; rm -rf ~; '", "an-id"),
            r"cd '/tmp/x'\''; rm -rf ~; '\''' && exec '/usr/bin/claude' --session-id 'an-id'"
        );
    }

    #[test]
    fn the_launch_command_cds_and_execs() {
        let cmd = launch_command("/home/u/.local/bin/claude", "/srv/repo", "abc");
        assert!(cmd.starts_with("cd '/srv/repo' && exec "), "{cmd}");
        assert!(cmd.contains("--session-id 'abc'"), "{cmd}");
    }

    /// The fields Yantra does not name must not arrive with the ones it does.
    #[test]
    fn only_the_two_fields_are_read_and_the_rest_are_dropped() {
        let raw = br#"{"loggedIn":true,"authMethod":"claude.ai","email":"someone@example.com","orgId":"an-org"}"#;
        let status: Status = serde_json::from_slice(raw).expect("real 2.1.220 output parses");
        assert!(status.logged_in);
        assert_eq!(status.auth_method, "claude.ai");
        assert!(
            !format!("{status:?}").contains("example.com"),
            "the account's email must not survive into anything Yantra can print"
        );
    }

    /// Exactly what the MacBook printed over ssh while I-44 was in force.
    #[test]
    fn the_not_logged_in_shape_parses_rather_than_erroring() {
        let raw = br#"{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}"#;
        let status: Status = serde_json::from_slice(raw).expect("the negative case parses too");
        assert!(!status.logged_in);
        assert_eq!(status.auth_method, "none");
    }
}
