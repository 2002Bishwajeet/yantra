//! Every script Yantra sends to a machine parses under macOS's bash 3.2 and
//! under dash, on its own and inside `c=$(…)` (Y-634, Y-635).
//!
//! A `Recorder` stands in for the machine and keeps each command it is sent,
//! then one podman container runs `bash -n` and `dash -n` on all of them. On a
//! Mac the machine's own `/bin/bash`, `/bin/sh` and `/bin/dash` run them
//! instead (Y-661). The envelopes are opened, so the scripts inside base64 and
//! `sh -c '…'` are checked as well.

#![allow(clippy::expect_used, clippy::panic)]

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::acp::Harness;
use crate::delegate::Place;
use crate::github::IssueRef;
use crate::image::Images;
use crate::keep::{self, File, Keeper, Limits};
use crate::ssh::{self, Exec, Os};
use crate::tmux::Tmux;
use crate::workspace::Workspace;
use crate::{
    agent, attach, chat, checkpoint, claude, clone, command, commit, delegate, dirs, doctor, down,
    edit, install, join, logs, mention, mic, probe, pty, remove, resume, sessions, stt, terminfo,
    thread, tokens, up,
};

/// Bump the tag when `tests/fixture/shells/Containerfile` changes.
#[cfg(not(target_os = "macos"))]
const IMAGE: &str = "localhost/yantra-shells:1";

/// Runs `<shell> -n` for each shell named after the directory `$1` on each
/// file in it, then on it inside `c=$(…)`, the embedding Y-634 broke. Prints
/// one line per failure. The newline after `$(` is POSIX's: a script that
/// opens with `(` reads as `$((`.
const CHECKER: &str = r#"
dir=$1; shift
embedded=$(mktemp) || exit 1
for f in "$dir"/*; do
  n=${f##*/}
  { printf 'c=$(\n'; cat "$f"; printf '\n)\n'; } >"$embedded"
  for sh in "$@"; do
    out=$("$sh" -n "$f" 2>&1) || echo "FAIL $n $sh plain: $out"
    out=$("$sh" -n "$embedded" 2>&1) || echo "FAIL $n $sh in c=\$(…): $out"
  done
done
rm -f "$embedded"
"#;

const REPO: &str = "/home/u/repo";
const WORKTREE: &str = "/home/u/.yantra/worktrees/repo/11111111";
const INSTALLER: &str = "curl -fsSL https://example.invalid/install.sh | bash";

struct Recorder {
    darwin: bool,
    /// A Linux machine with no claude until [`INSTALLER`] runs, missing a
    /// prerequisite, with root and with no linger, so `install::of` runs
    /// every step.
    bare: bool,
    /// A Mac whose `list-sessions` finds no server, so the login-server
    /// script is sent.
    no_server: bool,
    installed: Mutex<bool>,
    label: Mutex<&'static str>,
    seen: Mutex<Vec<(String, String)>>,
}

impl Recorder {
    fn new(darwin: bool) -> Self {
        Self {
            darwin,
            bare: false,
            no_server: false,
            installed: Mutex::new(false),
            label: Mutex::new(""),
            seen: Mutex::new(Vec::new()),
        }
    }

    fn label(&self, label: &'static str) {
        *self.label.lock().unwrap_or_else(PoisonError::into_inner) = label;
    }

    fn keep(&self, label: &str, script: String) {
        self.seen
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push((label.to_owned(), script));
    }

