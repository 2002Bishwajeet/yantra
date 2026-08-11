//! What a machine can and cannot do, asked without changing it.
//!
//! The check list is [D2 §3.1] and the constraint is [D2 §3.2]: `doctor` is a
//! **read**. Nothing here installs, writes or starts anything — the one place
//! that could is the macOS branch of [`login_session`], which asks whether a
//! tmux server exists rather than creating one (ADR-0018 §1).
//!
//! **Every branch answers `Unknown` where it could not ask**, which is R-23 and
//! the reason this module is longer than the commands it runs: *absent* sends a
//! reader to install something and *unknown* sends them to the machine, so a
//! sleeping laptop that reported *absent* would have them installing tmux on a
//! box that already has it.
//!
//! [D2 §3.1]: ../../../docs/design/02-setup.md
//! [D2 §3.2]: ../../../docs/design/02-setup.md

use crate::agent::{self, Claude};
use crate::attention;
use crate::ssh::{self, Exec, Os, Ssh};
use crate::terminfo::{self, Chosen};
use crate::tmux::{self, Tmux, sq};
use crate::workspace;

/// The checks, in the order they are reported. The names are the JSON contract
/// an installer and an agent read (D2.2), so renaming one is a breaking change.
const REACHABLE: &str = "reachable";
const SSHD: &str = "sshd";
const TMUX: &str = "tmux";
const AGENT_CLI: &str = "agent-cli";
const TERMINFO: &str = "terminfo";
const PROVIDER_CLI: &str = "provider-cli";
const PROVIDER_AUTH: &str = "provider-auth";
const LOGIN_SESSION: &str = "login-session";
/// Public because the one caller that can answer this check finds it by name —
/// see [`heartbeat`].
pub const HEARTBEAT: &str = "heartbeat";
/// Not one of the checks above: it names a fact about the host this process runs
/// on rather than about a machine being asked — see [`github`].
pub const GITHUB: &str = "github";

/// Everything ssh has to answer for. Listed so an unreachable machine still
/// reports every check rather than a short list a consumer has to interpret.
const BEHIND_SSH: [&str; 6] = [
    TMUX,
    AGENT_CLI,
    TERMINFO,
    PROVIDER_CLI,
    PROVIDER_AUTH,
    LOGIN_SESSION,
];

/// What every check behind ssh says when ssh itself did not answer. The reason
/// stays on the `reachable` check, which is the one that has it.
const NOT_ASKED: &str = "nothing behind ssh could be asked — see the `reachable` check";

