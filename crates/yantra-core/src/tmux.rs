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

/// A session as `list-sessions` reports it. `attached` is a client *count*, not
/// a flag — it has been that since tmux 2.3.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Summary {
    pub name: String,
    pub windows: u32,
    pub attached: u32,
    /// Formatted by tmux on the machine that owns the session, so it is that
    /// machine's clock and timezone.
    pub created: String,
    /// The same moment as Unix seconds, so a page can age it (Y-343).
    pub created_at: u64,
}

/// A pane, and how its process ended if it has.
///
/// **Exactly one of `status` and `signal` is set on a dead pane, and reading
/// only `status` is the R-2 trap**: a signal-killed process leaves
/// `pane_dead_status` *empty*, which parses to nothing and reads like a clean
/// exit to anyone who defaults it to zero. Measured on 3.5a and 3.7b: SIGTERM
/// gives `status=[] signal=[…]`, `exit 143` gives `status=[143] signal=[]`.
///
/// `signal` is a **name**, never a number, and that is not cosmetic (I-48):
/// tmux prints `15` on Linux and `term` on macOS *at the same version*, and the
/// numbering itself is not portable either — signal 10 is `USR1` on Linux and
/// `BUS` on macOS. A name is the only spelling that means one thing everywhere.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pane {
    pub id: String,
    pub dead: bool,
    pub status: Option<i32>,
    pub signal: Option<String>,
    /// Absent once the pane is dead — there is no process left to name.
    pub pid: Option<u32>,
    /// What this pane was asked to run, which is what Yantra asked for: sessions
    /// are created with the default shell and *then* respawned with the startup
    /// or agent command, so `None` means nobody asked for anything and the pane
    /// is a plain shell. tmux updates it on every respawn, so it survives
    /// `resume`. Measured on 3.5a and 3.7b.
    pub start_command: Option<String>,
}

/// The signal numbers POSIX fixes, so both spellings can be read as one thing.
///
/// Deliberately partial. 7, 10 and 12 are **left out because they genuinely
/// differ** between Linux and macOS, and inventing an answer for them would be
/// worse than `SIG10`.
const SIGNAL_NAMES: [(i32, &str); 12] = [
    (1, "HUP"),
    (2, "INT"),
    (3, "QUIT"),
    (4, "ILL"),
    (5, "TRAP"),
    (6, "ABRT"),
    (8, "FPE"),
    (9, "KILL"),
    (11, "SEGV"),
    (13, "PIPE"),
    (14, "ALRM"),
    (15, "TERM"),
];

