//! The real MacBook — the checks the container structurally cannot make.
//!
//! Homebrew's prefix, zsh's `~/.zprofile` and macOS `path_helper` are what put
//! tmux outside the non-interactive `PATH` in the first place (I-34), and no
//! Alpine container reproduces that. These also run `up` through the paths the
//! container skips: a real workspace file and a real `~/.ssh/config` (ADR-0009).
//!
//! Ignored rather than skipped (I-32): CI has no tailnet and no macOS, and a
//! skip CI cannot detect is how Y-031's fixture nearly stopped testing anything.
//!
//! ```text
//! YANTRA_MAC=<ssh destination> \
//!   cargo test -p yantra-core --test manual_macbook -- --ignored --nocapture
//! ```
//!
//! **Two of these need a person at that machine first**: Y-139's transcript
//! measurement and Y-151's gate both want a tmux server started from a GUI
//! login, and both refuse without one. Their own doc comments say why and what
//! to run.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use yantra_core::agent::{Claude, TRUST_PROMPT};
use yantra_core::logs::{self, Who};
use yantra_core::ssh::{self, Exec as _, Machine, Os, Ssh};
use yantra_core::terminfo::{self, Chosen};
use yantra_core::tmux::Tmux;
use yantra_core::{up, workspace};

/// Long enough to be nobody's real workspace, and legal under `validate_name`.
const E2E: &str = "yantra-manual-e2e";

/// Y-139's session, legal under `validate_name` (I-2).
const Q12: &str = "yantra-q12";

/// The physical path, not `/tmp`: macOS resolves that symlink, and Claude Code
/// names its project directory after the cwd it ends up in — so `/tmp/…` here
/// would make [`logs::read`] look under a slug that does not exist.
const Q12_REPO: &str = "/private/tmp/yantra-q12";

/// Where the in-pane auth probe leaves its answer for the ssh session to read.
const Q12_AUTH: &str = "/private/tmp/yantra-q12/auth.json";

/// Three turns rather than one: a submitted prompt writes a record immediately,
/// so the conversation itself is what moves the mtime, and no answer has to be
/// long enough to span two readings. Deliberately tool-free — a `Bash` call
/// would stop at a permission prompt, and a transcript that stops because the
/// agent is waiting for a person looks exactly like R-1.
const Q12_PROMPTS: [&str; 3] = [
    "Reply with just the word one.",
    "Reply with just the word two.",
    "Reply with just the word three.",
];

#[tokio::test]
#[ignore = "needs the real MacBook; set YANTRA_MAC=user@host"]
async fn tmux_resolves_on_real_macos() -> anyhow::Result<()> {
    let dest = std::env::var("YANTRA_MAC")?;
    let ssh = Ssh::new(Machine {
        host: dest,
        user: None,
        port: None,
        identity: Some(PathBuf::from(std::env::var("HOME")?).join(".ssh/id_yantra")),
        state_dir: PathBuf::from("/tmp/y52"),
    })?;

    let tmux = Tmux::resolve(&ssh).await?;
    println!("resolved: {}", tmux.path());
    assert!(tmux.path().starts_with('/'));

    // The point of I-34: PATH alone would have found nothing here.
    let bare = ssh.exec("command -v tmux || echo NONE").await?;
    println!(
        "command -v tmux: {}",
        String::from_utf8_lossy(&bare.stdout).trim()
    );
    Ok(())
}

