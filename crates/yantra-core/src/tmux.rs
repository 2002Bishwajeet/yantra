//! Opening a tmux session on a machine, idempotently.
//!
//! Four invariants converge here and each one is a trap that produces a bug
//! looking like something else:
//!
//! - **I-1** — create with plain `new-session -d` and treat `duplicate session:`
//!   as success. `new-session -A -d` is broken from a non-TTY caller and
//!   `has-session || create` is a TOCTOU race.
//! - **I-2** — session names are `[A-Za-z0-9_-]` only, addressed as `=name`.
//!   A `:` or `.` makes a session permanently unaddressable, and without `=`
//!   targets are prefix-matched, so `demo` can hit `demo2`.
//! - **I-4** — `remain-on-exit on`, or a crashed pane vanishes and "crashed" is
//!   indistinguishable from "finished".
//! - **I-21** — `=name` is a valid target **only for sessions**. For window and
//!   pane targets it fails outright, and `remain-on-exit` is a *window* option.
//!   Ids captured at creation (`@N`, `%N`) are used instead.
//! - **I-34** — never invoke the binary bare. [`Tmux::resolve`] finds an
//!   absolute path once per connection.
//! - **I-40** — never set `default-terminal`. It is a *server* option, so a
//!   per-session `set-option -t` reconfigures every session on the machine.

use crate::ssh::Exec;

/// A live tmux session, addressed by the stable ids captured when it was found
/// rather than by name (I-21).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    pub name: String,
    pub session_id: String,
    pub window_id: String,
    pub pane_id: String,
}

/// Which half of the idempotent open happened. The whole point of `up` is that
/// running it twice produces `Attached`, not a second session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Opened {
    Created(Session),
    Attached(Session),
}

impl Opened {
    pub fn session(&self) -> &Session {
        match self {
            Self::Created(s) | Self::Attached(s) => s,
        }
    }

    pub fn was_created(&self) -> bool {
        matches!(self, Self::Created(_))
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(
        "`{name}` is not a usable tmux session name: only letters, digits, `_` and `-` are allowed (I-2)"
    )]
    InvalidName { name: String },

    #[error("tmux was not found on PATH or in any of: {searched}")]
    NotFound { searched: String },

    /// Found at resolve time, gone now — not the same as never installed.
    #[error("tmux was found at {path} but no longer runs there")]
    Vanished { path: String },

    #[error("tmux `{command}` failed with status {status}: {stderr}")]
    Command {
        command: String,
        status: i32,
        stderr: String,
    },

    #[error("could not parse tmux ids from `{raw}`")]
    Ids { raw: String },

    #[error(transparent)]
    Ssh(#[from] crate::ssh::Error),
}

const IDS: &str = "#{session_id} #{window_id} #{pane_id}";

/// Searched in order when `PATH` fails. System-scoped only — `$HOME` installs
/// are on `PATH` by construction, which is why `PATH` is asked first.
const CANDIDATES: [&str; 7] = [
    "/opt/homebrew/bin",              // Homebrew, Apple Silicon
    "/opt/local/bin",                 // MacPorts
    "/home/linuxbrew/.linuxbrew/bin", // Homebrew on Linux
    "/usr/local/bin",                 // Homebrew on Intel macOS; generic local builds
    "/run/current-system/sw/bin",     // NixOS / nix-darwin system profile
    "/usr/bin",                       // every distro package
    "/bin",                           // pre-usrmerge, and a symlink to /usr/bin after
];

/// A located tmux binary and the operations that use it. Holding the path *is*
/// the cache — it lives as long as the connection, so there is nothing to key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tmux {
    path: String,
}