    fn seen(self) -> Vec<(String, String)> {
        self.seen
            .into_inner()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

impl Exec for Recorder {
    async fn exec(&self, command: &str) -> Result<ssh::Output, ssh::Error> {
        let label = *self.label.lock().unwrap_or_else(PoisonError::into_inner);
        self.keep(label, ssh::payload(command, "0123456789abcdef"));
        let mut installed = self
            .installed
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        *installed |= command == INSTALLER;
        let stdout = if self.bare {
            bare(command, *installed)
        } else {
            None
        };
        if self.no_server && command.ends_with("list-sessions") {
            return Ok(ssh::Output {
                status: 1,
                stdout: Vec::new(),
                stderr: b"no server running on /private/tmp/tmux-501/default".to_vec(),
            });
        }
        Ok(ssh::Output {
            status: 0,
            stdout: stdout
                .unwrap_or_else(|| answer(self.darwin, command))
                .into_bytes(),
            stderr: Vec::new(),
        })
    }
}

/// Enough of a machine that each entry point gets past its first command.
fn answer(darwin: bool, command: &str) -> String {
    if command == "uname -s" {
        return if darwin { "Darwin\n" } else { "Linux\n" }.to_owned();
    }
    if let Some((_, rest)) = command.split_once("command -v ") {
        let binary: String = rest
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
            .collect();
        return format!("/usr/bin/{binary}\n");
    }
    if command.contains("rev-parse") {
        return format!("{REPO}\n0123456789abcdef0123456789abcdef01234567\n");
    }
    String::new()
}

/// What a [`Recorder::bare`] machine says where it differs from [`answer`].
fn bare(command: &str, installed: bool) -> Option<String> {
    if command.contains("|| echo curl") {
        return Some("curl\n".to_owned());
    }
    if command.contains("sudo -n true") {
        return Some("root\n".to_owned());
    }
    if command.contains("Linger --value") {
        return Some("u\nno\n".to_owned());
    }
    (!installed && command.contains("command -v claude ")).then(String::new)
}

/// `script`, then every script nested inside it, each under its own label.
fn opened(label: &str, script: &str, into: &mut Vec<(String, String)>) {
    into.push((label.to_owned(), script.to_owned()));
    for (n, inner) in nested(script).iter().enumerate() {
        opened(&format!("{label}>{n}"), inner, into);
    }
}

/// The scripts inside `echo <base64> | base64 -d` and `sh -c '…'`.
fn nested(script: &str) -> Vec<String> {
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut found = Vec::new();
    for (at, _) in script.match_indices("echo ") {
        let rest = &script[at + 5..];
        let end = rest
            .find(|c: char| !(c.is_ascii_alphanumeric() || "+/=".contains(c)))
            .unwrap_or(rest.len());
        if end > 0
            && rest[end..].starts_with(" | base64 -d")
            && let Some(text) = b64
                .decode(&rest[..end])
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok())
        {
            found.push(text);
        }
    }
    for prefix in ["sh -c '", "run-shell '"] {
        for (at, _) in script.match_indices(prefix) {
            if let Some(text) = unquoted(&script[at + prefix.len() - 1..]) {
                found.push(text);
            }
        }
    }
    found
}

/// Reads one `tmux::sq` word from the start of `text`. A word that does not
/// end at a word boundary is a quote one level further in, and is skipped.
fn unquoted(text: &str) -> Option<String> {
    let mut word = String::new();
    let mut rest = text;
    loop {
        let body = rest.strip_prefix('\'')?;
        let close = body.find('\'')?;
        word.push_str(&body[..close]);
        rest = &body[close + 1..];
        match rest.strip_prefix("\\'") {
            Some(next) => {
                word.push('\'');
                rest = next;
            }
            None => break,
        }
    }
    match rest.chars().next() {
        None | Some(' ' | '\n' | ';' | '&' | '|' | ')' | '<' | '>') => Some(word),
        Some(_) => None,
    }
}

fn workspace() -> Workspace {
    Workspace {
        name: "web".to_owned(),
        machine: "m".to_owned(),
        repo: PathBuf::from(REPO),
        startup: Some("claude".to_owned()),
    }
}

fn place() -> Place {
    Place {
        id: "chat/web/11111111".to_owned(),
        repo: REPO.to_owned(),
        worktree: WORKTREE.to_owned(),
        branch: "yantra/chat/web/11111111".to_owned(),
        base: "0123abcd".to_owned(),
    }
}

macro_rules! drive {
    ($recorder:expr, $label:expr, $($call:expr),+ $(,)?) => {{
        $recorder.label($label);
        $(let _ = $call.await;)+
    }};
}

/// Every module that sends a script, driven once, `install::of` again on a
/// bare machine, then the builders the `Exec` seam never sees.
async fn every_script() -> Vec<(String, String)> {
    let r = Recorder::new(false);
    let ws = workspace();
    let place = place();
    let keeper = Keeper::new("web", "11111111");
    let issue = IssueRef {
        owner: "o".to_owned(),
        repo: "r".to_owned(),
        number: 7,
    };
    let plan = clone::Plan {
        url: "https://github.com/o/r.git".to_owned(),
        path: "~/src/r".to_owned(),
        session: "clone-r".to_owned(),
    };

    r.label("tmux");
    let tmux = Tmux::resolve(&r)
        .await
        .expect("the recorder answers a path");
    drive!(
        r,
        "tmux",
        tmux.ensure(&r, "web", REPO, Some("claude")),
        tmux.list(&r),
        tmux.pane(&r, "web"),
        tmux.pane_shows(&r, "%1", "trust"),
        tmux.kill(&r, "web"),
        tmux.respawn(&r, "%1", "claude"),
    );
    r.label("agent");
    let claude = agent::Claude::resolve(&r)
        .await
        .expect("the recorder answers a path");
    drive!(
        r,
        "agent",
        agent::locate(&r, "claude"),
        claude.agents(&r),
        claude.auth(&r, &tmux, Os::Other),
        claude.auth(&r, &tmux, Os::MacOs),
        agent::prepare(&r, REPO, &tmux, Os::Other),
        agent::resume(&r, REPO, &tmux, Os::MacOs),
    );
    drive!(r, "attach", attach::ensure_session(&r, &tmux, "m", "web"));
    drive!(r, "down", down::stop(&r, &tmux, ws.clone()));
    drive!(r, "edit", edit::ensure_free(&r, &tmux, &ws));
    drive!(r, "remove", remove::ensure_free(&r, &tmux, &ws));
    drive!(
        r,
        "keep",
        keep::start(&r, &tmux, &keeper, "claude", "run1", Limits::default()),
        keep::stale(&r, &tmux, &keeper),
        keep::pane(&r, &tmux, &keeper),
        keep::kill(&r, &tmux, &keeper),
        keep::close_stdin(&r, &keeper, "run1"),
        keep::read(&r, &keeper, File::Out, Some(10)),
        keep::size(&r, &keeper, File::In),
        keep::write_mode(&r, &keeper, "auto"),
    );
    drive!(r, "resume", resume::of(&r, &tmux, &ws, Os::Other));
    drive!(r, "up", up::open(&r, &tmux, &ws, Some("claude"), Os::MacOs));
    drive!(
        r,
        "commit",
        commit::draft(&r, &place, None),
        commit::draft(&r, &place, Some("/usr/bin/tmux")),
        commit::commit(&r, &place, "Fix it's quoting"),
        commit::push(&r, &place, Some(&issue), Some("/usr/bin/tmux")),
    );
    drive!(
        r,
        "checkpoint",
        checkpoint::base(&r, &place),
        checkpoint::capture(&r, &place),
        checkpoint::latest(&r, &place),
        checkpoint::diff(&r, &place, 2),
        checkpoint::branch(&r, &place),
        checkpoint::revert(&r, &place, 1),
    );
    drive!(
        r,
        "thread",
        thread::open(&r, &ws),
        thread::open_as(&r, &ws, "11111111"),
        thread::list(&r, &ws),
        thread::open_for_issue(&r, &ws, &issue, "Fix"),
        thread::listed(&r, &ws),
        thread::remember(&r, &place, Harness::Codex, "s1"),
        thread::recall(&r, &place),
        thread::remove(&r, &place),
        thread::status(&r, &place),
    );
    drive!(r, "delegate", delegate::prepare(&r, REPO, "22222222"));
    drive!(r, "delegate", delegate::summarise(&r, WORKTREE, "0123abcd"));
    r.keep("delegate", delegate::removal(&place));
    // `open_pr` reaches the machine only after GitHub answers.
    r.keep(
        "commit",
        commit::tip_command(&place, "yantra/chat/web/11111111"),
    );
    drive!(r, "command", command::commands(&r, WORKTREE));
    drive!(
        r,
        "mention",
        mention::mentions(&r, WORKTREE, Some(Harness::Gemini))
    );
    drive!(r, "stt", stt::listing(&r, WORKTREE));
    drive!(
        r,
        "dirs",
        dirs::list_on(&r, "m", Some("~/src")),
        dirs::make_on(&r, "m", None, "new"),
    );
    drive!(r, "sessions", sessions::kill_on(&r, &tmux, "m", "web"));
    drive!(r, "tokens", tokens::spent(&r, REPO, Some("s1"), None));
    drive!(
        r,
        "logs",
        logs::session_of(&r, "web"),
        logs::read(&r, REPO, None, 50, 0),
    );
    drive!(r, "probe", probe::probe_on(&r, "m", "~/src/r"));
    drive!(
        r,
        "clone",
        clone::clone_on(&r, &tmux, Os::Other, "m", &plan)
    );
    drive!(r, "install", install::of(&r, "m", INSTALLER, Some("0")));
    let mut bare = Recorder::new(false);
    bare.bare = true;
    drive!(
        bare,
        "install",
        install::of(&bare, "m", INSTALLER, Some("0"))
    );
    drive!(r, "doctor", doctor::of(&r, "xterm-ghostty"));
    drive!(
        r,
        "terminfo",
        terminfo::choose(&r, "xterm-ghostty"),
        terminfo::install(&r, "xterm-ghostty"),
    );
    let mut images = Images::of(&keeper);
    let _ = images
        .put_with(b"\x89PNG\r\n\x1a\n", |command| {
            r.keep("image", command);
            async { Ok(format!("{WORKTREE}/images/x-1.png")) }
        })
        .await;
    drive!(r, "image", images.remove(&r));

    let mac = Recorder::new(true);
    drive!(mac, "doctor", doctor::of(&mac, "xterm-256color"));
    let mut serverless = Recorder::new(true);
    serverless.no_server = true;
    drive!(
        serverless,
        "up",
        up::open(&serverless, &tmux, &ws, None, Os::MacOs)
    );

    r.keep(
        "claude",
        claude::command(
            WORKTREE,
            &Keeper::new("web", "11111111"),
            chat::PermissionMode::Auto,
            chat::Interaction::Plan,
            None,
            None,
            None,
            Some(&claude::Mcp {
                url: "http://yantra:7717/api/mcp".to_owned(),
                thread: "web/11111111".to_owned(),
            }),
            None,
        ),
    );
    r.keep(
        "claude",
        claude::command(
            WORKTREE,
            &Keeper::new("web", "11111111"),
            chat::PermissionMode::Supervised,
            chat::Interaction::Build,
            None,
            None,
            chat::ContextLength::try_from(256_000).ok(),
            None,
            Some("9a11f727-ba24-4f1a-9c4b-76ce3721282e"),
        ),
    );
    for harness in [
        Harness::Codex,
        Harness::Gemini,
        Harness::Grok,
        Harness::Opencode,
    ] {
        r.keep("acp", ssh::stdio_payload(harness.command()));
        r.keep("acp", harness.kept_command(WORKTREE, None));
        r.keep(
            "acp",
            harness.kept_command(WORKTREE, chat::ContextLength::try_from(256_000).ok()),
        );
    }
    r.keep("mic", ssh::stdio_payload(mic::WRITER));
    r.keep("keep", keep::SCRIPT.to_owned());
    r.keep(
        "keep",
        keep::command("/home/u/.yantra/k", "claude -p", Limits::default()),
    );
    r.keep("keep", keep::appending(&keeper, "run1", 10, 5));
    r.keep("keep", keep::reading(&tmux, &keeper, "%1", 10));
    r.keep(
        "join",
        join::script(
            std::net::SocketAddr::from(([100, 64, 0, 1], join::DAEMON_PORT)),
            "ssh-ed25519 AAAA yantra",
            None,
        )
        .expect("a usable key"),
    );
    r.keep(
        "pty",
        attach::remote_command(&tmux.command(), "web", "xterm-256color"),
    );
    r.keep(
        "pty",
        pty::run_command("sudo apt-get install -y tmux", "xterm-256color"),
    );

    let mut all = Vec::new();
    for (label, script) in r
        .seen()
        .into_iter()
        .chain(mac.seen())
        .chain(bare.seen())
        .chain(serverless.seen())
    {
        opened(&label, &script, &mut all);
    }
    all
}

/// The modules [`every_script`] drives. A module that stops sending a script
/// fails the test rather than leaving it to check nothing.
const MODULES: &[&str] = &[
    "acp",
    "agent",
    "attach",
    "checkpoint",
    "claude",
    "clone",
    "command",
    "commit",
    "delegate",
    "dirs",
    "doctor",
    "down",
    "edit",
    "image",
    "install",
    "join",
    "keep",
    "logs",
    "mention",
    "mic",
    "probe",
    "pty",
    "remove",
    "resume",
    "sessions",
    "stt",
    "terminfo",
    "thread",
    "tmux",
    "tokens",
    "up",
];

/// Scripts sent only past a branch the default [`Recorder`] does not take.
/// A pass that stops reaching one fails the test.
const REACHED: &[&str] = &[
    "|| echo curl",
    "env DEBIAN_FRONTEND=noninteractive sh -c",
    "loginctl enable-linger u",
    INSTALLER,
    "/usr/bin/claude' --version",
    "--format=%s%x00%b",
    "\nlogin_server '/usr/bin/tmux'\n",
];

/// The checker's failures for `scripts`, or `None` when podman is missing.
fn check(scripts: &[(String, String)]) -> Option<Vec<String>> {
    let shells = shells()?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("the clock is after 1970")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("yantra-shells-{}-{stamp}", std::process::id()));
    std::fs::create_dir(&dir).expect("a fresh temp dir");
    for (n, (_, script)) in scripts.iter().enumerate() {
        std::fs::write(dir.join(n.to_string()), script).expect("writing a script");
    }
    let out = shells(&dir);
    let _ = std::fs::remove_dir_all(&dir);
    let out = out.expect("spawning the checker");
    assert!(
        out.status.success(),
        "the checker did not run: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let failures = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| line.strip_prefix("FAIL "))
        .map(|line| {
            let (n, said) = line.split_once(' ').unwrap_or((line, ""));
            let label = n
                .parse::<usize>()
                .ok()
                .and_then(|n| scripts.get(n))
                .map_or("?", |(label, _)| label.as_str());
            format!("{label} (script {n}) {said}")
        })
        .collect();
    Some(failures)
}

/// Runs [`CHECKER`] on a directory of scripts: in the bash 3.2 image with its
/// dash, or `None` when podman is missing.
#[cfg(not(target_os = "macos"))]
fn shells() -> Option<impl Fn(&Path) -> std::io::Result<std::process::Output>> {
    if !podman(&["--version"]).is_ok_and(|out| out.status.success()) {
        assert!(
            std::env::var_os("YANTRA_REQUIRE_PODMAN").is_none(),
            "YANTRA_REQUIRE_PODMAN is set but `podman` is not available"
        );
        eprintln!("SKIPPED: `podman` is not available, so bash 3.2 and dash cannot run.");
        return None;
    }
    ensure_image();
    Some(|dir: &Path| {
        podman(&[
            "run",
            "--rm",
            "--network=none",
            "-v",
            &format!("{}:/s:ro,Z", dir.display()),
            IMAGE,
            "sh",
            "-c",
            CHECKER,
            "checker",
            "/s",
            "bash",
            "dash",
        ])
    })
}

/// A Mac's own shells, which are the ones a Mac runs the scripts with (Y-661).
#[cfg(target_os = "macos")]
fn shells() -> Option<impl Fn(&Path) -> std::io::Result<std::process::Output>> {
    let version = Command::new("/bin/bash")
        .arg("--version")
        .output()
        .expect("macOS has /bin/bash");
    let version = String::from_utf8_lossy(&version.stdout);
    assert!(
        version.contains("version 3.2."),
        "/bin/bash is not macOS's bash 3.2, so this check proves nothing: {version}"
    );
    Some(|dir: &Path| {
        Command::new("/bin/sh")
            .arg("-c")
            .arg(CHECKER)
            .arg("checker")
            .arg(dir)
            .args(["/bin/bash", "/bin/sh", "/bin/dash"])
            .output()
    })
}

#[cfg(not(target_os = "macos"))]
fn ensure_image() {
    if podman(&["image", "exists", IMAGE]).is_ok_and(|out| out.status.success()) {
        return;
    }
    let context = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixture/shells");
    let out = Command::new("podman")
        .args(["build", "-t", IMAGE, "."])
        .current_dir(&context)
        .output()
        .expect("spawning podman build");
    assert!(
        out.status.success(),
        "building {IMAGE} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[cfg(not(target_os = "macos"))]
fn podman(args: &[&str]) -> std::io::Result<std::process::Output> {
    Command::new("podman").args(args).output()
}

#[tokio::test]
async fn every_module_sends_a_script_the_check_sees() {
    let scripts = every_script().await;
    let labels: BTreeSet<&str> = scripts
        .iter()
        .map(|(label, _)| label.split('>').next().unwrap_or(label))
        .collect();
    let missing: Vec<_> = MODULES.iter().filter(|m| !labels.contains(*m)).collect();
    assert!(missing.is_empty(), "no script from {missing:?}");
    let unreached: Vec<_> = REACHED
        .iter()
        .filter(|part| !scripts.iter().any(|(_, script)| script.contains(*part)))
        .collect();
    assert!(unreached.is_empty(), "no script contains {unreached:?}");
}

#[tokio::test]
async fn every_remote_script_parses_under_bash_3_2_and_dash() {
    let scripts = every_script().await;
    let Some(failures) = check(&scripts) else {
        return;
    };
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn the_check_rejects_the_old_case_probe() {
    let old = "p=$(command -v claude 2>/dev/null)\n\
               case \"$p\" in /*) printf '%s\\n' \"$p\"; exit 0 ;; esac\n";
    let Some(failures) = check(&[("old".to_owned(), old.to_owned())]) else {
        return;
    };
    assert!(
        failures.iter().any(|f| f.contains("bash in c=")),
        "bash 3.2 accepted the Y-634 probe: {failures:?}"
    );
}