/// Y-055, and with it M2's claim: `up` by name against a machine that is not
/// the one running the test. The container proves [`up::open`]; only this
/// proves the half above it — workspace file, `~/.ssh/config`, real network.
#[tokio::test]
#[ignore = "needs the real MacBook; set YANTRA_MAC=user@host"]
async fn up_opens_a_remote_session_and_the_second_run_attaches() -> anyhow::Result<()> {
    let dest = std::env::var("YANTRA_MAC")?;
    let dir = workspace::workspaces_dir()?;
    std::fs::create_dir_all(&dir)?;
    let file = dir.join(format!("{E2E}.toml"));
    anyhow::ensure!(
        !file.exists(),
        "{} already exists — refusing to overwrite it",
        file.display()
    );
    std::fs::write(&file, format!("machine = \"{dest}\"\nrepo = \"/tmp\"\n"))?;
    let mut leaves = Leaves::of(file, E2E);

    let first = up::up(E2E, terminfo::FALLBACK, None).await?;
    // Registered before the assertions, so a failing one still tidies up.
    leaves.session = Some((dest, first.tmux.path().to_owned()));
    println!(
        "opened {} via {} on {}",
        first.opened.session().session_id,
        first.tmux.path(),
        first.workspace.machine
    );
    assert!(first.opened.was_created(), "the first up opens the session");

    let second = up::up(E2E, terminfo::FALLBACK, None).await?;
    assert!(
        !second.opened.was_created(),
        "the second up attaches — §B4, over a real network this time"
    );
    assert_eq!(
        first.opened.session().session_id,
        second.opened.session().session_id,
        "and it is the same session, not a second one with the same name"
    );
    Ok(())
}

/// Y-058 where the version skew is real: this machine runs ncurses 6.6 and the
/// MacBook runs 6.0 from 2015. The container cannot reproduce a ten-year gap.
///
/// Read-only — it probes and reports. Installing writes to someone's `$HOME`,
/// which is `yantra fix-terminfo`'s job precisely because it should be asked for.
#[tokio::test]
#[ignore = "needs the real MacBook; set YANTRA_MAC=user@host"]
async fn the_terminal_probe_tells_real_macos_apart() -> anyhow::Result<()> {
    let dest = std::env::var("YANTRA_MAC")?;
    let ssh = Ssh::new(Machine {
        host: dest,
        user: None,
        port: None,
        identity: Some(PathBuf::from(std::env::var("HOME")?).join(".ssh/id_yantra")),
        state_dir: PathBuf::from("/tmp/y58"),
    })?;

    for term in ["xterm-256color", "screen-256color", "xterm-ghostty", "foot"] {
        println!("{term}: {:?}", terminfo::choose(&ssh, term).await?);
    }

    // The floor has to hold, or every fallback is an attach that aborts.
    assert_eq!(
        terminfo::choose(&ssh, terminfo::FALLBACK).await?,
        Chosen::Known(terminfo::FALLBACK.to_owned())
    );
    Ok(())
}