/// The provider CLIs D2 §3.1 names. `tea` is deliberately not here: it was
/// measured absent on this fleet and nothing in Yantra reads it.
const PROVIDERS: [&str; 2] = ["gh", "glab"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Present,
    Absent,
    /// The question could not be asked. **Never rendered as [`State::Absent`]**
    /// — the two send a reader to different places (R-23).
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Check {
    pub check: &'static str,
    pub state: State,
    /// What was found, or why nothing could be. Carries no credential and no
    /// account name: the provider checks discard their output on the far side.
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Report {
    pub machine: String,
    pub checks: Vec<Check>,
}

impl Report {
    /// Whether every check answered [`State::Present`]. An `Unknown` is not a
    /// yes, for the same reason [`crate::status::Verdict::is_running`] is false
    /// for an unclear verdict.
    pub fn ready(&self) -> bool {
        self.checks.iter().all(|c| c.state == State::Present)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Workspace(#[from] workspace::Error),

    #[error("querying {machine} did not finish: {reason}")]
    Interrupted { machine: String, reason: String },
}

/// Every machine any workspace names, queried concurrently — the shape and the
/// reason are [`crate::sessions::list`]'s: an unreachable machine costs the full
/// `ConnectTimeout`, and sequentially those add up.
pub async fn fleet(term: &str) -> Result<Vec<Report>, Error> {
    let mut machines: Vec<String> = workspace::list()?
        .workspaces
        .into_iter()
        .map(|workspace| workspace.machine)
        .collect();
    machines.sort();
    machines.dedup();

    let queries: Vec<_> = machines
        .into_iter()
        .map(|name| {
            let term = term.to_owned();
            let machine = name.clone();
            (
                name,
                tokio::spawn(async move { self::machine(&machine, &term).await }),
            )
        })
        .collect();

    let mut reports = Vec::with_capacity(queries.len());
    for (name, query) in queries {
        reports.push(query.await.map_err(|joined| Error::Interrupted {
            machine: name,
            reason: joined.to_string(),
        })?);
    }
    Ok(reports)
}

/// One machine, named the way a workspace names one (ADR-0009).
///
/// Never fails: a connection that cannot even be built is a report of unknowns
/// with the reason in it, because a caller asking *what is wrong with this box*
/// is answered better by nine states than by one error.
pub async fn machine(name: &str, term: &str) -> Report {
    let ssh = ssh::machine_at(name)
        .ok_or_else(|| "no directory for ssh control sockets on this machine".to_owned())
        .and_then(|m| Ssh::new(m).map_err(|err| err.to_string()));

    let checks = match ssh {
        Ok(ssh) => of(&ssh, term).await,
        Err(reason) => nothing_asked(&format!("ssh could not be set up here: {reason}")),
    };
    Report {
        machine: name.to_owned(),
        checks,
    }
}

/// The testable half.
///
/// `term` is the terminal the caller is sitting at, which is what the terminfo
/// check is about (I-36) — it is a property of the asker, not of the machine.
pub async fn of<E: Exec>(exec: &E, term: &str) -> Vec<Check> {
    let (reachable, sshd) = reached(exec).await;
    if reachable.state != State::Present {
        // The diagnosis stays on the check that has it rather than being copied
        // onto six more rows, none of which a reader would act on twice.
        let mut checks = vec![reachable, sshd];
        checks.extend(BEHIND_SSH.map(|check| unknown(check, NOT_ASKED)));
        checks.push(heartbeat());
        return checks;
    }

    let (tmux, found_tmux) = tmux(exec).await;
    let (agent_cli, found_claude) = agent_cli(exec).await;
    let (provider_cli, providers) = provider_cli(exec).await;

    vec![
        reachable,
        sshd,
        tmux,
        agent_cli,
        terminfo(exec, term).await,
        provider_cli,
        provider_auth(exec, providers).await,
        login_session(exec, found_tmux.as_ref(), found_claude.as_ref()).await,
        heartbeat(),
    ]
}

/// One command that does nothing, which is the whole of *can Yantra reach this
/// machine* — and, when it fails, the only evidence about the far end's sshd.
async fn reached<E: Exec>(exec: &E) -> (Check, Check) {
    match exec.exec("true").await {
        Ok(_) => (
            present(REACHABLE, "a command ran there and reported its own status"),
            present(SSHD, "it answered, so one is listening"),
        ),
        // The transport failed before the command reported anything, so `ssh`'s
        // own diagnostic is all there is to go on (ADR-0006's `-E` log).
        Err(ssh::Error::Transport { diagnosis, .. }) => diagnose(&diagnosis),
        Err(err) => (
            unknown(REACHABLE, format!("ssh could not be run from here: {err}")),
            unknown(SSHD, format!("ssh could not be run from here: {err}")),
        ),
    }
}

/// D2 §3.1's *distinguishing refusal from timeout*, which is the one place two
/// checks come from one command.
///
/// A refusal is the machine answering — it is up, and nothing holds the ssh
/// port. Silence is not: the box may be asleep, the port filtered, or the name
/// wrong, and none of those says whether an sshd exists.
fn diagnose(diagnosis: &str) -> (Check, Check) {
    let said = diagnosis.to_lowercase();
    let unreachable = |detail: String| absent(REACHABLE, detail);

    if said.contains("connection refused") {
        return (
            unreachable(format!("the connection was refused: {diagnosis}")),
            absent(
                SSHD,
                "the machine answered and refused the connection, so nothing is listening on its \
                 ssh port",
            ),
        );
    }
    // sshd itself wrote these, so it exists — what failed is this key or this
    // known-hosts file, which is a different thing to go and fix.
    if said.contains("permission denied") || said.contains("host key verification failed") {
        return (
            unreachable(format!("sshd refused this connection: {diagnosis}")),
            present(SSHD, "the refusal came from sshd itself, so one is running"),
        );
    }
    (
        unreachable(format!("ssh got no answer: {diagnosis}")),
        unknown(
            SSHD,
            "nothing answered, so whether one is listening is not known",
        ),
    )
}

async fn tmux<E: Exec>(exec: &E) -> (Check, Option<Tmux>) {
    match Tmux::resolve(exec).await {
        Ok(tmux) => (
            present(TMUX, format!("found at {}", tmux.path())),
            Some(tmux),
        ),
        Err(tmux::Error::NotFound { searched }) => (
            absent(TMUX, format!("not on PATH or in any of: {searched}")),
            None,
        ),
        Err(err) => (unknown(TMUX, format!("could not be asked: {err}")), None),
    }
}

async fn agent_cli<E: Exec>(exec: &E) -> (Check, Option<Claude>) {
    match Claude::resolve(exec).await {
        Ok(claude) => (
            present(AGENT_CLI, format!("claude found at {}", claude.path())),
            Some(claude),
        ),
        Err(agent::Error::NotFound { searched }) => (
            absent(
                AGENT_CLI,
                format!("claude is not on PATH or in any of: {searched}"),
            ),
            None,
        ),
        Err(err) => (
            unknown(AGENT_CLI, format!("could not be asked: {err}")),
            None,
        ),
    }
}

/// I-43 bounds what an *absent* here means: `infocmp` answers for the system
/// terminfo database, which is not always the one tmux reads, and the error only
/// ever runs toward a needless fallback.
async fn terminfo<E: Exec>(exec: &E, term: &str) -> Check {
    match terminfo::choose(exec, term).await {
        Ok(Chosen::Known(known)) => present(TERMINFO, format!("that machine knows `{known}`")),
        Ok(Chosen::Substituted { wanted }) => absent(
            TERMINFO,
            format!(
                "no `{wanted}` there, so an attach falls back to `{}` and loses colour depth",
                terminfo::FALLBACK
            ),
        ),
        Err(err) => unknown(TERMINFO, format!("could not be asked: {err}")),
    }
}

async fn provider_cli<E: Exec>(exec: &E) -> (Check, Vec<(&'static str, String)>) {
    let mut found = Vec::new();
    for provider in PROVIDERS {
        match agent::locate(exec, provider).await {
            Ok(Some(path)) => found.push((provider, path)),
            Ok(None) => {}
            Err(err) => {
                return (
                    unknown(PROVIDER_CLI, format!("could not be asked: {err}")),
                    Vec::new(),
                );
            }
        }
    }

    if found.is_empty() {
        return (
            absent(
                PROVIDER_CLI,
                format!(
                    "neither {} is on PATH or in any of: {}",
                    PROVIDERS.join(" nor "),
                    agent::CANDIDATES.join(", ")
                ),
            ),
            found,
        );
    }
    let names: Vec<String> = found
        .iter()
        .map(|(name, path)| format!("{name} at {path}"))
        .collect();
    (present(PROVIDER_CLI, names.join(", ")), found)
}

/// **The output never comes back.** `gh auth status` prints the account it found
/// and a redacted token, and neither belongs in a report this repo can publish —
/// so the far side keeps them and only the exit status crosses (§B4).
///
/// What a pass claims is bounded exactly as I-53 bounds the agent's: a
/// credential was found, and nothing about whether it works.
async fn provider_auth<E: Exec>(exec: &E, providers: Vec<(&'static str, String)>) -> Check {
    if providers.is_empty() {
        return unknown(
            PROVIDER_AUTH,
            "there is no provider CLI on that machine to ask",
        );
    }

    let mut credentialled = Vec::new();
    for (name, path) in &providers {
        let command = format!("{} auth status >/dev/null 2>&1", sq(path));
        match exec.exec(&command).await {
            Ok(out) if out.success() => credentialled.push(*name),
            Ok(_) => {}
            Err(err) => return unknown(PROVIDER_AUTH, format!("could not be asked: {err}")),
        }
    }

    if credentialled.is_empty() {
        let asked: Vec<&str> = providers.iter().map(|(name, _)| *name).collect();
        return absent(
            PROVIDER_AUTH,
            format!("{} found no credential there", asked.join(" and ")),
        );
    }
    present(
        PROVIDER_AUTH,
        format!(
            "{} reports a stored credential — that it works is not asked",
            credentialled.join(" and ")
        ),
    )
}

/// ADR-0018's gate: can the process that will fork the agent reach the account?
///
/// On macOS both halves are asked, and neither may be skipped. §1 is the
/// precondition — a tmux server the *login session* started — and asking for it
/// is [`Tmux::list`], which answers an empty vec where there is no server and
/// starts none. §5 is the gate itself, which on that platform runs inside that
/// server because ssh lands in launchd's `Background` domain and would answer
/// `false` there forever (I-44).
///
/// Linux has no such split — the credential is a file this ssh session can read
/// — so the same question is asked directly, and a pass means what I-53 says it
/// means and no more.
async fn login_session<E: Exec>(exec: &E, tmux: Option<&Tmux>, claude: Option<&Claude>) -> Check {
    let (Some(tmux), Some(claude)) = (tmux, claude) else {
        return unknown(
            LOGIN_SESSION,
            "the gate runs `claude` inside that machine's tmux server, and one of the two was not \
             found there",
        );
    };

    let os = match ssh::os(exec).await {
        Ok(os) => os,
        Err(err) => return unknown(LOGIN_SESSION, format!("could not be asked: {err}")),
    };

    if os == Os::MacOs {
        match tmux.list(exec).await {
            Ok(sessions) if sessions.is_empty() => {
                return absent(
                    LOGIN_SESSION,
                    "macOS, and no tmux server is running — Yantra will not start one, because \
                     panes in a server started over ssh cannot read the login keychain \
                     (ADR-0018 §1, I-44)",
                );
            }
            Ok(_) => {}
            Err(err) => return unknown(LOGIN_SESSION, format!("could not be asked: {err}")),
        }
    }

    match claude.auth(exec, tmux, os).await {
        Ok(auth) if auth.logged_in => present(
            LOGIN_SESSION,
            format!(
                "claude finds a credential where the agent will run (method: {}) — that it works \
                 is not asked",
                auth.method
            ),
        ),
        Ok(auth) => absent(
            LOGIN_SESSION,
            format!(
                "claude finds no credential where the agent will run (method: {})",
                auth.method
            ),
        ),
        Err(err) => unknown(LOGIN_SESSION, format!("could not be asked: {err}")),
    }
}

/// **Unknown from every caller there is today**, and it is the architecture
/// rather than an omission: the beats live in the running daemon's memory and
/// nothing persists them (Y-044), while the CLI calls the library in-process and
/// is not one of that daemon's clients (ADR-0012). A caller that holds them —
/// `yantrad` serving D2.3's cards — is what can answer this.
fn heartbeat() -> Check {
    unknown(
        HEARTBEAT,
        "only the running daemon holds the beats and nothing persists them, so this caller has \
         nothing to read",
    )
}

/// Whether GitHub can be reached from **this** host, which is a different
/// question from every check above and is why it is not one of them.
/// [`crate::attention`] spawns `gh` locally, so the credential the work inbox
/// needs is the one where the daemon runs, and copying an answer about it onto
/// each machine's report would claim something no ssh session asked (R-23).
/// [R13] §2.6a is the manual step it makes visible.
///
/// [R13]: ../../../docs/research/13-dashboard-revamp-and-github.md
pub async fn github() -> Check {
    from_gh(attention::credential().await)
}

/// **`gh auth status` says the same thing about a token GitHub refused as about
/// a GitHub it could not reach** — 2.96.0, measured 2026-08-11: with the API
/// unreachable it prints *the token in keyring is invalid* and exits 1. So only
/// the two failures `gh` names outright are *absent*, and everything else is
/// R-23's *unknown*; an *absent* here would send someone to log in on a box that
/// is already logged in.
///
/// **Nothing `gh` wrote reaches the detail.** Its stderr repeats the whole
/// status report on any failure, account name included, and
/// [`attention::Error::Command`] carries that stderr.
fn from_gh(asked: Result<(), attention::Error>) -> Check {
    match asked {
        Ok(()) => present(
            GITHUB,
            "`gh` reports a stored credential here — that it works is not asked",
        ),
        Err(attention::Error::NotInstalled) => absent(
            GITHUB,
            "no `gh` on this daemon's PATH, and GitHub is read by spawning it here",
        ),
        Err(attention::Error::LoggedOut) => absent(
            GITHUB,
            "`gh` here holds no credential — run `gh auth login` on the machine this daemon runs on",
        ),
        Err(attention::Error::Unreachable) => unknown(
            GITHUB,
            "`gh` could not reach GitHub from here, so what it holds is not known",
        ),
        Err(attention::Error::Command { .. } | attention::Error::Parse { .. }) => unknown(
            GITHUB,
            "`gh auth status` failed and named no reason this recognises",
        ),
    }
}

/// Every check as [`State::Unknown`], for a machine nothing could be asked of.
fn nothing_asked(because: &str) -> Vec<Check> {
    let mut checks = vec![unknown(REACHABLE, because), unknown(SSHD, because)];
    checks.extend(BEHIND_SSH.map(|check| unknown(check, because)));
    checks.push(heartbeat());
    checks
}

fn present(check: &'static str, detail: impl Into<String>) -> Check {
    Check {
        check,
        state: State::Present,
        detail: detail.into(),
    }
}

fn absent(check: &'static str, detail: impl Into<String>) -> Check {
    Check {
        check,
        state: State::Absent,
        detail: detail.into(),
    }
}

fn unknown(check: &'static str, detail: impl Into<String>) -> Check {
    Check {
        check,
        state: State::Unknown,
        detail: detail.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every diagnosis is one OpenSSH really writes into ADR-0006's `-E` log.
    /// The pairs are what D2 §3.1 asks for in one line: a refusal and a timeout
    /// are the same failure to a caller and different facts about the far side.
    #[test]
    fn a_refusal_and_a_silence_say_different_things_about_sshd() {
        let (reachable, sshd) =
            diagnose("ssh: connect to host cachyos-g14 port 22: Connection refused");
        assert_eq!(reachable.state, State::Absent);
        assert_eq!(sshd.state, State::Absent, "{}", sshd.detail);

        let (reachable, sshd) = diagnose("ssh: connect to host pi port 22: Connection timed out");
        assert_eq!(reachable.state, State::Absent);
        assert_eq!(
            sshd.state,
            State::Unknown,
            "a box that never answered has said nothing about its sshd: {}",
            sshd.detail
        );
    }

    /// The refusal that comes *from* sshd is evidence it is running, and the
    /// only one of the three that puts a reader anywhere near a key.
    #[test]
    fn sshd_refusing_a_key_is_an_sshd_that_is_running() {
        let (reachable, sshd) = diagnose("yantra@pi: Permission denied (publickey).");
        assert_eq!(reachable.state, State::Absent);
        assert_eq!(sshd.state, State::Present, "{}", sshd.detail);
        assert_eq!(
            diagnose("Host key verification failed.").1.state,
            State::Present
        );
    }

    /// A silently dropped connection is what `LogFile::read_or_default` answers
    /// for, and it must never make anything read as *not installed*.
    #[test]
    fn a_connection_that_dropped_silently_leaves_sshd_unknown() {
        let (reachable, sshd) = diagnose("no diagnostics; the connection dropped silently");
        assert_eq!(reachable.state, State::Absent);
        assert_ne!(sshd.state, State::Absent, "{}", sshd.detail);
    }

    /// R-23, at the one point a consumer reads: a machine nothing could be asked
    /// of reports the whole list, and not one word of it is *absent*.
    #[test]
    fn a_machine_that_cannot_be_asked_is_never_reported_as_missing_anything() {
        let checks = nothing_asked("ssh could not be set up here");
        assert_eq!(checks.len(), 9);
        assert!(
            checks.iter().all(|c| c.state == State::Unknown),
            "{checks:?}"
        );
        assert!(
            !Report {
                machine: "pi".to_owned(),
                checks,
            }
            .ready(),
            "an answer nobody has is not a yes"
        );
    }

    /// R-23 on the one check that is about this host: `gh` names two failures
    /// outright and those are earned, and a GitHub it could not reach is not one
    /// of them — an *absent* there would send someone to log in on a box that
    /// already is.
    #[test]
    fn only_the_failures_gh_names_are_absent() {
        assert_eq!(
            from_gh(Err(attention::Error::NotInstalled)).state,
            State::Absent
        );
        assert_eq!(
            from_gh(Err(attention::Error::LoggedOut)).state,
            State::Absent
        );
        assert_eq!(
            from_gh(Err(attention::Error::Unreachable)).state,
            State::Unknown
        );
        assert_eq!(from_gh(Ok(())).state, State::Present);
    }

    /// The two *absent* branches send a reader to different places, and only the
    /// detail can say which — the state is the same word for both.
    #[test]
    fn a_missing_gh_and_a_logged_out_gh_are_told_apart_in_the_detail() {
        let missing = from_gh(Err(attention::Error::NotInstalled)).detail;
        let out = from_gh(Err(attention::Error::LoggedOut)).detail;
        assert!(missing.contains("PATH"), "{missing}");
        assert!(out.contains("gh auth login"), "{out}");
    }

    /// `gh auth status` repeats its whole report on stderr when it fails, and
    /// that report names the account — so the detail is written here rather than
    /// quoted from what `gh` said (§B4).
    #[test]
    fn nothing_gh_wrote_reaches_the_detail() {
        let check = from_gh(Err(attention::Error::Command {
            argv: "auth status".to_owned(),
            stderr: "✓ Logged in to github.com account octocat (keyring)".to_owned(),
        }));
        assert_eq!(check.state, State::Unknown);
        assert!(!check.detail.contains("octocat"), "{}", check.detail);
    }
}