impl Tmux {
    /// Finds tmux on the far side in one round trip (I-34). Not a login shell:
    /// `sh -lc` answers `NONE` on the machine that raised I-34.
    pub async fn resolve<E: Exec>(exec: &E) -> Result<Self, Error> {
        // `exit` is safe: ADR-0006 runs this in a child shell, so it cannot
        // suppress the sentinel.
        let probe = format!(
            "p=$(command -v tmux 2>/dev/null)\n\
             case \"$p\" in /*) printf '%s\\n' \"$p\"; exit 0 ;; esac\n\
             for d in {dirs}; do\n\
             \x20 [ -x \"$d/tmux\" ] && {{ printf '%s\\n' \"$d/tmux\"; exit 0; }}\n\
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

    /// Opens `name` at `cwd`, running `startup` if the session had to be
    /// created.
    ///
    /// An existing session is left exactly as it is — no re-running of
    /// `startup`, no reset of the working directory. That is what makes a
    /// second `up` safe.
    pub async fn ensure<E: Exec>(
        &self,
        exec: &E,
        name: &str,
        cwd: &str,
        startup: Option<&str>,
    ) -> Result<Opened, Error> {
        validate_name(name)?;

        // Created with the default shell, never with `startup` directly: a
        // startup command that exits at once takes the window, the session and
        // the whole tmux server with it before `remain-on-exit` can be set. A
        // shell does not exit, so the option is in place before anything can
        // die. Measured, not theorised — the obvious one-shot form fails this
        // way.
        let create = format!(
            "{} new-session -d -s {} -c {} -P -F {}",
            sq(&self.path),
            sq(name),
            sq(cwd),
            sq(IDS)
        );

        let out = exec.exec(&create).await?;
        if out.success() {
            let session = parse_ids(name, &out.stdout)?;
            self.set_remain_on_exit(exec, &session).await?;
            if let Some(startup) = startup {
                self.respawn_with(exec, &session, startup).await?;
            }
            return Ok(Opened::Created(session));
        }

        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_owned();
        if !stderr.contains("duplicate session:") {
            // Verified executable at resolve time, so it moved since.
            if stderr.contains("not found") || stderr.contains("No such file") {
                return Err(Error::Vanished {
                    path: self.path.clone(),
                });
            }
            return Err(Error::Command {
                command: "new-session".to_owned(),
                status: out.status,
                stderr,
            });
        }

        // I-1: the duplicate is the success case. The session was already there.
        let query = format!(
            "{} display-message -p -t {} -F {}",
            sq(&self.path),
            sq(&format!("={name}:")),
            sq(IDS)
        );
        let out = exec.exec(&query).await?;
        if !out.success() {
            return Err(Error::Command {
                command: "display-message".to_owned(),
                status: out.status,
                stderr: String::from_utf8_lossy(&out.stderr).trim().to_owned(),
            });
        }
        Ok(Opened::Attached(parse_ids(name, &out.stdout)?))
    }

    /// Kills the session if it exists. Absence is success, not an error.
    pub async fn kill<E: Exec>(&self, exec: &E, name: &str) -> Result<(), Error> {
        validate_name(name)?;
        let out = exec
            .exec(&format!(
                "{} kill-session -t {}",
                sq(&self.path),
                sq(&format!("={name}"))
            ))
            .await?;
        let stderr = String::from_utf8_lossy(&out.stderr);
        // No server at all means no session either, which is the state asked for.
        if out.success() || stderr.contains("can't find session") || no_server(&stderr) {
            return Ok(());
        }
        Err(Error::Command {
            command: "kill-session".to_owned(),
            status: out.status,
            stderr: stderr.trim().to_owned(),
        })
    }

    /// I-4 via I-21: `remain-on-exit` is a *window* option, and a bare `=name`
    /// is not a valid window target — so this uses the `@id` captured at
    /// creation.
    async fn set_remain_on_exit<E: Exec>(&self, exec: &E, session: &Session) -> Result<(), Error> {
        let out = exec
            .exec(&format!(
                "{} set-option -w -t {} remain-on-exit on",
                sq(&self.path),
                sq(&session.window_id)
            ))
            .await?;
        if out.success() {
            Ok(())
        } else {
            Err(Error::Command {
                command: "set-option remain-on-exit".to_owned(),
                status: out.status,
                stderr: String::from_utf8_lossy(&out.stderr).trim().to_owned(),
            })
        }
    }

    /// Replaces the pane's shell with `startup`, so the pane's process *is* the
    /// command and I-4 can report how it ended. `remain-on-exit` is already set
    /// by the time this runs.
    async fn respawn_with<E: Exec>(
        &self,
        exec: &E,
        session: &Session,
        startup: &str,
    ) -> Result<(), Error> {
        let out = exec
            .exec(&format!(
                "{} respawn-pane -k -t {} {}",
                sq(&self.path),
                sq(&session.pane_id),
                sq(startup)
            ))
            .await?;
        if out.success() {
            Ok(())
        } else {
            Err(Error::Command {
                command: "respawn-pane".to_owned(),
                status: out.status,
                stderr: String::from_utf8_lossy(&out.stderr).trim().to_owned(),
            })
        }
    }
}

/// tmux prints two different things for "no server", picked by errno:
/// `ECONNREFUSED` gives `no server running on …`, a socket that was never there
/// gives `error connecting to … (No such file or directory)`. That second
/// spelling is shared with real failures such as `(Permission denied)`, and
/// both exit 1 — so the reason in brackets is the only signal (I-41).
fn no_server(stderr: &str) -> bool {
    stderr.contains("no server running")
        || (stderr.contains("error connecting to") && stderr.contains("No such file or directory"))
}

fn validate_name(name: &str) -> Result<(), Error> {
    let ok = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if ok {
        Ok(())
    } else {
        Err(Error::InvalidName {
            name: name.to_owned(),
        })
    }
}

fn parse_ids(name: &str, stdout: &[u8]) -> Result<Session, Error> {
    let raw = String::from_utf8_lossy(stdout).trim().to_owned();
    let mut parts = raw.split_whitespace();
    match (parts.next(), parts.next(), parts.next()) {
        (Some(s), Some(w), Some(p))
            if s.starts_with('$') && w.starts_with('@') && p.starts_with('%') =>
        {
            Ok(Session {
                name: name.to_owned(),
                session_id: s.to_owned(),
                window_id: w.to_owned(),
                pane_id: p.to_owned(),
            })
        }
        _ => Err(Error::Ids { raw }),
    }
}

/// POSIX single-quoting. Safe here because the exec payload runs the command
/// under `/bin/sh` (ADR-0006), so the tcsh caveat in R7 does not apply.
fn sq(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn names_outside_the_i2_charset_are_refused() {
        for bad in ["has.dot", "has:colon", "has space", "", "has/slash"] {
            assert!(
                matches!(validate_name(bad), Err(Error::InvalidName { .. })),
                "`{bad}` must be refused before it becomes an unaddressable session"
            );
        }
        for good in ["demo", "my-repo_2", "A1"] {
            assert!(validate_name(good).is_ok(), "`{good}` is a usable name");
        }
    }

    #[test]
    fn ids_are_parsed_and_shape_checked() {
        let s = parse_ids("demo", b"$3 @7 %11\n").expect("well-formed ids parse");
        assert_eq!(s.session_id, "$3");
        assert_eq!(s.window_id, "@7");
        assert_eq!(s.pane_id, "%11");
    }

    /// Guards against silently accepting a format string that tmux echoed back
    /// unexpanded, which would produce a session addressed by garbage.
    #[test]
    fn unexpanded_output_is_not_mistaken_for_ids() {
        assert!(parse_ids("demo", b"#{session_id} #{window_id} #{pane_id}").is_err());
        assert!(parse_ids("demo", b"").is_err());
    }

    /// Exact strings from tmux 3.7b, reproduced against a live server whose
    /// socket was made unreadable. Treating the third as "no server" made
    /// `kill` report success on a failure.
    #[test]
    fn only_a_genuinely_absent_server_counts_as_no_server() {
        assert!(no_server("no server running on /tmp/tmux-1000/default"));
        assert!(no_server(
            "error connecting to /tmp/tmux-1000/absent (No such file or directory)"
        ));
        assert!(!no_server(
            "error connecting to /tmp/tmux-1000/y54perm (Permission denied)"
        ));
        assert!(!no_server("some future tmux phrasing"));
    }

    #[test]
    fn single_quoting_survives_quotes_and_newlines() {
        assert_eq!(sq("plain"), "'plain'");
        assert_eq!(sq("it's"), r"'it'\''s'");
        assert_eq!(sq("a\nb"), "'a\nb'");
    }
}