/// **Y-151, and the half of [ADR-0018] no container can reach.** The mechanics
/// of §1 and §5 are proved against a real tmux in `tests/up_walking_skeleton.rs`
/// and `tests/agent.rs`; **launchd is not a thing a container has**, so that a
/// server started from a GUI login is what makes the credential readable can
/// only be measured here. A green CI run is not evidence for any of it.
///
/// The claim under test is the pair, on one machine minutes apart: `claude auth
/// status` asked **over ssh** answers `loggedIn: false` (**I-44** — that process
/// is in launchd's `Background` domain), and asked **inside the tmux server**
/// that will fork the agent answers `loggedIn: true`. Only the second is
/// asserted, because it is the one §5 rests on; the first is printed, and a run
/// where both agree is called out rather than quietly passed — it would mean
/// this measurement separated nothing.
///
/// **I-53 bounds what a pass means**: a credential was *found* where the agent
/// will run. Not that it works, not that the agent can talk to Anthropic. Y-139
/// is the row that needs an assistant turn for that.
///
/// It refuses when there is no tmux server rather than starting one, which is
/// §1 itself: a server this test started over ssh would be the `Background`
/// server whose panes cannot read the keychain, and the run would measure the
/// thing being avoided. At the Mac's own keyboard, in Terminal.app, left
/// running:
///
/// ```text
/// tmux new-session -d -s yantra-gui
/// ```
///
/// [ADR-0018]: ../../../docs/adr/0018-the-tmux-server-carries-the-macos-login-session.md
#[tokio::test]
#[ignore = "needs the real MacBook and a tmux server started from a GUI login; set YANTRA_MAC=user@host"]
async fn the_gate_finds_a_credential_in_the_server_where_ssh_finds_none() -> anyhow::Result<()> {
    let dest = std::env::var("YANTRA_MAC")?;
    let ssh = Ssh::new(Machine {
        host: dest.clone(),
        user: None,
        port: None,
        identity: Some(PathBuf::from(std::env::var("HOME")?).join(".ssh/id_yantra")),
        state_dir: PathBuf::from("/tmp/y151"),
    })?;

    let os = ssh::os(&ssh).await?;
    anyhow::ensure!(
        os == Os::MacOs,
        "{dest} answered `uname -s` as {os:?}, so it is not the machine ADR-0018 is about and \
         this run would prove nothing about the precondition or the gate"
    );

    // I-34 twice over: neither binary is on that machine's ssh `PATH`.
    let tmux = Tmux::resolve(&ssh).await?;
    let claude = Claude::resolve(&ssh).await?;
    anyhow::ensure!(
        !tmux.list(&ssh).await?.is_empty(),
        "no tmux server on {dest}. ADR-0018 §1 is exactly that this must not be started over ssh \
         — a server started here forks panes in launchd's `Background` domain, which is where the \
         login keychain is unreadable (I-44), so the run would measure the failure it exists to \
         avoid. Start it at the Mac's own keyboard, in Terminal.app: \
         `tmux new-session -d -s yantra-gui`, and leave it running."
    );

    let over_ssh = claude.auth(&ssh, &tmux, Os::Other).await?;
    let in_server = claude.auth(&ssh, &tmux, Os::MacOs).await?;
    println!(
        "over ssh:        loggedIn {}, authMethod {}\n\
         in that server:  loggedIn {}, authMethod {}",
        over_ssh.logged_in, over_ssh.method, in_server.logged_in, in_server.method
    );

    anyhow::ensure!(
        in_server.logged_in,
        "the gate found no credential in that tmux server (authMethod `{}`), so ADR-0018 §5 buys \
         nothing on this machine as it stands. Either the server was itself started somewhere \
         without the login keychain — over ssh, most likely — or `run-shell` did not reach the \
         process it was supposed to. Refusing rather than passing on nothing.",
        in_server.method
    );
    if over_ssh.logged_in {
        println!(
            "note: ssh answered `true` as well, so I-44 was not in force on this run and the \
             pair separated nothing — the gate is still in the right place, but this run is not \
             the evidence for it"
        );
    }
    Ok(())
}

/// How long the agent gets to draw its first screen before anything is typed at
/// it. A prompt sent into a TUI that is still starting is a prompt nobody sees,
/// and the run then reports *never started* for the wrong reason.
const Q12_BOOT: Duration = Duration::from_secs(12);

/// Between readings, and between prompts.
const Q12_STEP: Duration = Duration::from_secs(5);
const Q12_SEND_EVERY: Duration = Duration::from_secs(25);

