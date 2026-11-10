//! What a machine can and cannot do, asked without changing it.
//!
//! The check list is [D2 §3.1] and the constraint is [D2 §3.2]: `doctor` is a
//! **read**. Nothing here installs, writes or starts anything — the places that
//! could are the macOS branches of [`login_session`] and [`provider_auth`],
//! which ask whether a tmux server exists rather than creating one (ADR-0018 §1).
//!
//! **Every branch answers `Unknown` where it could not ask**, which is R-23 and
//! the reason this module is longer than the commands it runs: *absent* sends a
//! reader to install something and *unknown* sends them to the machine, so a
//! sleeping laptop that reported *absent* would have them installing tmux on a
//! box that already has it.
//!
//! [D2 §3.1]: ../../../docs/design/02-setup.md
//! [D2 §3.2]: ../../../docs/design/02-setup.md

use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use serde_json::Value;

use tokio::time::Instant;

use crate::agent::{self, Claude};
use crate::github;
use crate::identity;
use crate::install;
use crate::ssh::{self, Exec, Os, Ssh};
use crate::terminfo::{self, Chosen};
use crate::tmux::{self, Tmux, sq};
use crate::workspace;

/// The checks, in the order they are reported. The names are the JSON contract
/// an installer and an agent read (D2.2), so renaming one is a breaking change.
const REACHABLE: &str = "reachable";
const SSHD: &str = "sshd";
const TMUX: &str = "tmux";
const GIT: &str = "git";
const AGENT_CLI: &str = "agent-cli";
const TERMINFO: &str = "terminfo";
const PROVIDER_CLI: &str = "provider-cli";
const PROVIDER_AUTH: &str = "provider-auth";
const LOGIN_SESSION: &str = "login-session";
const MIC: &str = "mic";
const FOLDER_ACCESS: &str = "folder-access";
const HOOKS: &str = "hooks";
const NO_SUDO: &str = "no-sudo";
/// Public because the one caller that can answer this check finds it by name —
/// see [`heartbeat`].
pub const HEARTBEAT: &str = "heartbeat";
/// Not one of the checks above: it names a fact about the host this process runs
/// on rather than about a machine being asked — see [`github`].
pub const GITHUB: &str = "github";

/// Everything ssh has to answer for. Listed so an unreachable machine still
/// reports every check rather than a short list a consumer has to interpret.
const BEHIND_SSH: [&str; 11] = [
    TMUX,
    GIT,
    AGENT_CLI,
    TERMINFO,
    PROVIDER_CLI,
    PROVIDER_AUTH,
    LOGIN_SESSION,
    MIC,
    FOLDER_ACCESS,
    HOOKS,
    NO_SUDO,
];

/// What every check behind ssh says when ssh itself did not answer. The reason
/// stays on the `reachable` check, which is the one that has it.
const NOT_ASKED: &str = "nothing behind ssh could be asked — see the `reachable` check";

/// The provider CLIs D2 §3.1 names. `tea` is deliberately not here: it was
/// measured absent on this fleet and nothing in Yantra reads it.
const PROVIDERS: [&str; 2] = ["gh", "glab"];

/// What a provider CLI inside the tmux server prints once it found a credential.
const FOUND: &str = "yantra-credential-found";

/// The web matches on this phrase to show the Terminal fix, so changing it is a
/// breaking change. Both login-keychain checks say it.
const NO_LOGIN_SERVER: &str = "no tmux server from a login session is running on this Mac";

/// What [`NO_LOGIN_SERVER`] costs and how to end it — the command `up` and
/// `commit` give for the same refusal.
fn no_login_server(check: &'static str) -> Check {
    absent(
        check,
        format!(
            "{NO_LOGIN_SERVER}. Panes in a server started over ssh cannot read the login \
             keychain, so Yantra starts one in the login session when a \
             session starts. Start one in Terminal there: `tmux -L yantra new-session -d`"
        ),
    )
}

/// The longest a login may take. `ConnectTimeout` does not cover a server that
/// holds the auth stage, so wording [`ssh::BROWSER_CHECK`] misses would otherwise
/// cost ServerAlive's 45 s on every sweep.
const REACH_LIMIT: Duration = Duration::from_secs(20);

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
    /// How long the step that answered this took. `None` where no step ran,
    /// which zero would misreport (R-23). One command answers `reachable` and
    /// `sshd`, so both carry its time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub took_ms: Option<u64>,
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
    fleet_with(&[], term).await
}

/// [`fleet`], and the `extra` machines as well. A name in both is asked once.
/// The daemon passes its tailnet candidates here (Y-579), which are candidates
/// for the reason [`crate::sessions`] gives.
pub async fn fleet_with(extra: &[String], term: &str) -> Result<Vec<Report>, Error> {
    let mut machines: Vec<String> = workspace::list()?
        .workspaces
        .into_iter()
        .map(|workspace| workspace.machine)
        .collect();
    machines.extend_from_slice(extra);
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
/// is answered better by fourteen states than by one error.
pub async fn machine(name: &str, term: &str) -> Report {
    let ssh = ssh::machine_at(name)
        .ok_or_else(|| "no directory for ssh control sockets on this machine".to_owned())
        .and_then(|m| Ssh::new(m).map_err(|err| err.to_string()));

    let mut checks = match ssh {
        Ok(ssh) => of_with(&ssh, term, Some(name)).await,
        Err(reason) => nothing_asked(&format!("ssh could not be set up here: {reason}")),
    };
    if let Ok(dir) = identity::dir() {
        name_the_account(&mut checks, name, &dir).await;
    }
    Report {
        machine: name.to_owned(),
        checks,
    }
}

/// Y-412: a machine that never ran the join command has no block in the ssh
/// config in `dir`, so ssh logs in as this account's own name, which the far
/// side rarely has. When `reachable` failed, its detail says so first.
pub async fn name_the_account(checks: &mut [Check], machine: &str, dir: &std::path::Path) {
    let Some(reachable) = checks
        .iter_mut()
        .find(|check| check.check == REACHABLE && check.state == State::Absent)
    else {
        return;
    };
    // I-13: `ssh -G` is a blocking spawn.
    let (dir, name) = (dir.to_owned(), machine.to_owned());
    let asked = tokio::task::spawn_blocking(move || identity::unnamed_in(&dir, &name)).await;
    if let Ok(Some(account)) = asked {
        reachable.detail = format!(
            "the ssh config here names no account for {machine}, so ssh tried `{account}` — run \
             the join command on {machine} (Add a device, or `yantra join-script`) · {}",
            reachable.detail
        );
    }
}

/// The testable half.
///
/// `term` is the terminal the caller is sitting at, which is what the terminfo
/// check is about (I-36) — it is a property of the asker, not of the machine.
pub async fn of<E: Exec>(exec: &E, term: &str) -> Vec<Check> {
    of_with(exec, term, None).await
}

/// [`of`], reusing `machine`'s recent `sudo -n` answer where there is one (see
/// [`no_sudo`]). `None` always asks.
async fn of_with<E: Exec>(exec: &E, term: &str, machine: Option<&str>) -> Vec<Check> {
    let (reachable, sshd) = timed(reached(exec)).await;
    let sshd = Check {
        took_ms: reachable.took_ms,
        ..sshd
    };
    if reachable.state != State::Present {
        // The diagnosis stays on the check that has it rather than being copied
        // onto six more rows, none of which a reader would act on twice.
        let mut checks = vec![reachable, sshd];
        checks.extend(BEHIND_SSH.map(|check| unknown(check, NOT_ASKED)));
        checks.push(heartbeat());
        return checks;
    }

    let (tmux, found_tmux) = timed(tmux(exec)).await;
    let (agent_cli, found_claude) = timed(agent_cli(exec)).await;
    let (provider_cli, providers) = timed(provider_cli(exec)).await;
    let gated = found_tmux.is_some() && found_claude.is_some();
    let has_provider = !providers.is_empty();
    let os = ssh::os(exec).await;

    vec![
        reachable,
        sshd,
        tmux,
        timed_one(git(exec)).await,
        agent_cli,
        timed_one(terminfo(exec, term)).await,
        provider_cli,
        timed_if(
            has_provider,
            provider_auth(exec, providers, found_tmux.as_ref(), &os),
        )
        .await,
        timed_if(
            gated,
            login_session(exec, found_tmux.as_ref(), found_claude.as_ref(), &os),
        )
        .await,
        timed_one(mic(exec)).await,
        timed_one(folder_access(exec)).await,
        timed_one(hooks(exec, found_tmux.as_ref(), &os)).await,
        timed_one(no_sudo(exec, machine)).await,
        heartbeat(),
    ]
}

async fn timed<T>(step: impl Future<Output = (Check, T)>) -> (Check, T) {
    let started = Instant::now();
    let (mut check, found) = step.await;
    check.took_ms = Some(u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX));
    (check, found)
}

