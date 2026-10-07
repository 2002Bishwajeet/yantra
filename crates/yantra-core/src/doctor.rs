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
/// Public because the one caller that can answer this check finds it by name —
/// see [`heartbeat`].
pub const HEARTBEAT: &str = "heartbeat";
/// Not one of the checks above: it names a fact about the host this process runs
/// on rather than about a machine being asked — see [`github`].
pub const GITHUB: &str = "github";

/// Everything ssh has to answer for. Listed so an unreachable machine still
/// reports every check rather than a short list a consumer has to interpret.
const BEHIND_SSH: [&str; 8] = [
    TMUX,
    GIT,
    AGENT_CLI,
    TERMINFO,
    PROVIDER_CLI,
    PROVIDER_AUTH,
    LOGIN_SESSION,
    MIC,
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
/// is answered better by eleven states than by one error.
pub async fn machine(name: &str, term: &str) -> Report {
    let ssh = ssh::machine_at(name)
        .ok_or_else(|| "no directory for ssh control sockets on this machine".to_owned())
        .and_then(|m| Ssh::new(m).map_err(|err| err.to_string()));

    let mut checks = match ssh {
        Ok(ssh) => of(&ssh, term).await,
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
        git(exec).await,
        agent_cli,
        terminfo(exec, term).await,
        provider_cli,
        provider_auth(exec, providers).await,
        login_session(exec, found_tmux.as_ref(), found_claude.as_ref()).await,
        mic(exec).await,
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
    let probe = format!(
        "p=$(command -v git 2>/dev/null)\n\
         case \"$p\" in /*) ;; *) p=\n\
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
        assert_eq!(checks.len(), 11);
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
}