/// **Q12 and R-1, on the operating system #63545 was filed against**: does the
/// transcript of a real conversation keep advancing while the tmux session stays
/// detached?
///
/// **Two readings, or it is not the experiment.** A transcript that exists proves
/// nothing — the 2026-07-30 run already watched one grow to 57,841 bytes while
/// fully detached, with an agent that was never logged in. What has never been
/// measured is the mtime *advancing across turns* with `session_attached=0`
/// between the readings, and that is the only thing that retires R-1 or
/// reinstates it.
///
/// **It needs a tmux server started from a GUI login, and refuses without one.**
/// A server started over ssh lands in launchd's `Background` domain, where
/// Claude Code cannot read the login keychain (**I-44**), so the agent comes up
/// unauthenticated and there is no conversation to measure; a server started
/// from Terminal.app forks panes that can ([ADR-0018] §8). **Those are two
/// different experiments** — #63545 is about macOS and tmux, not about macOS and
/// ssh and tmux — so a result is only worth recording beside the answer this
/// harness prints from [`auth_where_the_agent_will_run`], which is what says
/// which one ran.
///
/// At the Mac's own keyboard, in Terminal.app, leaving it running:
///
/// ```text
/// tmux new-session -d -s yantra-gui
/// ```
///
/// then from the machine holding the repo: `just test-mac <machine>`.
///
/// Three outcomes, each reported as itself:
///
/// - **advancing** — two readings differ, so the transcript moved while nothing
///   was attached. R-1 does not reproduce here. The test passes.
/// - **stopped** — the file is there and its mtime never moved across the whole
///   window. R-1 reinstated, and the test fails saying so.
/// - **never started** — no transcript at all, so nothing was measured. Also a
///   failure, and explicitly *not* evidence for R-1: I-49's inert agent at the
///   trust dialog, a prompt typed before the TUI was ready and a crashed launch
///   all land here.
///
/// Nothing here attaches, which is both the experiment and the way past I-36 and
/// I-43 — an unknown `TERM` aborts `tmux attach` on that machine, and the
/// operator answering the trust dialog by hand is the one person who will meet
/// it.
///
/// **A null result on one run is weak evidence for an intermittent bug**, so the
/// verdict prints how long it watched; `YANTRA_Q12_WATCH=<seconds>` buys longer.
///
/// [ADR-0018]: ../../../docs/adr/0018-the-tmux-server-carries-the-macos-login-session.md
#[tokio::test]
#[ignore = "needs the real MacBook and a tmux server started from a GUI login; set YANTRA_MAC=user@host"]
async fn the_transcript_advances_while_the_session_stays_detached() -> anyhow::Result<()> {
    let dest = std::env::var("YANTRA_MAC")?;
    let ssh = Ssh::new(Machine {
        host: dest.clone(),
        user: None,
        port: None,
        identity: Some(PathBuf::from(std::env::var("HOME")?).join(".ssh/id_yantra")),
        state_dir: PathBuf::from("/tmp/y139"),
    })?;

    let tmux = Tmux::resolve(&ssh).await?;
    anyhow::ensure!(
        !tmux.list(&ssh).await?.is_empty(),
        "no tmux session on {dest}, so this harness would have to start the server itself — \
         which is the other experiment, and the one I-44 blocks. Start it at the Mac's own \
         keyboard, in Terminal.app: `tmux new-session -d -s yantra-gui`, and leave it running."
    );

    let claude = Claude::resolve(&ssh).await?;
    ssh.exec(&format!("mkdir -p '{Q12_REPO}'")).await?;

    let _leaves = Leaves::session_only(&dest, tmux.path(), Q12);
    let opened = tmux.ensure(&ssh, Q12, Q12_REPO, None).await?;
    let pane = opened.session().pane_id.clone();

    let auth = auth_where_the_agent_will_run(&ssh, &tmux, &claude, &pane).await?;
    println!(
        "in that tmux server: loggedIn {}, authMethod {}",
        auth.logged_in, auth.method
    );
    anyhow::ensure!(
        auth.logged_in,
        "claude in that tmux server is not logged in (authMethod `{}`), so this run would \
         measure an agent that never talks to Anthropic. That is I-44: the server was started \
         somewhere without the login keychain — over ssh, most likely — and the fix is to start \
         it from a GUI login on the Mac. Refusing rather than passing on nothing.",
        auth.method
    );

    // `agent::prepare` builds this command in production and gates it on `auth`
    // over ssh, which on this machine always refuses (I-44) — so the gate that
    // ran is the one above, in the pane, and the command is spelled out here.
    let session_id = fresh_session_id()?;
    tmux.respawn(
        &ssh,
        &pane,
        &format!(
            "cd '{Q12_REPO}' && exec '{}' --session-id '{session_id}'",
            claude.path()
        ),
    )
    .await?;
    tokio::time::sleep(Q12_BOOT).await;

    anyhow::ensure!(
        !tmux.pane_shows(&ssh, &pane, TRUST_PROMPT).await?,
        "the agent is holding at the trust dialog for {Q12_REPO} (I-23, I-49): it is inert, it \
         writes no transcript, and it swallows the keystrokes this harness sends. Answer it once \
         at the Mac — `cd {Q12_REPO} && claude` in a terminal, choose the option that trusts the \
         folder, quit — and run this again."
    );

    let watch = Duration::from_secs(
        std::env::var("YANTRA_Q12_WATCH")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(90),
    );
    let started = Instant::now();
    let mut sent = 0;
    let mut readings: Vec<(u64, i64)> = Vec::new();
    let mut last: Option<logs::Transcript> = None;

    loop {
        let elapsed = started.elapsed();
        if sent < Q12_PROMPTS.len() && elapsed >= Q12_SEND_EVERY * sent as u32 {
            // I-21: a pane target is `%id`, never `=name`. The second `send-keys`
            // is a keystroke and not text, which is why `-l` is on the first
            // alone, and the pause is for a TUI that reads its own input.
            ssh.exec(&format!(
                "'{tmux_path}' send-keys -t '{pane}' -l '{prompt}'\n\
                 sleep 1\n\
                 '{tmux_path}' send-keys -t '{pane}' Enter\n",
                tmux_path = tmux.path(),
                prompt = Q12_PROMPTS[sent],
            ))
            .await?;
            sent += 1;
        }

        match tmux
            .list(&ssh)
            .await?
            .into_iter()
            .find(|s| s.name == Q12)
            .map(|s| s.attached)
        {
            Some(0) => {}
            Some(clients) => anyhow::bail!(
                "{clients} client(s) attached to {Q12} during the watch — R-1 is about a \
                 *detached* session, so this run measured something else and is void"
            ),
            None => anyhow::bail!("{Q12} is gone from that tmux server; nothing left to read"),
        }

        match logs::read(&ssh, Q12_REPO, Some(&session_id), 6, 0).await {
            Ok(transcript) => {
                println!(
                    "t+{:>3}s  mtime {}  idle {}s  turns {}",
                    elapsed.as_secs(),
                    transcript.modified,
                    transcript.idle_for(),
                    transcript.entries.len()
                );
                readings.push((elapsed.as_secs(), transcript.modified));
                last = Some(transcript);
            }
            Err(logs::Error::NoTurnYet { .. }) => {
                println!("t+{:>3}s  no transcript yet", elapsed.as_secs());
            }
            Err(other) => return Err(other.into()),
        }

        if started.elapsed() >= watch {
            break;
        }
        tokio::time::sleep(Q12_STEP).await;
    }

    let watched = started.elapsed().as_secs();
    let pane_now = tmux.pane(&ssh, Q12).await?;
    let Some(last) = last else {
        anyhow::bail!(
            "the agent wrote no transcript at all in {watched}s, so **nothing was measured** and \
             this is not evidence for R-1 in either direction. The pane: {pane_now:?}"
        );
    };

    anyhow::ensure!(
        last.entries.iter().any(|e| e.who == Who::Assistant),
        "the transcript has no assistant turn after {watched}s: the agent wrote, but never \
         answered, so it was never shown to reach Anthropic at all — I-53, `auth status` reports \
         the credential it found and never that it works. Nothing about R-1 is settled here. \
         The pane: {pane_now:?}"
    );
    anyhow::ensure!(
        readings.len() >= 2,
        "the transcript appeared too late in {watched}s to be read twice, and two readings are \
         the experiment. Give it longer with YANTRA_Q12_WATCH."
    );

    anyhow::ensure!(
        readings.windows(2).any(|w| w[0].1 != w[1].1),
        "**R-1 reproduces on macOS**: across {watched}s of a conversation the transcript's mtime \
         never moved, with session_attached=0 at every reading — {readings:?}. The pane: \
         {pane_now:?}"
    );
    println!(
        "R-1 does not reproduce: the transcript advanced across {} readings in {watched}s, \
         session_attached=0 throughout, and the agent answered — {readings:?}",
        readings.len()
    );
    Ok(())
}