async fn timed_one(step: impl Future<Output = Check>) -> Check {
    timed(async { (step.await, ()) }).await.0
}

/// `asked` is false where a step has nothing to ask with and answers at once.
async fn timed_if(asked: bool, step: impl Future<Output = Check>) -> Check {
    if asked {
        timed_one(step).await
    } else {
        step.await
    }
}

/// One command that does nothing, which is the whole of *can Yantra reach this
/// machine* — and, when it fails, the only evidence about the far end's sshd.
async fn reached<E: Exec>(exec: &E) -> (Check, Check) {
    match tokio::time::timeout(REACH_LIMIT, exec.exec("true")).await {
        Ok(Ok(_)) => (
            present(REACHABLE, "a command ran there and reported its own status"),
            present(SSHD, "it answered, so one is listening"),
        ),
        // The transport failed before the command reported anything, so `ssh`'s
        // own diagnostic is all there is to go on (ADR-0006's `-E` log).
        Ok(Err(ssh::Error::Transport { diagnosis, .. })) => diagnose(&diagnosis),
        Ok(Err(err)) => (
            unknown(REACHABLE, format!("ssh could not be run from here: {err}")),
            unknown(SSHD, format!("ssh could not be run from here: {err}")),
        ),
        Err(_) => diagnose(&format!(
            "the login did not finish within {}s",
            REACH_LIMIT.as_secs()
        )),
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

    if diagnosis.contains(ssh::BROWSER_CHECK) {
        return (
            unreachable(diagnosis.to_owned()),
            present(SSHD, "Tailscale SSH answered on the ssh port"),
        );
    }
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
    // Y-621: Tailscale SSH has its own host key, so turning it off changes the
    // key, and so does a reinstall. Only a person can tell those from an attack.
    if said.contains("host key verification failed")
        || said.contains("remote host identification has changed")
    {
        return (
            unreachable(format!(
                "the machine answered with a host key the appliance did not record for it: \
                 {diagnosis}"
            )),
            present(SSHD, "a server sent its host key, so one is running"),
        );
    }
    // sshd itself wrote this, so it exists — what failed is this key, which is
    // a different thing to go and fix.
    if said.contains("permission denied") {
        return (
            unreachable(format!("sshd refused this connection: {diagnosis}")),
            present(SSHD, "the refusal came from sshd itself, so one is running"),
        );
    }
    // Y-412: Tailscale SSH refuses an account this way, after a banner.
    if said.contains("connection closed by") {
        return (
            unreachable(format!("the ssh server closed the connection: {diagnosis}")),
            present(
                SSHD,
                "something answered on the ssh port before it closed the connection",
            ),
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

/// [`agent::locate`]'s search in the same one round trip, and one more
/// question on macOS only: `/usr/bin/git` there is a stub asking for the
/// Command Line Tools, and it is git once `xcode-select -p` answers.
/// [`crate::install`] asks this too, so the two never disagree.
pub(crate) async fn find_git<E: Exec>(exec: &E) -> Result<Option<String>, agent::Error> {
    // `(/*)`, as in `agent::probe` (Y-634, Y-635).
    let probe = format!(
        "p=$(command -v git 2>/dev/null)\n\
         case \"$p\" in (/*) ;; (*) p=\n\
         \x20 for d in {dirs}; do [ -x \"$d/git\" ] && {{ p=\"$d/git\"; break; }}; done ;;\n\
         esac\n\
         [ -n \"$p\" ] || exit 1\n\
         if [ \"$p\" = /usr/bin/git ] && [ \"$(uname -s)\" = Darwin ] \
         && ! xcode-select -p >/dev/null 2>&1; then exit 1; fi\n\
         printf '%s\\n' \"$p\"\n",
        dirs = agent::CANDIDATES.join(" "),
    );
    let out = exec.exec(&probe).await?;
    let path = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    Ok((out.success() && path.starts_with('/')).then_some(path))
}

async fn git<E: Exec>(exec: &E) -> Check {
    match find_git(exec).await {
        Ok(Some(path)) => present(GIT, format!("found at {path}")),
        Ok(None) => absent(
            GIT,
            format!("not on PATH or in any of: {}", agent::CANDIDATES.join(", ")),
        ),
        Err(err) => unknown(GIT, format!("could not be asked: {err}")),
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
///
/// On macOS a token in the login keychain is out of ssh's reach (I-44), so a
/// miss there is asked again inside the login session's tmux server, as the
/// agent's gate is (ADR-0018 §5).
async fn provider_auth<E: Exec>(
    exec: &E,
    providers: Vec<(&'static str, String)>,
    tmux: Option<&Tmux>,
    os: &Result<Os, ssh::Error>,
) -> Check {
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
        match os {
            Ok(Os::Other) => {}
            Ok(Os::MacOs) => match asked_inside(exec, &providers, tmux).await {
                Ok(found) => credentialled = found,
                Err(check) => return check,
            },
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

/// [`provider_auth`]'s question again, inside the Mac's login-session tmux
/// server. `Err` is the check to report, because it could not be asked there.
async fn asked_inside<E: Exec>(
    exec: &E,
    providers: &[(&'static str, String)],
    tmux: Option<&Tmux>,
) -> Result<Vec<&'static str>, Check> {
    let Some(tmux) = tmux else {
        return Err(unknown(
            PROVIDER_AUTH,
            "macOS keeps the credential in the login keychain, which only that machine's tmux \
             server can reach, and tmux was not found there",
        ));
    };
    let could_not =
        |err: &dyn std::fmt::Display| unknown(PROVIDER_AUTH, format!("could not be asked: {err}"));
    if !tmux.running(exec).await.map_err(|err| could_not(&err))? {
        return Err(no_login_server(PROVIDER_AUTH));
    }

    let mut found = Vec::new();
    for (name, path) in providers {
        // run-shell ends in `exit 0`, so the status crosses as a mark on stdout.
        let command = format!("{} auth status >/dev/null 2>&1 && echo {FOUND}", sq(path));
        let out = exec
            .exec(&tmux::run_shell(&tmux.command(), &command))
            .await
            .map_err(|err| could_not(&err))?;
        if !out.success() {
            return Err(could_not(&String::from_utf8_lossy(&out.stderr).trim()));
        }
        if String::from_utf8_lossy(&out.stdout).contains(FOUND) {
            found.push(*name);
        }
    }
    Ok(found)
}

/// ADR-0018's gate: can the process that will fork the agent reach the account?
///
/// On macOS both halves are asked, and neither may be skipped. §1 is the
/// precondition — a tmux server the *login session* started — and asking for it
/// is [`Tmux::running`], which starts none. §5 is the gate itself, which on that
/// platform runs inside that server because ssh lands in launchd's `Background`
/// domain and would answer `false` there forever (I-44).
///
/// Linux has no such split — the credential is a file this ssh session can read
/// — so the same question is asked directly, and a pass means what I-53 says it
/// means and no more.
async fn login_session<E: Exec>(
    exec: &E,
    tmux: Option<&Tmux>,
    claude: Option<&Claude>,
    os: &Result<Os, ssh::Error>,
) -> Check {
    let (Some(tmux), Some(claude)) = (tmux, claude) else {
        return unknown(
            LOGIN_SESSION,
            "the gate runs `claude` inside that machine's tmux server, and one of the two was not \
             found there",
        );
    };

    let os = match os {
        Ok(os) => *os,
        Err(err) => return unknown(LOGIN_SESSION, format!("could not be asked: {err}")),
    };

    if os == Os::MacOs {
        match tmux.running(exec).await {
            Ok(false) => return no_login_server(LOGIN_SESSION),
            Ok(true) => {}
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

/// ADR-0031 §9 in one round trip. The first line is `absent` (no drop-in),
/// `present`, or `linger=<value> <account>` followed by what `pactl` said. It reads
/// linger first: an ssh login starts the user manager, so a source listed
/// without linger is gone at the next logout and is not `present`.
fn mic_probe() -> String {
    format!(
        r#"[ -e "$HOME/{drop_in}" ] || {{ echo absent; exit 0; }}
linger=$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)
said=$(XDG_RUNTIME_DIR=/run/user/$(id -u) pactl list short sources 2>&1)
if [ "$linger" = yes ] && printf '%s\n' "$said" | cut -f2 | grep -qx yantra-mic; then echo present; exit 0; fi
echo "linger=$linger $(id -un)"
printf '%s\n' "$said""#,
        drop_in = install::MIC_DROP_IN,
    )
}

async fn mic<E: Exec>(exec: &E) -> Check {
    match exec.exec(&mic_probe()).await {
        Ok(out) => mic_from(&String::from_utf8_lossy(&out.stdout)),
        Err(err) => unknown(MIC, format!("could not be asked: {err}")),
    }
}

/// *Absent* where the microphone was never installed, which is no fault: it
/// is optional, and the dashboard does not count it against readiness.
fn mic_from(said: &str) -> Check {
    let (first, rest) = said.split_once('\n').unwrap_or((said, ""));
    let pactl = match rest.trim() {
        "" => "nothing".to_owned(),
        rest => rest.to_owned(),
    };
    let first = first.trim();
    if let Some(linger) = first.strip_prefix("linger=") {
        let (linger, account) = linger.split_once(' ').unwrap_or((linger, ""));
        if linger == "yes" {
            return absent(
                MIC,
                format!("the drop-in is there and PipeWire has no yantra-mic; pactl said: {pactl}"),
            );
        }
        let account = account.trim();
        let command = if account.is_empty() {
            "`sudo loginctl enable-linger` for it".to_owned()
        } else {
            format!("`sudo loginctl enable-linger {account}`")
        };
        return absent(
            MIC,
            format!(
                "linger is off for this account, so PipeWire and yantra-mic stop when nobody is \
                 logged in — run {command} there; pactl said: {pactl}"
            ),
        );
    }
    match first {
        "absent" => absent(MIC, "not installed — the microphone is optional"),
        "present" => present(MIC, "PipeWire has the source yantra-mic"),
        _ => unknown(
            MIC,
            format!("the probe answered nothing Yantra reads: {said}"),
        ),
    }
}

/// The folders macOS keeps from an ssh login until Remote Login allows full
/// disk access (Y-458).
const GUARDED: [&str; 3] = ["Desktop", "Documents", "Downloads"];

/// One round trip: `other` off macOS, else `darwin` and one `refused <folder>`
/// line for each guarded folder `ls -A` cannot read. `dirs.rs` uses the same signal.
fn folder_access_probe() -> String {
    format!(
        r#"[ "$(uname -s)" = Darwin ] || {{ echo other; exit 0; }}
echo darwin
for f in {folders}; do [ -d "$HOME/$f" ] && ! ls -A "$HOME/$f" >/dev/null 2>&1 && echo "refused $f"; done; true"#,
        folders = GUARDED.join(" "),
    )
}

async fn folder_access<E: Exec>(exec: &E) -> Check {
    match exec.exec(&folder_access_probe()).await {
        Ok(out) => folder_access_from(&String::from_utf8_lossy(&out.stdout)),
        Err(err) => unknown(FOLDER_ACCESS, format!("could not be asked: {err}")),
    }
}

fn folder_access_from(said: &str) -> Check {
    let mut lines = said.lines().map(str::trim).filter(|line| !line.is_empty());
    let refused: Option<Vec<&str>> = match lines.next() {
        Some("other") => return present(FOLDER_ACCESS, "only macOS blocks folders over ssh"),
        Some("darwin") => lines.map(|line| line.strip_prefix("refused ")).collect(),
        _ => None,
    };
    match refused {
        None => unknown(
            FOLDER_ACCESS,
            format!("the probe answered nothing Yantra reads: {said}"),
        ),
        Some(refused) if refused.is_empty() => present(
            FOLDER_ACCESS,
            "an ssh login can read Desktop, Documents and Downloads",
        ),
        Some(refused) => absent(
            FOLDER_ACCESS,
            format!(
                "macOS blocks an ssh login from {} — to allow it, open System Settings > General > \
                 Sharing > Remote Login and turn on Allow full disk access for remote users; every \
                 ssh login to this Mac, agents included, then gets that access",
                refused.join(", ")
            ),
        ),
    }
}

/// Splits what [`read_files`] printed. A file it could not read is empty.
const HOOK_FILE: &str = "yantra-hook-file";

/// Each of `files` (shell words) after a [`HOOK_FILE`] line, in one round trip.
fn read_files(files: &str) -> String {
    format!(
        "for f in {files}; do printf '\\n%s\\n' {HOOK_FILE}; cat \"$f\" 2>/dev/null; done; exit 0"
    )
}

/// The `count` files [`read_files`] printed, each as JSON, or `None` when the
/// output is not that shape. An empty file is `Value::Null`; `Err` names the
/// file that is not JSON, and never its contents (Q5).
fn files_from(said: &str, names: &[&str]) -> Option<Result<Vec<Value>, String>> {
    let mark = format!("\n{HOOK_FILE}\n");
    let mut parts = said.split(&mark);
    parts.next()?;
    let files: Vec<&str> = parts.collect();
    if files.len() != names.len() {
        return None;
    }
    Some(
        files
            .iter()
            .zip(names)
            .map(|(text, name)| match text.trim() {
                "" => Ok(Value::Null),
                text => serde_json::from_str(text).map_err(|_| (*name).to_owned()),
            })
            .collect(),
    )
}

/// Each program a hook needs on `PATH`, with the events and sources that run it.
type Uses = BTreeMap<String, (BTreeSet<String>, BTreeSet<String>)>;

/// Words that are no program to find on `PATH`. A hook that starts with
/// `command -v node &&` guards itself.
const BUILTINS: [&str; 8] = [
    "command", "exec", "export", "if", "test", "true", "exit", "cd",
];

/// The program a hook runs: `command` itself when it has `args`, else the shell
/// line's first word after any `VAR=value`. A path or a word the shell would
/// expand is not looked up on `PATH`, so it is `None`.
fn program(hook: &Value) -> Option<&str> {
    let command = hook.get("command")?.as_str()?.trim();
    let name = if hook.get("args").is_some() {
        command
    } else {
        command.split_whitespace().find(|word| {
            !word.split_once('=').is_some_and(|(key, _)| {
                !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            })
        })?
    };
    let plain = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._+-".contains(c));
    (plain && !BUILTINS.contains(&name)).then_some(name)
}

/// The command hooks in a `hooks` object, as settings.json and a plugin's
/// hooks.json both hold it.
fn hooks_in(hooks: Option<&Value>, source: &str, uses: &mut Uses) {
    let Some(events) = hooks.and_then(Value::as_object) else {
        return;
    };
    for (event, groups) in events {
        let groups = groups.as_array().into_iter().flatten();
        for hook in groups
            .filter_map(|group| group.get("hooks")?.as_array())
            .flatten()
        {
            if hook.get("type").and_then(Value::as_str) != Some("command") {
                continue;
            }
            if let Some(name) = program(hook) {
                let (events, sources) = uses.entry(name.to_owned()).or_default();
                events.insert(event.clone());
                sources.insert(source.to_owned());
            }
        }
    }
}

/// The hooks the agent runs: settings.json's own, then each enabled plugin's.
/// `Err` is the check to report.
async fn hook_commands<E: Exec>(exec: &E) -> Result<Uses, Check> {
    let could_not =
        |err: &dyn std::fmt::Display| unknown(HOOKS, format!("could not be asked: {err}"));
    let not_read = || unknown(HOOKS, "the probe answered nothing Yantra reads");
    let not_json = |file: String| unknown(HOOKS, format!("{file} is not JSON Yantra can read"));

    let names = [
        "~/.claude/settings.json",
        "~/.claude/plugins/installed_plugins.json",
    ];
    let words: Vec<String> = names
        .iter()
        .map(|name| name.replacen('~', "\"$HOME", 1) + "\"")
        .collect();
    let out = exec
        .exec(&read_files(&words.join(" ")))
        .await
        .map_err(|err| could_not(&err))?;
    let files = files_from(&String::from_utf8_lossy(&out.stdout), &names)
        .ok_or_else(not_read)?
        .map_err(not_json)?;
    let (settings, installed) = (&files[0], &files[1]);

    let mut uses = Uses::new();
    hooks_in(settings.get("hooks"), "settings.json", &mut uses);

    let plugins: Vec<(&str, String)> = settings
        .get("enabledPlugins")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter(|(_, on)| on.as_bool() == Some(true))
        .filter_map(|(name, _)| {
            let root = installed
                .get("plugins")?
                .get(name)?
                .get(0)?
                .get("installPath")?;
            Some((
                name.as_str(),
                format!("{}/hooks/hooks.json", root.as_str()?),
            ))
        })
        .collect();
    if plugins.is_empty() {
        return Ok(uses);
    }

    let paths: Vec<String> = plugins.iter().map(|(_, path)| sq(path)).collect();
    let out = exec
        .exec(&read_files(&paths.join(" ")))
        .await
        .map_err(|err| could_not(&err))?;
    let names: Vec<&str> = plugins.iter().map(|(name, _)| *name).collect();
    let files = files_from(&String::from_utf8_lossy(&out.stdout), &names)
        .ok_or_else(not_read)?
        .map_err(|plugin| not_json(format!("the hooks.json of {plugin}")))?;
    for (file, plugin) in files.iter().zip(names) {
        hooks_in(file.get("hooks"), plugin, &mut uses);
    }
    Ok(uses)
}

/// Precedes the names [`hooks`] could not find.
const UNRESOLVED: &str = "yantra-unresolved";

/// Y-640: a hook whose program the agent's `PATH` lacks fails each time the
/// agent starts. That `PATH` is the tmux server's, so a running server is
/// asked through `run-shell` (I-55). With none, Linux's next server inherits
/// ssh's, and a Mac's is the LaunchAgent's, which cannot be asked yet.
async fn hooks<E: Exec>(exec: &E, tmux: Option<&Tmux>, os: &Result<Os, ssh::Error>) -> Check {
    let could_not =
        |err: &dyn std::fmt::Display| unknown(HOOKS, format!("could not be asked: {err}"));
    let uses = match hook_commands(exec).await {
        Ok(uses) => uses,
        Err(check) => return check,
    };
    if uses.is_empty() {
        return present(HOOKS, "no hook names a command");
    }

    let words: Vec<String> = uses.keys().map(|name| sq(name)).collect();
    let probe = format!(
        "echo {UNRESOLVED}; for n in {}; do command -v \"$n\" >/dev/null 2>&1 || echo \"$n\"; done",
        words.join(" ")
    );
    let os = match os {
        Ok(os) => *os,
        Err(err) => return could_not(err),
    };
    let inside = match tmux {
        Some(tmux) => match tmux.running(exec).await {
            Ok(running) => running.then_some(tmux),
            Err(err) => return could_not(&err),
        },
        None => None,
    };
    let command = match (inside, os) {
        (Some(tmux), _) => tmux::run_shell(&tmux.command(), &probe),
        (None, Os::Other) => probe,
        (None, Os::MacOs) => {
            return unknown(
                HOOKS,
                "an agent on this Mac gets the PATH of the tmux server Yantra's LaunchAgent \
                 starts, and it cannot be asked until that server runs",
            );
        }
    };

    let out = match exec.exec(&command).await {
        Ok(out) if out.success() => out,
        Ok(out) => return could_not(&String::from_utf8_lossy(&out.stderr).trim()),
        Err(err) => return could_not(&err),
    };
    let said = String::from_utf8_lossy(&out.stdout);
    let Some((_, after)) = said.split_once(&format!("{UNRESOLVED}\n")) else {
        return unknown(HOOKS, "the probe answered nothing Yantra reads");
    };
    let missing: Vec<String> = after
        .lines()
        .filter_map(|line| uses.get_key_value(line.trim()))
        .map(|(name, (events, sources))| {
            let events: Vec<&str> = events.iter().map(String::as_str).collect();
            let sources: Vec<&str> = sources.iter().map(String::as_str).collect();
            format!(
                "`{name}` ({} in {})",
                events.join(", "),
                sources.join(" and ")
            )
        })
        .collect();
    if missing.is_empty() {
        let names: Vec<&str> = uses.keys().map(String::as_str).collect();
        return present(
            HOOKS,
            format!(
                "the agent's PATH has every command a hook names: {}",
                names.join(", ")
            ),
        );
    }
    absent(
        HOOKS,
        format!(
            "the agent's PATH lacks {}, so those hooks fail each time an agent starts",
            missing.join("; ")
        ),
    )
}

/// Groups whose members sudo lets in on a stock install; macOS admins are in `admin`.
const SUDO_GROUPS: [&str; 3] = ["sudo", "wheel", "admin"];

/// Asks nothing of sudo, so it runs on every sweep.
const GROUPS_PROBE: &str =
    r#"if [ "$(id -u)" = 0 ]; then echo root; else echo "groups $(id -Gn)"; fi"#;

/// Catches a `NOPASSWD` rule (ADR-0046 decision 3.1). `-n` never prompts.
const RULE_PROBE: &str = "command -v sudo >/dev/null 2>&1 || { echo none; exit 0; }
if sudo -n true >/dev/null 2>&1; then echo runs; else echo refused; fi";

/// Every refused `sudo -n` writes an auth-log line, and the sweep runs every
/// 30 s, so [`RULE_PROBE`] is asked of a machine at most this often.
const RULE_EVERY: Duration = Duration::from_secs(60 * 60);

/// [`RULE_PROBE`]'s last answer per machine. In memory only: the daemon persists nothing.
static RULES: Mutex<BTreeMap<String, (Instant, Check)>> = Mutex::new(BTreeMap::new());

/// Whether the joined account cannot use sudo (ADR-0046 decision 3). Agents run
/// as that account, so *absent* is a warning: a prompt-injected agent with root
/// owns the machine. `machine` names the memo [`RULES`] keeps; `None` always asks.
async fn no_sudo<E: Exec>(exec: &E, machine: Option<&str>) -> Check {
    let said = match exec.exec(GROUPS_PROBE).await {
        Ok(out) => String::from_utf8_lossy(&out.stdout).into_owned(),
        Err(err) => return unknown(NO_SUDO, format!("could not be asked: {err}")),
    };
    if let Some(found) = groups_from(&said) {
        return found;
    }
    let Some(machine) = machine else {
        return sudo_rule(exec).await;
    };
    let now = Instant::now();
    let remembered = RULES
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(machine)
        .filter(|(asked, _)| now.duration_since(*asked) < RULE_EVERY)
        .map(|(_, check)| check.clone());
    if let Some(check) = remembered {
        return check;
    }
    let check = sudo_rule(exec).await;
    // An unknown is asked again on the next sweep.
    if check.state != State::Unknown {
        RULES
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(machine.to_owned(), (now, check.clone()));
    }
    check
}

/// `None` where neither root nor a sudo group was found, so [`RULE_PROBE`] decides.
fn groups_from(said: &str) -> Option<Check> {
    let said = said.trim();
    if said == "root" {
        return Some(absent(NO_SUDO, "the account is root"));
    }
    let Some(groups) = said.strip_prefix("groups ") else {
        return Some(unknown(
            NO_SUDO,
            format!("the probe answered nothing Yantra reads: {said}"),
        ));
    };
    let group = groups
        .split_whitespace()
        .find(|group| SUDO_GROUPS.contains(group))?;
    Some(absent(
        NO_SUDO,
        format!("the account is in the {group} group"),
    ))
}

async fn sudo_rule<E: Exec>(exec: &E) -> Check {
    match exec.exec(RULE_PROBE).await {
        Ok(out) => rule_from(&String::from_utf8_lossy(&out.stdout)),
        Err(err) => unknown(NO_SUDO, format!("could not be asked: {err}")),
    }
}

fn rule_from(said: &str) -> Check {
    match said.trim() {
        "none" => present(NO_SUDO, "there is no sudo here"),
        "refused" => present(
            NO_SUDO,
            "not root, in no sudo, wheel or admin group, and sudo -n did not run",
        ),
        "runs" => absent(NO_SUDO, "sudo -n runs without a password"),
        said => unknown(
            NO_SUDO,
            format!("the probe answered nothing Yantra reads: {said}"),
        ),
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

/// Whether the grant this process holds is present and still accepted
/// ([ADR-0023]), which is a question about **this** host and not about a
/// machine being swept — copying it onto each machine's report would claim
/// something no ssh session asked (R-23). `provider-auth` keeps asking whether
/// the machine can clone. `None` is no grant; the `Result` is `GET /user`'s
/// answer, which the caller holding the grant asks.
///
/// **Only two answers are *absent*, and both are earned**: no grant, and a
/// grant GitHub refused. A GitHub that could not be reached is *unknown* — an
/// *absent* there would send someone to sign in on a box that already has.
///
/// [ADR-0023]: ../../../docs/adr/0023-the-github-grant-lives-beside-the-relay.md
pub fn github(asked: Option<&Result<String, github::Error>>) -> Check {
    match asked {
        None => absent(
            GITHUB,
            "no GitHub grant — run `yantra github login`, or sign in from the dashboard",
        ),
        Some(Ok(login)) => present(
            GITHUB,
            format!("GitHub accepts the grant, signed in as {login}"),
        ),
        Some(Err(github::Error::Refused)) => absent(
            GITHUB,
            "GitHub refused the grant — it was revoked or replaced, so sign in again",
        ),
        Some(Err(error)) => unknown(
            GITHUB,
            format!("GitHub could not be asked whether it accepts the grant: {error}"),
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
        took_ms: None,
    }
}

fn absent(check: &'static str, detail: impl Into<String>) -> Check {
    Check {
        check,
        state: State::Absent,
        detail: detail.into(),
        took_ms: None,
    }
}

fn unknown(check: &'static str, detail: impl Into<String>) -> Check {
    Check {
        check,
        state: State::Unknown,
        detail: detail.into(),
        took_ms: None,
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)]
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

    /// Y-621: OpenSSH's own words for a changed key, as `ssh -E` logged them
    /// against github.com with a wrong key recorded (2026-11-04).
    #[test]
    fn a_changed_host_key_says_so_and_is_a_server_that_answered() {
        let said = "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n\
                    @    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n\
                    @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n\
                    IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!\n\
                    Someone could be eavesdropping on you right now (man-in-the-middle attack)!\n\
                    It is also possible that a host key has just been changed.\n\
                    The fingerprint for the ED25519 key sent by the remote host is\n\
                    SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU.\n\
                    Please contact your system administrator.\n\
                    Add correct host key in /run/user/1000/yantra/known_hosts to get rid of this message.\n\
                    Offending ED25519 key in /run/user/1000/yantra/known_hosts:1\n\
                    Host key for pi has changed and you have requested strict checking.\n\
                    Host key verification failed.";
        let (reachable, sshd) = diagnose(said);
        assert_eq!(reachable.state, State::Absent);
        assert!(
            reachable
                .detail
                .starts_with("the machine answered with a host key the appliance did not record"),
            "{}",
            reachable.detail
        );
        assert!(
            reachable.detail.contains("known_hosts:1"),
            "{}",
            reachable.detail
        );
        assert!(
            !reachable.detail.contains("sshd refused"),
            "{}",
            reachable.detail
        );
        assert_eq!(sshd.state, State::Present, "{}", sshd.detail);
    }

    /// Y-412, as the appliance logged it on 2026-09-28: the banner is the
    /// reason, and the server that sent it is running.
    #[test]
    fn a_server_that_closes_after_a_banner_is_running_and_its_words_are_kept() {
        let said = "tailscale: tailnet policy does not permit you to SSH as user \"yantra\"\n\
                    Connection closed by 100.108.185.80 port 22";
        let (reachable, sshd) = diagnose(said);
        assert_eq!(reachable.state, State::Absent);
        assert!(
            reachable.detail.contains("does not permit"),
            "{}",
            reachable.detail
        );
        assert!(
            !reachable.detail.contains("no answer"),
            "{}",
            reachable.detail
        );
        assert_eq!(sshd.state, State::Present, "{}", sshd.detail);
    }

    /// Y-585: `ssh::exec` stops at this phrase, and the server that sent it
    /// is running, so this is not a silence.
    #[test]
    fn a_browser_check_is_a_server_that_answered() {
        let (reachable, sshd) = diagnose(ssh::BROWSER_DIAGNOSIS);
        assert_eq!(reachable.state, State::Absent);
        assert!(
            reachable.detail.contains(ssh::BROWSER_CHECK),
            "{}",
            reachable.detail
        );
        assert!(
            !reachable.detail.contains("no answer"),
            "{}",
            reachable.detail
        );
        assert_eq!(sshd.state, State::Present, "{}", sshd.detail);
    }

    /// Answers every command the same way, as a machine with nothing to say.
    struct Answers {
        status: i32,
        stdout: &'static str,
    }

    impl Exec for Answers {
        async fn exec(&self, _command: &str) -> Result<ssh::Output, ssh::Error> {
            Ok(ssh::Output {
                status: self.status,
                stdout: self.stdout.as_bytes().to_vec(),
                stderr: Vec::new(),
            })
        }
    }

    fn took(checks: &[Check], name: &str) -> Option<u64> {
        checks
            .iter()
            .find(|check| check.check == name)
            .expect("the list holds it")
            .took_ms
    }

    #[tokio::test]
    async fn every_step_that_ran_says_how_long_it_took() {
        let machine = Answers {
            status: 0,
            stdout: "/usr/bin/found\n",
        };
        let checks = of(&machine, "alacritty").await;
        for check in &checks {
            assert_eq!(
                check.took_ms.is_some(),
                check.check != HEARTBEAT,
                "{}: {:?}",
                check.check,
                check.took_ms
            );
        }
    }

    /// R-23: a step with nothing to ask with has no time, and zero would say
    /// it ran.
    #[tokio::test]
    async fn a_step_that_had_nothing_to_ask_with_has_no_time() {
        let machine = Answers {
            status: 1,
            stdout: "",
        };
        let checks = of(&machine, "alacritty").await;
        assert!(took(&checks, "tmux").is_some());
        assert_eq!(took(&checks, PROVIDER_AUTH), None);
        assert_eq!(took(&checks, LOGIN_SESSION), None);
        assert_eq!(took(&checks, HEARTBEAT), None);
    }

    struct Refuses;

    impl Exec for Refuses {
        async fn exec(&self, _command: &str) -> Result<ssh::Output, ssh::Error> {
            Err(ssh::Error::Transport {
                host: "pi".to_owned(),
                diagnosis: "Connection refused".to_owned(),
            })
        }
    }

    /// One command answers both, and nothing behind ssh was asked.
    #[tokio::test]
    async fn a_failed_reach_times_only_the_command_that_failed() {
        let checks = of(&Refuses, "alacritty").await;
        assert_eq!(took(&checks, REACHABLE), took(&checks, SSHD));
        assert!(took(&checks, REACHABLE).is_some());
        for check in BEHIND_SSH.into_iter().chain([HEARTBEAT]) {
            assert_eq!(took(&checks, check), None, "{check}");
        }
    }

    struct Hangs;

    impl Exec for Hangs {
        async fn exec(&self, _command: &str) -> Result<ssh::Output, ssh::Error> {
            std::future::pending().await
        }
    }

    /// The limit behind the phrase: a server that holds the auth stage in
    /// words Yantra does not know still ends here, and says nothing about sshd.
    #[tokio::test(start_paused = true)]
    async fn a_login_that_never_finishes_ends_at_the_limit() {
        let checks = of(&Hangs, "alacritty").await;
        let reachable = &checks[0];
        assert_eq!(reachable.state, State::Absent);
        assert!(
            reachable.detail.contains("no answer"),
            "{}",
            reachable.detail
        );
        assert_eq!(checks[1].state, State::Unknown);
        assert_eq!(reachable.took_ms, Some(REACH_LIMIT.as_millis() as u64));
    }

    /// Only a failed `reachable` is annotated, and only when no block names
    /// the machine — the one case the join command fixes.
    #[tokio::test]
    async fn a_machine_no_block_names_is_sent_to_the_join_command() {
        let dir =
            std::env::temp_dir().join(format!("yantra-doctor-unnamed-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("scratch");
        std::fs::write(dir.join("config"), "Host pi\n    User biswa\n").expect("a config");
        let failed = || {
            let (reachable, sshd) = diagnose("Connection closed by 100.108.185.80 port 22");
            vec![reachable, sshd]
        };

        let mut checks = failed();
        name_the_account(&mut checks, "cachyos-g14", &dir).await;
        let detail = &checks[0].detail;
        assert!(
            detail.contains("names no account for cachyos-g14"),
            "{detail}"
        );
        assert!(detail.contains("Add a device"), "{detail}");
        assert!(
            detail.ends_with("port 22"),
            "the diagnosis is kept: {detail}"
        );

        let mut checks = failed();
        name_the_account(&mut checks, "pi", &dir).await;
        assert_eq!(
            checks,
            failed(),
            "a block names pi, so the join is not the fix"
        );

        let mut checks = vec![present(REACHABLE, "ran")];
        name_the_account(&mut checks, "cachyos-g14", &dir).await;
        assert_eq!(checks[0].detail, "ran");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A silently dropped connection is what `ssh::diagnosis` answers for when
    /// nothing was said, and it must never make anything read as *not installed*.
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
        assert_eq!(checks.len(), 14);
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

    /// ADR-0031 §9: never installed, working, and the two ways it fails —
    /// the second names linger, which is what a logout without it costs.
    #[test]
    fn the_mic_check_tells_not_installed_from_broken() {
        let none = mic_from("absent\n");
        assert_eq!(none.state, State::Absent);
        assert!(none.detail.contains("not installed"), "{}", none.detail);

        assert_eq!(mic_from("present\n").state, State::Present);

        let lingerless = mic_from("linger=no biswa\nConnection failure: Connection refused\n");
        assert_eq!(lingerless.state, State::Absent);
        assert!(
            lingerless
                .detail
                .contains("run `sudo loginctl enable-linger biswa` there"),
            "{}",
            lingerless.detail
        );
        assert!(
            lingerless.detail.contains("linger"),
            "{}",
            lingerless.detail
        );
        assert!(
            lingerless.detail.contains("Connection refused"),
            "{}",
            lingerless.detail
        );
        assert!(mic_from("linger= biswa\n").detail.contains("linger is off"));
        assert!(mic_from("linger=\n").detail.contains("linger is off"));

        let broken = mic_from("linger=yes biswa\n42\tyantra-mic-sink.monitor\tPipeWire\n");
        assert_eq!(broken.state, State::Absent);
        assert!(!broken.detail.contains("linger"), "{}", broken.detail);
        assert!(
            broken.detail.contains("yantra-mic-sink.monitor"),
            "{}",
            broken.detail
        );

        assert_eq!(mic_from("").state, State::Unknown);
    }

    /// A listed source without linger stops at the next logout, so the probe
    /// asks loginctl before it can say `present`.
    #[test]
    fn the_mic_probe_reads_linger_before_the_source() {
        let probe = mic_probe();
        let linger = probe.find("loginctl").expect("the probe reads linger");
        let present = probe
            .find("echo present")
            .expect("the probe can say present");
        assert!(linger < present, "{probe}");

        let listed = mic_from("linger=no biswa\n42\tyantra-mic\tPipeWire\n");
        assert_eq!(listed.state, State::Absent);
        assert!(listed.detail.contains("linger"), "{}", listed.detail);
    }

    /// Y-591: only macOS refuses a folder to an ssh login, so a Linux answer is
    /// present; a refused folder is named with the fix and its cost.
    #[test]
    fn the_folder_access_check_names_what_macos_blocks() {
        assert_eq!(folder_access_from("other\n").state, State::Present);
        assert_eq!(folder_access_from("darwin\n").state, State::Present);

        let blocked = folder_access_from("darwin\nrefused Desktop\nrefused Documents\n");
        assert_eq!(blocked.state, State::Absent);
        for word in [
            "Desktop, Documents",
            "Allow full disk access for remote users",
            "agents included",
        ] {
            assert!(blocked.detail.contains(word), "{word}: {}", blocked.detail);
        }
        assert!(!blocked.detail.contains("Downloads"), "{}", blocked.detail);

        assert_eq!(folder_access_from("").state, State::Unknown);
        assert_eq!(
            folder_access_from("bash: uname: not found\n").state,
            State::Unknown
        );
        assert_eq!(
            folder_access_from("darwin\nls: Desktop\n").state,
            State::Unknown
        );
    }

    /// R-23: an exec that failed is not a blocked folder.
    #[tokio::test]
    async fn a_folder_access_check_that_could_not_ask_is_unknown() {
        struct Broken;
        impl Exec for Broken {
            async fn exec(&self, _: &str) -> Result<ssh::Output, ssh::Error> {
                Err(ssh::Error::Transport {
                    host: "mac".to_owned(),
                    diagnosis: "Connection reset".to_owned(),
                })
            }
        }
        assert_eq!(folder_access(&Broken).await.state, State::Unknown);
    }

    /// R-23 on the one check that is about this host: no grant and a refused
    /// grant are earned, and a GitHub that could not be reached is neither —
    /// an *absent* there would send someone to sign in on a box that already
    /// has.
    #[test]
    fn only_no_grant_and_a_refused_grant_are_absent() {
        assert_eq!(github(None).state, State::Absent);
        assert_eq!(
            github(Some(&Err(github::Error::Refused))).state,
            State::Absent
        );
        assert_eq!(
            github(Some(&Err(github::Error::Unreachable {
                reason: "the host does not resolve".to_owned()
            })))
            .state,
            State::Unknown
        );
        assert_eq!(
            github(Some(&Ok("octocat".to_owned()))).state,
            State::Present
        );
    }

    /// The two *absent* branches send a reader to different places, and only the
    /// detail can say which — the state is the same word for both. The login
    /// is shown on the present one: a login is not a secret (ADR-0023 §2).
    #[test]
    fn no_grant_and_a_refused_grant_are_told_apart_in_the_detail() {
        let none = github(None).detail;
        let refused = github(Some(&Err(github::Error::Refused))).detail;
        assert!(none.contains("yantra github login"), "{none}");
        assert!(refused.contains("refused"), "{refused}");
        assert!(
            github(Some(&Ok("octocat".to_owned())))
                .detail
                .contains("octocat")
        );
    }

    /// Y-619: a Mac answering by command. gh over ssh finds nothing, as it
    /// does when its token is in the login keychain (I-44).
    struct Mac {
        os: &'static str,
        server: bool,
        /// A `tmux -D` server with no session still answers `list-sessions`.
        sessions: bool,
        gh_inside: bool,
        asked: std::sync::Mutex<Vec<String>>,
    }

    impl Mac {
        fn new(os: &'static str, server: bool, gh_inside: bool) -> Self {
            Self {
                os,
                server,
                sessions: true,
                gh_inside,
                asked: std::sync::Mutex::default(),
            }
        }

        fn asked(&self, part: &str) -> bool {
            let asked = self.asked.lock().expect("not poisoned");
            asked.iter().any(|command| command.contains(part))
        }
    }

    impl Exec for Mac {
        async fn exec(&self, command: &str) -> Result<ssh::Output, ssh::Error> {
            self.asked
                .lock()
                .expect("not poisoned")
                .push(command.to_owned());
            let no_server = "no server running on /tmp/tmux-501/default\n";
            let (status, stdout, stderr) = if command == "uname -s" {
                (0, self.os, "")
            } else if command.contains("run-shell") {
                match (self.server, self.gh_inside) {
                    (false, _) => (1, "", no_server),
                    (true, true) => (0, "yantra-credential-found\n", ""),
                    (true, false) => (0, "", ""),
                }
            } else if command.contains("list-sessions") {
                if self.server && !self.sessions {
                    (0, "", "")
                } else if self.server {
                    (0, "1|0|Mon Nov  3 09:00:00 2026|1793696400|main\n", "")
                } else {
                    (1, "", no_server)
                }
            } else if command.contains("auth status") {
                (1, "", "")
            } else if command.contains("command -v gh") || command.contains("command -v tmux") {
                (0, "/opt/homebrew/bin/found\n", "")
            } else if command.contains("command -v claude") {
                (0, "/Users/me/.local/bin/claude\n", "")
            } else {
                (1, "", "")
            };
            Ok(ssh::Output {
                status,
                stdout: stdout.as_bytes().to_vec(),
                stderr: stderr.as_bytes().to_vec(),
            })
        }
    }

    fn check<'a>(checks: &'a [Check], name: &str) -> &'a Check {
        checks
            .iter()
            .find(|check| check.check == name)
            .expect("the list holds it")
    }

    fn gh() -> Vec<(&'static str, String)> {
        vec![("gh", "/opt/homebrew/bin/gh".to_owned())]
    }

    /// The card reads this detail, so it names the server and the command,
    /// and never sends the owner to sign in to an account that is signed in.
    #[tokio::test]
    async fn a_mac_with_no_login_server_is_told_to_start_one_not_to_log_in() {
        let checks = of(&Mac::new("Darwin\n", false, false), "alacritty").await;
        for name in [LOGIN_SESSION, PROVIDER_AUTH] {
            let found = check(&checks, name);
            assert_eq!(found.state, State::Absent, "{name}: {}", found.detail);
            assert!(found.detail.contains(NO_LOGIN_SERVER), "{}", found.detail);
            assert!(
                found.detail.contains("`tmux -L yantra new-session -d`"),
                "{}",
                found.detail
            );
            let said = found.detail.to_lowercase();
            assert!(
                !said.contains("log in") && !said.contains("sign in"),
                "{said}"
            );
        }
    }

    /// The LaunchAgent's `tmux -D` server holds no session until one starts,
    /// and it is the login server all the same.
    #[tokio::test]
    async fn an_empty_login_server_is_not_reported_absent() {
        let mut mac = Mac::new("Darwin\n", true, true);
        mac.sessions = false;
        let checks = of(&mac, "alacritty").await;
        for name in [LOGIN_SESSION, PROVIDER_AUTH] {
            let found = check(&checks, name);
            assert!(
                !found.detail.contains(NO_LOGIN_SERVER),
                "{name}: {}",
                found.detail
            );
        }
        assert_eq!(check(&checks, PROVIDER_AUTH).state, State::Present);
        assert!(!mac.asked("launchctl"), "doctor is a read");
    }

    /// ADR-0018 §5 for gh: where ssh cannot reach the keychain, the server can.
    #[tokio::test]
    async fn gh_on_a_mac_is_asked_again_inside_the_login_server() {
        let mac = Mac::new("Darwin\n", true, true);
        let tmux = Tmux::resolve(&mac).await.expect("a tmux");
        let found = provider_auth(&mac, gh(), Some(&tmux), &Ok(Os::MacOs)).await;
        assert_eq!(found.state, State::Present, "{}", found.detail);

        let mac = Mac::new("Darwin\n", true, false);
        let found = provider_auth(&mac, gh(), Some(&tmux), &Ok(Os::MacOs)).await;
        assert_eq!(found.state, State::Absent, "{}", found.detail);
        assert!(
            found.detail.contains("found no credential"),
            "{}",
            found.detail
        );

        let found = provider_auth(&mac, gh(), None, &Ok(Os::MacOs)).await;
        assert_eq!(found.state, State::Unknown, "{}", found.detail);
    }

    /// Y-640: a machine's Claude files, and the names its agent's PATH lacks.
    struct Agent {
        os: Os,
        server: bool,
        settings: &'static str,
        installed: &'static str,
        plugin_hooks: &'static str,
        missing: &'static str,
        asked: std::sync::Mutex<Vec<String>>,
    }

    /// claude-mem 15.9.0's hooks, cut to one of each form.
    const CLAUDE_MEM: &str = r#"{"hooks": {
        "Setup": [{"hooks": [{"type": "command", "command": "/bin/sh -c 'export PATH=x'"}]}],
        "SessionStart": [{"matcher": "startup", "hooks": [
            {"type": "command", "command": "claude-mem", "args": ["start"]},
            {"type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/x.cjs"]}
        ]}],
        "Stop": [{"hooks": [{"type": "command", "command": "claude-mem", "args": ["summarize"]}]}]
    }}"#;

    const ENABLED: &str =
        r#"{"enabledPlugins": {"claude-mem@thedotmack": true, "off@market": false}}"#;

    const INSTALLED: &str = r#"{"version": 2, "plugins": {
        "claude-mem@thedotmack": [{"installPath": "/Users/me/.claude/plugins/cache/claude-mem/15.9.0"}],
        "off@market": [{"installPath": "/Users/me/.claude/plugins/cache/off/1.0.0"}]
    }}"#;

    impl Agent {
        fn new(settings: &'static str, plugin_hooks: &'static str, missing: &'static str) -> Self {
            Self {
                os: Os::Other,
                server: false,
                settings,
                installed: INSTALLED,
                plugin_hooks,
                missing,
                asked: std::sync::Mutex::default(),
            }
        }

        fn asked(&self, part: &str) -> Vec<String> {
            let asked = self.asked.lock().expect("not poisoned");
            asked.iter().filter(|c| c.contains(part)).cloned().collect()
        }

        async fn check(&self) -> Check {
            let tmux = Tmux::resolve(self).await.expect("a tmux");
            hooks(self, Some(&tmux), &Ok(self.os)).await
        }
    }

    impl Exec for Agent {
        async fn exec(&self, command: &str) -> Result<ssh::Output, ssh::Error> {
            self.asked
                .lock()
                .expect("not poisoned")
                .push(command.to_owned());
            let file = |body: &str| format!("\n{HOOK_FILE}\n{body}");
            let (status, stdout, stderr) = if command.contains("settings.json") {
                (
                    0,
                    file(self.settings) + &file(self.installed),
                    String::new(),
                )
            } else if command.contains("hooks/hooks.json") {
                (0, file(self.plugin_hooks), String::new())
            } else if command.contains(UNRESOLVED) {
                (0, format!("{UNRESOLVED}\n{}", self.missing), String::new())
            } else if command.contains("list-sessions") {
                match self.server {
                    true => (0, String::new(), String::new()),
                    false => (
                        1,
                        String::new(),
                        "no server running on /tmp/tmux-501/default\n".to_owned(),
                    ),
                }
            } else if command.contains("command -v tmux") {
                (0, "/opt/homebrew/bin/tmux\n".to_owned(), String::new())
            } else {
                (1, String::new(), String::new())
            };
            Ok(ssh::Output {
                status,
                stdout: stdout.into_bytes(),
                stderr: stderr.into_bytes(),
            })
        }
    }

    #[tokio::test]
    async fn no_hooks_is_present() {
        for (settings, installed) in [("", ""), ("{}", INSTALLED), (ENABLED, "")] {
            let mut agent = Agent::new(settings, CLAUDE_MEM, "");
            agent.installed = installed;
            let found = agent.check().await;
            assert_eq!(found.state, State::Present, "{}", found.detail);
            assert_eq!(found.detail, "no hook names a command");
            assert!(agent.asked("hooks/hooks.json").is_empty());
        }
    }

    /// Only the enabled plugin's hooks.json is read, and the exec form's
    /// `command` is the program.
    #[tokio::test]
    async fn every_resolved_command_is_present_and_named() {
        let agent = Agent::new(ENABLED, CLAUDE_MEM, "");
        let found = agent.check().await;
        assert_eq!(found.state, State::Present, "{}", found.detail);
        assert!(
            found.detail.ends_with(": claude-mem, node"),
            "{}",
            found.detail
        );
        let read = agent.asked("hooks/hooks.json");
        assert_eq!(read.len(), 1, "{read:?}");
        assert!(
            read[0]
                .contains("'/Users/me/.claude/plugins/cache/claude-mem/15.9.0/hooks/hooks.json'")
        );
        assert!(!read[0].contains("off/1.0.0"), "{read:?}");
        let probe = &agent.asked(UNRESOLVED)[0];
        assert!(probe.contains("'claude-mem' 'node'"), "{probe}");
        assert!(
            !probe.contains("/bin/sh"),
            "a path is not looked up: {probe}"
        );
    }

    /// The walk on bishwajeets-macbook-pro: the detail names each command,
    /// its events and its plugin, and nothing else from the files.
    #[tokio::test]
    async fn a_missing_command_is_absent_with_its_event_and_plugin() {
        let agent = Agent::new(ENABLED, CLAUDE_MEM, "node\nclaude-mem\n");
        let found = agent.check().await;
        assert_eq!(found.state, State::Absent, "{}", found.detail);
        assert!(
            found
                .detail
                .contains("`claude-mem` (SessionStart, Stop in claude-mem@thedotmack)"),
            "{}",
            found.detail
        );
        assert!(
            found
                .detail
                .contains("`node` (SessionStart in claude-mem@thedotmack)"),
            "{}",
            found.detail
        );
        assert!(found.detail.contains("PATH lacks"), "{}", found.detail);
        for private in ["summarize", "CLAUDE_PLUGIN_ROOT", "/Users/me"] {
            assert!(
                !found.detail.contains(private),
                "{private}: {}",
                found.detail
            );
        }
    }

    /// A shell line's program is its first word after `VAR=value`; a builtin
    /// that guards the line, a path and an expansion are not looked up.
    #[test]
    fn a_shell_lines_program_is_its_first_plain_word() {
        let program_of = |command: &str| {
            program(&serde_json::json!({"type": "command", "command": command})).map(str::to_owned)
        };
        assert_eq!(program_of("node x.js").as_deref(), Some("node"));
        assert_eq!(program_of("FOO=1 BAR=x bun run y").as_deref(), Some("bun"));
        assert_eq!(program_of("command -v node && node x || exit 0"), None);
        assert_eq!(
            program_of("bash \"${CLAUDE_PLUGIN_ROOT}/x.sh\"").as_deref(),
            Some("bash")
        );
        assert_eq!(program_of("\"${CLAUDE_PLUGIN_ROOT}/x.sh\""), None);
        assert_eq!(program_of("$HOME/bin/x"), None);
        assert_eq!(program_of("/usr/bin/env node"), None);
        assert_eq!(program_of("[ -f x ] && y"), None);
        assert_eq!(program_of(""), None);
        let exec = serde_json::json!({"command": "node", "args": ["a b"]});
        assert_eq!(program(&exec), Some("node"));
    }

    /// settings.json's own hooks count, and a shell line's guard is skipped.
    #[tokio::test]
    async fn settings_hooks_are_read_too() {
        let agent = Agent::new(
            r#"{"hooks": {"PreToolUse": [{"hooks": [
                {"type": "command", "command": "jq -r .tool"},
                {"type": "command", "command": "command -v node && node x || exit 0"},
                {"type": "prompt", "prompt": "is this safe?"}
            ]}]}}"#,
            "",
            "jq\n",
        );
        let found = agent.check().await;
        assert_eq!(found.state, State::Absent, "{}", found.detail);
        assert!(
            found.detail.contains("`jq` (PreToolUse in settings.json)"),
            "{}",
            found.detail
        );
        assert!(!found.detail.contains("node"), "{}", found.detail);
    }

    /// R-23: a file that is not JSON was not read, so nothing is missing.
    #[tokio::test]
    async fn unparseable_json_is_unknown() {
        let found = Agent::new("{not json", "", "").check().await;
        assert_eq!(found.state, State::Unknown, "{}", found.detail);
        assert!(found.detail.contains("settings.json"), "{}", found.detail);
        assert!(!found.detail.contains("not json"), "{}", found.detail);

        let found = Agent::new(ENABLED, "{\"hooks\": [", "").check().await;
        assert_eq!(found.state, State::Unknown, "{}", found.detail);
        assert!(
            found.detail.contains("claude-mem@thedotmack"),
            "{}",
            found.detail
        );

        let found = hooks(
            &Answers {
                status: 0,
                stdout: "/usr/bin/found\n",
            },
            None,
            &Ok(Os::Other),
        )
        .await;
        assert_eq!(found.state, State::Unknown, "{}", found.detail);
        let found = hooks(&Refuses, None, &Ok(Os::Other)).await;
        assert_eq!(found.state, State::Unknown, "{}", found.detail);
    }

    /// The agent's PATH is the tmux server's, so a running server answers.
    #[tokio::test]
    async fn a_running_server_is_asked_inside() {
        for os in [Os::MacOs, Os::Other] {
            let mut agent = Agent::new(ENABLED, CLAUDE_MEM, "node\n");
            (agent.os, agent.server) = (os, true);
            let found = agent.check().await;
            assert_eq!(found.state, State::Absent, "{os:?}: {}", found.detail);
            let probe = &agent.asked(UNRESOLVED)[0];
            assert!(probe.contains("run-shell"), "{probe}");
        }
    }

    /// Linux's next server inherits ssh's PATH, so ssh answers. A Mac's next
    /// server is the LaunchAgent's, whose PATH ssh does not have.
    #[tokio::test]
    async fn with_no_server_linux_asks_over_ssh_and_a_mac_cannot_ask() {
        let linux = Agent::new(ENABLED, CLAUDE_MEM, "");
        assert_eq!(linux.check().await.state, State::Present);
        assert!(!linux.asked(UNRESOLVED)[0].contains("run-shell"));

        let mut mac = Agent::new(ENABLED, CLAUDE_MEM, "node\n");
        mac.os = Os::MacOs;
        let found = mac.check().await;
        assert_eq!(found.state, State::Unknown, "{}", found.detail);
        assert!(found.detail.contains("LaunchAgent"), "{}", found.detail);
        assert!(mac.asked(UNRESOLVED).is_empty());
        assert!(mac.asked("launchctl").is_empty(), "doctor is a read");
    }

    /// The three probes under a real `sh`, with `$HOME` a scratch directory.
    struct Local(std::path::PathBuf);

    impl Exec for Local {
        async fn exec(&self, command: &str) -> Result<ssh::Output, ssh::Error> {
            let out = std::process::Command::new("sh")
                .args(["-c", command])
                .env("HOME", &self.0)
                .output()
                .expect("sh is on every machine this builds on");
            Ok(ssh::Output {
                status: out.status.code().unwrap_or(-1),
                stdout: out.stdout,
                stderr: out.stderr,
            })
        }
    }

    #[tokio::test]
    async fn the_probes_work_under_a_real_shell() {
        let home = std::env::temp_dir().join(format!("yantra-hooks-{}", std::process::id()));
        let plugin = home.join("plugin's dir");
        std::fs::create_dir_all(home.join(".claude/plugins")).expect("a directory");
        std::fs::create_dir_all(plugin.join("hooks")).expect("a directory");
        std::fs::write(
            home.join(".claude/settings.json"),
            r#"{"enabledPlugins": {"p@m": true},
                "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "sh -c true"}]}]}}"#,
        )
        .expect("a file");
        let installed = serde_json::json!({"plugins": {"p@m": [{"installPath": plugin}]}});
        std::fs::write(
            home.join(".claude/plugins/installed_plugins.json"),
            installed.to_string(),
        )
        .expect("a file");
        std::fs::write(
            plugin.join("hooks/hooks.json"),
            r#"{"hooks": {"SessionStart": [{"hooks": [
                {"type": "command", "command": "yantra-no-such-program", "args": []}
            ]}]}}"#,
        )
        .expect("a file");

        let found = hooks(&Local(home.clone()), None, &Ok(Os::Other)).await;
        let _ = std::fs::remove_dir_all(&home);
        assert_eq!(found.state, State::Absent, "{}", found.detail);
        assert_eq!(
            found.detail,
            "the agent's PATH lacks `yantra-no-such-program` (SessionStart in p@m), so those \
             hooks fail each time an agent starts"
        );
    }

    /// Linux keeps one question over ssh, and never asks tmux.
    #[tokio::test]
    async fn gh_on_linux_is_asked_over_ssh_alone() {
        let linux = Mac::new("Linux\n", true, true);
        let tmux = Tmux::resolve(&linux).await.expect("a tmux");
        let found = provider_auth(&linux, gh(), Some(&tmux), &Ok(Os::Other)).await;
        assert_eq!(found.state, State::Absent, "{}", found.detail);
        assert_eq!(found.detail, "gh found no credential there");
        assert!(!linux.asked("list-sessions") && !linux.asked("run-shell"));
    }

    /// Answers [`GROUPS_PROBE`] and [`RULE_PROBE`], and counts how often sudo was asked.
    struct Sudo {
        groups: &'static str,
        rule: &'static str,
        asked: std::sync::atomic::AtomicUsize,
    }

    impl Sudo {
        fn new(groups: &'static str, rule: &'static str) -> Self {
            Self {
                groups,
                rule,
                asked: std::sync::atomic::AtomicUsize::new(0),
            }
        }

        fn asked(&self) -> usize {
            self.asked.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl Exec for Sudo {
        async fn exec(&self, command: &str) -> Result<ssh::Output, ssh::Error> {
            let stdout = if command == GROUPS_PROBE {
                self.groups
            } else {
                assert_eq!(command, RULE_PROBE);
                self.asked.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                self.rule
            };
            Ok(ssh::Output {
                status: 0,
                stdout: stdout.as_bytes().to_vec(),
                stderr: Vec::new(),
            })
        }
    }

    #[tokio::test]
    async fn root_and_each_sudo_group_are_absent_without_asking_sudo() {
        let root = Sudo::new("root\n", "runs\n");
        let found = no_sudo(&root, None).await;
        assert_eq!(found.state, State::Absent);
        assert_eq!(found.detail, "the account is root");
        assert_eq!(root.asked(), 0);

        for group in ["sudo", "wheel", "admin"] {
            let groups: &'static str = format!("groups staff {group} everyone\n").leak();
            let machine = Sudo::new(groups, "refused\n");
            let found = no_sudo(&machine, None).await;
            assert_eq!(found.state, State::Absent, "{group}");
            assert_eq!(found.detail, format!("the account is in the {group} group"));
            assert_eq!(machine.asked(), 0, "{group}");
        }
    }

    /// ADR-0046 decision 3.1: a `NOPASSWD` rule is sudo too.
    #[tokio::test]
    async fn sudo_decides_once_no_group_does() {
        for (rule, state, detail) in [
            ("runs\n", State::Absent, "sudo -n runs without a password"),
            (
                "refused\n",
                State::Present,
                "not root, in no sudo, wheel or admin group, and sudo -n did not run",
            ),
            ("none\n", State::Present, "there is no sudo here"),
        ] {
            let machine = Sudo::new("groups karigar staff\n", rule);
            let found = no_sudo(&machine, None).await;
            assert_eq!((found.state, found.detail.as_str()), (state, detail));
            assert_eq!(machine.asked(), 1);
        }
    }

    /// R-23: an answer Yantra cannot read is not an account that can use sudo.
    #[tokio::test]
    async fn an_unreadable_sudo_answer_is_unknown() {
        let groups = no_sudo(&Sudo::new("id: not found\n", "runs\n"), None).await;
        assert_eq!(groups.state, State::Unknown, "{}", groups.detail);
        let rule = no_sudo(&Sudo::new("groups karigar\n", ""), None).await;
        assert_eq!(rule.state, State::Unknown, "{}", rule.detail);
        assert_eq!(no_sudo(&Refuses, None).await.state, State::Unknown);
    }

    /// A refused `sudo -n` is an auth-log line, so a sweep every 30 s asks it
    /// once an hour, and the groups on every sweep.
    #[tokio::test(start_paused = true)]
    async fn sudo_is_asked_of_a_machine_at_most_once_an_hour() {
        let machine = Sudo::new("groups karigar\n", "refused\n");
        for _ in 0..3 {
            assert_eq!(
                no_sudo(&machine, Some("memo-box")).await.state,
                State::Present
            );
            tokio::time::advance(Duration::from_secs(30)).await;
        }
        assert_eq!(machine.asked(), 1);

        let other = Sudo::new("groups karigar\n", "refused\n");
        no_sudo(&other, Some("other-box")).await;
        assert_eq!(other.asked(), 1, "the memo is per machine");

        tokio::time::advance(RULE_EVERY).await;
        no_sudo(&machine, Some("memo-box")).await;
        assert_eq!(machine.asked(), 2);
    }

    /// A sudo group added since the last `sudo -n` shows at once.
    #[tokio::test]
    async fn the_groups_are_asked_on_every_sweep() {
        let before = Sudo::new("groups karigar\n", "refused\n");
        no_sudo(&before, Some("joined-box")).await;
        let after = Sudo::new("groups karigar wheel\n", "refused\n");
        let found = no_sudo(&after, Some("joined-box")).await;
        assert_eq!(found.state, State::Absent, "{}", found.detail);
    }
}