/// Reads either spelling tmux might use, and answers in names.
fn signal_name(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(number) = raw.parse::<i32>() {
        return Some(
            SIGNAL_NAMES
                .iter()
                .find(|(n, _)| *n == number)
                .map_or_else(|| format!("SIG{number}"), |(_, name)| (*name).to_owned()),
        );
    }
    let name = raw.to_ascii_uppercase();
    Some(name.strip_prefix("SIG").unwrap_or(&name).to_owned())
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

    #[error("could not parse a session from `{raw}`")]
    Listing { raw: String },

    #[error(transparent)]
    Ssh(#[from] crate::ssh::Error),
}

const IDS: &str = "#{session_id} #{window_id} #{pane_id}";

/// Name last, because a session tmux did not create can contain spaces — and
/// with `splitn` that also means a name may contain the delimiter.
///
/// I-42: not a tab. tmux 3.5a rewrites tabs in format output to `_` while 3.7b
/// passes them through, and the fleet runs both.
const LIST_FORMAT: &str = "#{session_windows}|#{session_attached}|#{t:session_created}|#{session_created}|#{session_name}";

/// Same `|` and the same reason as [`LIST_FORMAT`] — and here the empty field
/// is the point, so a delimiter that survives an empty value is mandatory.
/// `pane_start_command` is **last** because it is the one field that can contain
/// a `|` of its own — a `startup` is whatever the workspace wrote.
const PANE_FORMAT: &str = "#{pane_id}|#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}|#{pane_pid}|#{pane_start_command}";

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
        // suppress the sentinel. `(/*)`, as in `agent::probe` (Y-634, Y-635).
        let probe = format!(
            "p=$(command -v tmux 2>/dev/null)\n\
             case \"$p\" in (/*) printf '%s\\n' \"$p\"; exit 0 ;; esac\n\
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
                self.respawn(exec, &session.pane_id, startup).await?;
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

    /// Sessions on this machine, name-sorted. No server means none.
    pub async fn list<E: Exec>(&self, exec: &E) -> Result<Vec<Summary>, Error> {
        let out = exec
            .exec(&format!(
                "{} list-sessions -F {}",
                sq(&self.path),
                sq(LIST_FORMAT)
            ))
            .await?;

        if !out.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            if no_server(&stderr) {
                return Ok(Vec::new());
            }
            return Err(Error::Command {
                command: "list-sessions".to_owned(),
                status: out.status,
                stderr: stderr.trim().to_owned(),
            });
        }

        let stdout = String::from_utf8_lossy(&out.stdout);
        let mut sessions = stdout
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(parse_summary)
            .collect::<Result<Vec<_>, _>>()?;
        // tmux documents no order; today's is an artefact of its internal tree.
        sessions.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(sessions)
    }

    /// Whether a server answers. An empty `-D` server has no sessions and is
    /// still one, so this is not `list` being empty.
    pub async fn running<E: Exec>(&self, exec: &E) -> Result<bool, Error> {
        Ok(self.sessions(exec).await?.is_some())
    }

    /// What `list-sessions` printed, or `None` when no server answers.
    async fn sessions<E: Exec>(&self, exec: &E) -> Result<Option<String>, Error> {
        let out = exec
            .exec(&format!("{} list-sessions", sq(&self.path)))
            .await?;
        if out.success() {
            return Ok(Some(String::from_utf8_lossy(&out.stdout).into_owned()));
        }
        let stderr = String::from_utf8_lossy(&out.stderr);
        if no_server(&stderr) {
            return Ok(None);
        }
        Err(Error::Command {
            command: "list-sessions".to_owned(),
            status: out.status,
            stderr: stderr.trim().to_owned(),
        })
    }

    /// A Mac's server in the login session: one holding a session, or one
    /// [`LOGIN_SERVER`]'s LaunchAgent starts (ADR-0018's 2026-11-04 amendment).
    /// `false` means no one is logged in at the screen.
    ///
    /// An empty server gets the script too, which replaces an older job and
    /// its `PATH` (Y-640); if that fails, the empty server still serves.
    pub async fn login_server<E: Exec>(&self, exec: &E) -> Result<bool, Error> {
        let answered = match self.sessions(exec).await? {
            Some(listed) if !listed.trim().is_empty() => return Ok(true),
            Some(_) => true,
            None => false,
        };
        let out = exec.exec(&login_server_command(&self.path)).await?;
        match out.status {
            0 => Ok(true),
            _ if answered => Ok(true),
            NO_ONE_AT_THE_SCREEN => Ok(false),
            status => Err(Error::Command {
                command: "launchctl".to_owned(),
                status,
                stderr: String::from_utf8_lossy(&out.stderr).trim().to_owned(),
            }),
        }
    }

    /// The session's first pane, or `None` when there is no such session.
    ///
    /// This is only readable at all because `remain-on-exit` is set when the
    /// session is created (I-4): without it a pane whose process ended is gone,
    /// and a crash is indistinguishable from a clean finish.
    pub async fn pane<E: Exec>(&self, exec: &E, name: &str) -> Result<Option<Pane>, Error> {
        validate_name(name)?;
        let out = exec
            .exec(&format!(
                "{} list-panes -s -t {} -F {}",
                sq(&self.path),
                sq(&format!("={name}")),
                sq(PANE_FORMAT)
            ))
            .await?;

        if !out.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            if no_server(&stderr) || no_such_session(&stderr) {
                return Ok(None);
            }
            return Err(Error::Command {
                command: "list-panes".to_owned(),
                status: out.status,
                stderr: stderr.trim().to_owned(),
            });
        }

        let stdout = String::from_utf8_lossy(&out.stdout);
        stdout
            .lines()
            .find(|line| !line.trim().is_empty())
            .map(parse_pane)
            .transpose()
    }

    /// Whether the pane's *visible* screen holds `text` — which for an agent TUI
    /// is the alternate screen, the one thing `capture-pane` can reach (I-3).
    ///
    /// The match runs on the far side, so a pane's contents never cross the wire
    /// and what comes back is one bit. A pane that has gone away answers `false`
    /// rather than failing: a caller asking "is it showing this?" can act on a
    /// no, and there is nothing else it could do with an error.
    pub async fn pane_shows<E: Exec>(
        &self,
        exec: &E,
        pane_id: &str,
        text: &str,
    ) -> Result<bool, Error> {
        // I-21: `%id`, because a pane target is never `=name`.
        let out = exec
            .exec(&format!(
                "{} capture-pane -p -t {} | grep -qF -- {}",
                sq(&self.path),
                sq(pane_id),
                sq(text)
            ))
            .await?;
        Ok(out.success())
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
            .exec(&remain_on_exit(&self.path, &session.window_id))
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

    /// Replaces the pane's process with `command`, so the pane's process *is*
    /// the command and I-4 can report how it ended.
    ///
    /// Also the only way to put a process back into a pane that has already
    /// died, which under `remain-on-exit` is every pane whose agent has exited.
    pub async fn respawn<E: Exec>(
        &self,
        exec: &E,
        pane_id: &str,
        command: &str,
    ) -> Result<(), Error> {
        // I-21: `%id`, because a pane target is never `=name`.
        let out = exec
            .exec(&format!(
                "{} respawn-pane -k -t {} {}",
                sq(&self.path),
                sq(pane_id),
                sq(command)
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

/// **`can't find window` is the spelling that actually happens** (Y-084): with a
/// server up, tmux resolves `list-panes -s -t '=name'` as a window target and
/// names *that* in the refusal, on 3.7b and 3.5a alike. Both are matched because
/// either one means the session is not there.
fn no_such_session(stderr: &str) -> bool {
    stderr.contains("can't find session") || stderr.contains("can't find window")
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

fn parse_pane(line: &str) -> Result<Pane, Error> {
    let bad = || Error::Listing {
        raw: line.to_owned(),
    };
    let mut fields = line.trim_end().splitn(6, '|');
    match (
        fields.next(),
        fields.next(),
        fields.next(),
        fields.next(),
        fields.next(),
        fields.next(),
    ) {
        (Some(id), Some(dead), Some(status), Some(signal), Some(pid), Some(started))
            if !id.is_empty() =>
        {
            Ok(Pane {
                id: id.to_owned(),
                dead: dead == "1",
                status: status.parse().ok(),
                signal: signal_name(signal),
                pid: pid.parse().ok(),
                start_command: (!started.is_empty()).then(|| started.to_owned()),
            })
        }
        _ => Err(bad()),
    }
}

fn parse_summary(line: &str) -> Result<Summary, Error> {
    let bad = || Error::Listing {
        raw: line.to_owned(),
    };
    let mut fields = line.splitn(5, '|');
    match (
        fields.next(),
        fields.next(),
        fields.next(),
        fields.next(),
        fields.next(),
    ) {
        (Some(windows), Some(attached), Some(created), Some(created_at), Some(name))
            if !name.is_empty() =>
        {
            Ok(Summary {
                windows: windows.parse().map_err(|_| bad())?,
                attached: attached.parse().map_err(|_| bad())?,
                created: created.to_owned(),
                created_at: created_at.parse().map_err(|_| bad())?,
                name: name.to_owned(),
            })
        }
        _ => Err(bad()),
    }
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

/// The shell function that loads the LaunchAgent. `join.sh` carries it too.
pub(crate) const LOGIN_SERVER: &str = include_str!("login_server.sh");

/// [`LOGIN_SERVER`]'s status when there is no `gui/<uid>` domain.
const NO_ONE_AT_THE_SCREEN: i32 = 3;

pub(crate) fn login_server_command(tmux: &str) -> String {
    format!("{LOGIN_SERVER}\nlogin_server {}\n", sq(tmux))
}

/// The empty format keeps tmux's "Pane is dead" line off an attached terminal
/// (Y-639); `-q` because tmux before 3.3 has no such option.
fn remain_on_exit(tmux: &str, window_id: &str) -> String {
    let (tmux, window) = (sq(tmux), sq(window_id));
    format!(
        "{tmux} set-option -w -t {window} remain-on-exit on \\; \
         set-option -qw -t {window} remain-on-exit-format ''"
    )
}

/// POSIX single-quoting. Safe here because the exec payload runs the command
/// under `/bin/sh` (ADR-0006), so the tcsh caveat in R7 does not apply.
pub(crate) fn sq(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Wraps `command` so a **running** server forks it and its stdout comes back on
/// the caller's connection — one round trip, and the process-tree property
/// [ADR-0018] §5 needs. Needs no session and creates none.
///
/// The `exit 0` is not tidiness: tmux appends `'…' returned N` to that same
/// stdout when the command fails, which reaches a parser as trailing junk.
/// Measured byte-identical on 3.5a and 3.7b, as is the absence of the command's
/// own stderr — anything to be read back must be printed on stdout.
///
/// With no server this fails with one of [`no_server`]'s spellings, which is the
/// state [`crate::up::require_login_server`] ends, or refuses, ahead of it on macOS.
///
/// [ADR-0018]: ../../../docs/adr/0018-the-tmux-server-carries-the-macos-login-session.md
pub(crate) fn run_shell(tmux: &str, command: &str) -> String {
    format!(
        "{} run-shell {}",
        sq(tmux),
        sq(&format!("{command}; exit 0"))
    )
}

/// I-48, the reason [`signal_name`] exists at all.
#[cfg(test)]
mod signal_tests {
    use super::signal_name;

    /// The two spellings tmux actually produced, on machines running the *same*
    /// version: `15` on Arch and Alpine, `term` on macOS.
    #[test]
    fn both_spellings_tmux_uses_mean_the_same_signal() {
        assert_eq!(signal_name("15").as_deref(), Some("TERM"));
        assert_eq!(signal_name("term").as_deref(), Some("TERM"));
        assert_eq!(signal_name("SIGTERM").as_deref(), Some("TERM"));
        assert_eq!(signal_name("9").as_deref(), Some("KILL"));
        assert_eq!(signal_name("kill").as_deref(), Some("KILL"));
    }

    /// An empty field is a pane that did not die of a signal, and must stay
    /// distinguishable from one that did — that is the whole I-47 trap.
    #[test]
    fn an_empty_field_is_not_a_signal() {
        assert_eq!(signal_name(""), None);
        assert_eq!(signal_name("  "), None);
    }

    /// 10 is `USR1` on Linux and `BUS` on macOS, so naming it would be a guess.
    #[test]
    fn a_number_that_is_not_portable_is_left_as_a_number() {
        assert_eq!(signal_name("10").as_deref(), Some("SIG10"));
        assert_eq!(signal_name("64").as_deref(), Some("SIG64"));
    }
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::panic)]
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
    fn remain_on_exit_also_blanks_the_dead_pane_text_in_one_round_trip() {
        assert_eq!(
            remain_on_exit("/usr/bin/tmux", "@7"),
            "'/usr/bin/tmux' set-option -w -t '@7' remain-on-exit on \\; \
             set-option -qw -t '@7' remain-on-exit-format ''"
        );
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
    fn a_session_row_parses_and_a_name_may_contain_spaces() {
        let s = parse_summary("3|1|Thu Jul 30 13:02:31 2026|1785502951|my session")
            .expect("a well-formed row parses");
        assert_eq!(s.windows, 3);
        assert_eq!(s.attached, 1);
        assert_eq!(s.created, "Thu Jul 30 13:02:31 2026");
        assert_eq!(s.created_at, 1_785_502_951);
        assert_eq!(s.name, "my session", "the name is last, so spaces survive");
    }

    /// A dropped session reads as "not running", which is the same class of
    /// wrong answer as I-30's absence-is-not-failure, in the other direction.
    #[test]
    fn a_malformed_row_is_an_error_rather_than_a_dropped_session() {
        for bad in [
            "",
            "1|0",
            "x|0|when|1|name",
            "1|0|when|1|",
            "1|0|when|name",
            "1|0|when|soon|name",
        ] {
            assert!(
                matches!(parse_summary(bad), Err(Error::Listing { .. })),
                "{bad:?} must not silently vanish"
            );
        }
    }

    /// The command reaches tmux as **one** argument however many words it has,
    /// and tmux's own report of a failed command stays off the stdout a caller
    /// parses.
    #[test]
    fn a_run_shell_command_is_one_argument_and_never_reports_its_own_failure() {
        assert_eq!(
            run_shell("/opt/homebrew/bin/tmux", "'/u/claude' auth status"),
            "'/opt/homebrew/bin/tmux' run-shell ''\\''/u/claude'\\'' auth status; exit 0'"
        );
    }

    const TMUX: &str = "/opt/homebrew/bin/tmux";

    fn tmux() -> Tmux {
        Tmux {
            path: TMUX.to_owned(),
        }
    }

    #[tokio::test]
    async fn a_running_server_sends_no_launchctl() {
        let mac = fake::Mac::new(fake::Server::Running, 0);
        assert!(tmux().login_server(&mac).await.expect("answered"));
        assert_eq!(mac.asked(), ["'/opt/homebrew/bin/tmux' list-sessions"]);
    }

    /// `tmux -D` keeps a server with no session, and `list-sessions` there
    /// exits 0 and prints nothing. Measured on tmux 3.8.
    #[tokio::test]
    async fn an_empty_server_is_running() {
        let mac = fake::Mac::new(fake::Server::Empty, 0);
        assert!(tmux().running(&mac).await.expect("answered"));
        assert!(!mac.asked_for("launchctl"));
    }

    /// Y-640: KeepAlive keeps an empty server up, so an older job is replaced
    /// there or never. A failed replacement still leaves that server to use.
    #[tokio::test]
    async fn an_empty_server_gets_the_script_and_still_serves_if_it_fails() {
        for script in [0, 1, 3] {
            let mac = fake::Mac::new(fake::Server::Empty, script);
            assert!(
                tmux().login_server(&mac).await.expect("answered"),
                "{script}"
            );
            assert_eq!(mac.asked().last(), Some(&login_server_command(TMUX)));
        }
    }

    #[tokio::test]
    async fn no_server_sends_the_script_with_the_quoted_path() {
        let mac = fake::Mac::new(fake::Server::None, 0);
        assert!(!tmux().running(&mac).await.expect("answered"));
        assert!(tmux().login_server(&mac).await.expect("answered"));
        let asked = mac.asked();
        assert_eq!(asked.last(), Some(&login_server_command(TMUX)));
        assert!(
            asked[asked.len() - 1].ends_with("\nlogin_server '/opt/homebrew/bin/tmux'\n"),
            "{asked:?}"
        );
    }

    #[tokio::test]
    async fn exit_3_is_no_one_at_the_screen() {
        let mac = fake::Mac::new(fake::Server::None, 3);
        assert!(!tmux().login_server(&mac).await.expect("answered"));
    }

    #[tokio::test]
    async fn any_other_exit_is_a_launchctl_error_with_its_stderr() {
        let mac = fake::Mac::new(fake::Server::None, 1);
        let err = tmux().login_server(&mac).await.expect_err("refused");
        let Error::Command {
            command,
            status,
            stderr,
        } = err
        else {
            panic!("{err:?}");
        };
        assert_eq!((command.as_str(), status), ("launchctl", 1));
        assert_eq!(stderr, fake::SCRIPT_SAID);
    }

    /// I-41: a socket tmux may not open is not an absent server.
    #[tokio::test]
    async fn a_refused_socket_is_an_error_and_not_no_server() {
        let mac = fake::Mac::new(fake::Server::Refused, 0);
        assert!(matches!(
            tmux().login_server(&mac).await,
            Err(Error::Command { ref command, .. }) if command == "list-sessions"
        ));
        assert!(!mac.asked_for("launchctl"));
    }

    fn login_server_on(mac: &launchd::Mac) -> std::process::Output {
        mac.run(&login_server_command(&mac.tmux()))
    }

    /// Join runs the script on a Mac whose Terminal already holds a server.
    /// The job is installed anyway, and waits in its `ls` loop.
    #[test]
    fn a_running_server_still_gets_the_launch_agent() {
        let mac = launchd::Mac::new("running", true, false, None);
        let out = login_server_on(&mac);
        assert_eq!(out.status.code(), Some(0), "{out:?}");
        let plist = mac.plist().expect("the plist was written");
        assert!(plist.contains("<key>KeepAlive</key><true/>"), "{plist}");
        assert!(
            plist.contains(&format!("<string>{}</string>", mac.tmux())),
            "{plist}"
        );
        let log = mac.log();
        assert!(log.contains("launchctl bootstrap gui/"), "{log}");
        assert!(!log.contains("bootout"), "{log}");
    }

    /// The bootout of a loaded job ends the server it runs, and its sessions.
    #[test]
    fn an_older_job_holding_a_session_is_left_alone() {
        let mac = launchd::Mac::new("older-held", true, true, Some("older"));
        std::fs::write(mac.dir.join("server"), "main: 1 windows\n").expect("a session");
        let out = login_server_on(&mac);
        assert_eq!(out.status.code(), Some(0), "{out:?}");
        assert_eq!(mac.plist().as_deref(), Some("older"));
        assert!(!mac.log().contains("bootout"), "{}", mac.log());
    }

    /// Y-640: an empty server loses nothing, and KeepAlive never lets it end.
    #[test]
    fn an_older_job_with_an_empty_server_is_replaced() {
        let mac = launchd::Mac::new("older-empty", true, true, Some("older"));
        let out = login_server_on(&mac);
        assert_eq!(out.status.code(), Some(0), "{out:?}");
        assert!(mac.plist().expect("a plist").contains("KeepAlive"));
        let log = mac.log();
        let bootout = log.find("bootout").expect("the old job was booted out");
        let bootstrap = log.find("bootstrap").expect("the new job was loaded");
        assert!(bootout < bootstrap, "{log}");
    }

    #[test]
    fn an_older_job_with_no_server_is_replaced() {
        let mac = launchd::Mac::new("older-idle", false, true, Some("older"));
        let out = login_server_on(&mac);
        assert_eq!(out.status.code(), Some(0), "{out:?}");
        assert!(mac.plist().expect("a plist").contains("KeepAlive"));
        let log = mac.log();
        let bootout = log.find("bootout").expect("the old job was booted out");
        let bootstrap = log.find("bootstrap").expect("the new job was loaded");
        assert!(bootout < bootstrap, "{log}");
    }

    /// The fixed directories, in the order the plist adds those it lacks.
    fn fixed(home: &std::path::Path) -> String {
        format!(
            "{}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            home.display()
        )
    }

    /// Y-640: nvm's node is on the login shell's PATH only. The shell prints
    /// an escape code first, as iTerm's rc does.
    #[test]
    fn the_job_gets_the_login_shells_path_and_then_the_fixed_one() {
        let mac = launchd::Mac::new("login-path", false, false, None);
        mac.login_shell(
            "#!/bin/sh\nprintf '\\033]1337;RemoteHost=me\\007'\n\
             PATH=/fake/nvm/bin:/usr/bin:/bin; export PATH\neval \"$2\"\n",
        );
        let out = login_server_on(&mac);
        assert_eq!(out.status.code(), Some(0), "{out:?}");
        assert_eq!(
            mac.path(),
            format!(
                "/fake/nvm/bin:/usr/bin:/bin:{}/.local/bin:/opt/homebrew/bin:/usr/local/bin:\
                 /usr/sbin:/sbin",
                mac.dir.display()
            )
        );
    }

    #[test]
    fn a_login_shell_that_fails_or_prints_junk_gives_the_fixed_path() {
        let mac = launchd::Mac::new("login-fails", false, false, None);
        assert_eq!(login_server_on(&mac).status.code(), Some(0));
        assert_eq!(mac.path(), fixed(&mac.dir));

        for junk in [
            "#!/bin/sh\necho 'zsh: no such option'\n",
            "#!/bin/sh\necho yantra-login-path\necho 'not a path'\n",
            "#!/bin/sh\necho yantra-login-path\necho '/a&b:/usr/bin'\n",
        ] {
            let mac = launchd::Mac::new("login-junk", false, false, None);
            mac.login_shell(junk);
            assert_eq!(login_server_on(&mac).status.code(), Some(0), "{junk}");
            assert_eq!(mac.path(), fixed(&mac.dir), "{junk}");
        }
    }

    /// An rc file that waits on a prompt must not hold the session's start.
    #[test]
    fn a_login_shell_that_hangs_is_cut_off() {
        let mac = launchd::Mac::new("login-hangs", false, false, None);
        mac.login_shell("#!/bin/sh\nexec sleep 60\n");
        let started = std::time::Instant::now();
        let out = login_server_on(&mac);
        assert_eq!(out.status.code(), Some(0), "{out:?}");
        assert!(started.elapsed() < std::time::Duration::from_secs(20));
        assert_eq!(mac.path(), fixed(&mac.dir));
    }

    #[test]
    fn single_quoting_survives_quotes_and_newlines() {
        assert_eq!(sq("plain"), "'plain'");
        assert_eq!(sq("it's"), r"'it'\''s'");
        assert_eq!(sq("a\nb"), "'a\nb'");
    }
}

/// A Mac answering by command, for the login-server branch of `tmux`, `up`
/// and `clone`.
#[cfg(test)]
pub(crate) mod fake {
    use crate::ssh::{self, Exec};
    use std::sync::{Mutex, PoisonError};

    pub(crate) const SCRIPT_SAID: &str = "the tmux server did not start";

    #[derive(Clone, Copy)]
    pub(crate) enum Server {
        Running,
        Empty,
        None,
        Refused,
    }

    pub(crate) struct Mac {
        server: Server,
        script: i32,
        asked: Mutex<Vec<String>>,
    }

    impl Mac {
        /// `script` is the status the login-server script exits with.
        pub(crate) fn new(server: Server, script: i32) -> Self {
            Self {
                server,
                script,
                asked: Mutex::default(),
            }
        }

        pub(crate) fn asked(&self) -> Vec<String> {
            self.asked
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone()
        }

        pub(crate) fn asked_for(&self, part: &str) -> bool {
            self.asked().iter().any(|command| command.contains(part))
        }
    }

    impl Exec for Mac {
        async fn exec(&self, command: &str) -> Result<ssh::Output, ssh::Error> {
            self.asked
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(command.to_owned());
            let (status, stdout, stderr) = if command.contains("\nlogin_server '") {
                let said = if self.script == 0 { "" } else { SCRIPT_SAID };
                (self.script, "", said)
            } else if command.contains("list-sessions") {
                match self.server {
                    Server::Running => (0, "main: 1 windows\n", ""),
                    Server::Empty => (0, "", ""),
                    Server::None => (1, "", "no server running on /private/tmp/tmux-501/default"),
                    Server::Refused => (
                        1,
                        "",
                        "error connecting to /private/tmp/tmux-501/default (Permission denied)",
                    ),
                }
            } else if command.contains("command -v tmux") {
                (0, "/opt/homebrew/bin/tmux\n", "")
            } else if command.contains("new-session") {
                (0, "$1 @1 %1\n", "")
            } else {
                (0, "", "")
            };
            Ok(ssh::Output {
                status,
                stdout: stdout.as_bytes().to_vec(),
                stderr: stderr.as_bytes().to_vec(),
            })
        }
    }
}

/// A Mac's `launchctl` and `tmux` as shell scripts, so `login_server.sh` runs
/// for real on the build host. State is three files in the directory.
#[cfg(test)]
#[allow(clippy::expect_used)]
pub(crate) mod launchd {
    use std::path::{Path, PathBuf};

    pub(crate) const PLIST: &str =
        "Library/LaunchAgents/io.github.2002bishwajeet.yantra-tmux.plist";

    pub(crate) struct Mac {
        pub(crate) dir: PathBuf,
    }

    impl Mac {
        /// `server`: a tmux server answers. `loaded`: the job is in the domain.
        pub(crate) fn new(label: &str, server: bool, loaded: bool, plist: Option<&str>) -> Self {
            let dir =
                std::env::temp_dir().join(format!("yantra-launchd-{label}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join("bin")).expect("a directory");
            // kickstart starts the server only when the job is loaded.
            write_tool(
                &dir,
                "launchctl",
                r#"#!/bin/sh
echo "launchctl $*" >>"$FAKE/log"
case "$1" in
print) case "$2" in */*/*) test -f "$FAKE/loaded" ;; *) exit 0 ;; esac ;;
bootstrap) touch "$FAKE/loaded" ;;
bootout) rm "$FAKE/loaded" "$FAKE/server" 2>/dev/null; exit 0 ;;
kickstart) test -f "$FAKE/loaded" && touch "$FAKE/server" ;;
esac
"#,
            );
            write_tool(
                &dir,
                "tmux",
                "#!/bin/sh\ntest -f \"$FAKE/server\" && cat \"$FAKE/server\"\n",
            );
            // A login shell that fails, so the plist holds the fixed PATH.
            write_tool(&dir, "shell", "#!/bin/sh\nexit 1\n");
            if server {
                std::fs::write(dir.join("server"), "").expect("a file");
            }
            if loaded {
                std::fs::write(dir.join("loaded"), "").expect("a file");
            }
            if let Some(plist) = plist {
                let path = dir.join(PLIST);
                std::fs::create_dir_all(path.parent().expect("a parent")).expect("a directory");
                std::fs::write(path, plist).expect("a file");
            }
            Self { dir }
        }

        pub(crate) fn tmux(&self) -> String {
            self.dir.join("bin/tmux").display().to_string()
        }

        /// Replaces the account's login shell, which `$SHELL` names.
        pub(crate) fn login_shell(&self, body: &str) {
            write_tool(&self.dir, "shell", body);
        }

        /// Runs `script` under `sh` with this Mac's tools and `$HOME`.
        pub(crate) fn run(&self, script: &str) -> std::process::Output {
            let path = format!(
                "{}:{}",
                self.dir.join("bin").display(),
                std::env::var("PATH").unwrap_or_default()
            );
            std::process::Command::new("sh")
                .args(["-c", script])
                .env("HOME", &self.dir)
                .env("FAKE", &self.dir)
                .env("SHELL", self.dir.join("bin/shell"))
                .env("PATH", path)
                .output()
                .expect("sh is on every machine this builds on")
        }

        pub(crate) fn log(&self) -> String {
            std::fs::read_to_string(self.dir.join("log")).unwrap_or_default()
        }

        pub(crate) fn plist(&self) -> Option<String> {
            std::fs::read_to_string(self.dir.join(PLIST)).ok()
        }

        /// The `PATH` the plist gives the job.
        pub(crate) fn path(&self) -> String {
            let plist = self.plist().expect("the plist was written");
            let (_, rest) = plist
                .split_once("<key>PATH</key><string>")
                .expect("the plist sets PATH");
            rest.split_once("</string>")
                .expect("a closed string")
                .0
                .to_owned()
        }
    }

    impl Drop for Mac {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn write_tool(dir: &Path, name: &str, body: &str) {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("bin").join(name);
        std::fs::write(&path, body).expect("a file");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    }
}