/// `claude auth status`, run in the server that will fork the agent rather than
/// over ssh ([ADR-0018] §5) — over ssh it answers `false` on this machine
/// whatever the server is (I-44), which would refuse the one route that works.
///
/// The pane exists before this and is respawned into, never created with it
/// (I-29), and the answer travels through a file because a pane's screen wraps
/// at its width.
///
/// **Only `loggedIn` and `authMethod` are read, and the raw output is never
/// printed.** `claude auth status` also prints the account's email and its org
/// id; not naming them is how they stay off a log line, exactly as in
/// `agent::Status`.
///
/// [ADR-0018]: ../../../docs/adr/0018-the-tmux-server-carries-the-macos-login-session.md
async fn auth_where_the_agent_will_run(
    ssh: &Ssh,
    tmux: &Tmux,
    claude: &Claude,
    pane: &str,
) -> anyhow::Result<Auth> {
    tmux.respawn(
        ssh,
        pane,
        &format!("'{}' auth status > '{Q12_AUTH}' 2>&1", claude.path()),
    )
    .await?;
    for _ in 0..40 {
        if tmux.pane(ssh, Q12).await?.is_some_and(|p| p.dead) {
            let out = ssh
                .exec(&format!("cat '{Q12_AUTH}'; rm -f '{Q12_AUTH}'"))
                .await?;
            return serde_json::from_slice(&out.stdout).map_err(|_| {
                anyhow::anyhow!(
                    "that pane printed something other than `claude auth status`'s JSON"
                )
            });
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    anyhow::bail!("the auth probe never finished in the pane")
}

/// The two fields `agent::Status` names, for its reason rather than for tidiness.
#[derive(serde::Deserialize)]
struct Auth {
    #[serde(rename = "loggedIn")]
    logged_in: bool,
    #[serde(rename = "authMethod", default)]
    method: String,
}

/// A fresh v4 id per run, so the file the readings come from is this run's
/// conversation and no earlier one. `agent::prepare` is what mints one in
/// production, and it is behind the gate this harness cannot use here.
fn fresh_session_id() -> anyhow::Result<String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|e| anyhow::anyhow!("no entropy for a session id: {e}"))?;
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

/// What the test would otherwise leave on someone's laptop. `Drop` because a
/// failed assertion is exactly when a leaked session is hardest to notice.
struct Leaves {
    /// Absent for a test that never wrote one — Y-139 drives tmux directly,
    /// because the gate `up` runs cannot pass on that machine (I-44).
    workspace_file: Option<PathBuf>,
    /// The ssh destination and the absolute tmux path, once `up` has found one.
    session: Option<(String, String)>,
    name: &'static str,
}

impl Leaves {
    fn of(workspace_file: PathBuf, name: &'static str) -> Self {
        Self {
            workspace_file: Some(workspace_file),
            session: None,
            name,
        }
    }

    /// The session is known before it exists here, so it is registered before
    /// the call that creates it. Killing one that was never created is success
    /// (I-30), and killing ours cannot take the server with it: this test
    /// refuses to run unless another session was already there.
    fn session_only(dest: &str, tmux: &str, name: &'static str) -> Self {
        Self {
            workspace_file: None,
            session: Some((dest.to_owned(), tmux.to_owned())),
            name,
        }
    }
}

impl Drop for Leaves {
    fn drop(&mut self) {
        if let Some(file) = &self.workspace_file {
            let _ = std::fs::remove_file(file);
        }
        if let Some((dest, tmux)) = &self.session {
            // I-35: the far side's login shell is zsh, which eats a bare `=name`.
            let _ = std::process::Command::new("ssh")
                .arg(dest)
                .arg("--")
                .arg(format!("{tmux} kill-session -t '={}'", self.name))
                .output();
        }
    }
}
