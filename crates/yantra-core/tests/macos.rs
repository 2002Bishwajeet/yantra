//! A disposable Mac that answers ssh as itself: CI's GitHub `macos` runner
//! (Y-661). The podman fixture is Linux with bash 5, busybox and no launchd, so
//! these run the same layers against macOS's `/bin/sh` (bash 3.2), BSD `tail`
//! and `wc`, Homebrew's tmux and a user LaunchAgent.
//!
//! Ignored rather than skipped (I-32). **They kill the Mac's tmux server and
//! write a stub `claude`**, so they are not for the owner's Mac; that is
//! `manual_macbook.rs`. The `macos` job in `ci.yml` sets the machine up:
//!
//! ```text
//! just test-macos <ssh destination>
//! ```

#![cfg(target_os = "macos")]
#![allow(clippy::expect_used)]

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail, ensure};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, Lines};
use yantra_core::chat::{Event, Interaction, PermissionMode, StreamKind, TurnState};
use yantra_core::claude::{self, Prompt, Session};
use yantra_core::keep::{self, File, Keeper, Limits, Started};
use yantra_core::ssh::{self, Exec as _, Machine, Os, Ssh};
use yantra_core::tmux::Tmux;
use yantra_core::workspace::Workspace;
use yantra_core::{doctor, probe, terminfo, thread};

/// The LaunchAgent `login_server.sh` writes.
const LABEL: &str = "io.github.2002bishwajeet.yantra-tmux-server";

/// Answers one prompt the way `claude -p --output-format stream-json` does,
/// then waits for its stdin to close. It keeps the prompt and its cwd.
const STUB: &str = r#"#!/bin/sh
IFS= read -r prompt
{ pwd; printf '%s\n' "$prompt"; } >"$HOME/.yantra-stub-seen"
cat <<'EOF'
{"type":"system","subtype":"init","session_id":"00000000-0000-4000-8000-000000000000"}
{"type":"stream_event","event":{"type":"message_start","message":{"id":"m1"}}}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"pong from "}}}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"the Mac"}}}
{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","modelUsage":{}}
EOF
cat >/dev/null
"#;

struct Lab {
    ssh: Ssh,
    tmux: Tmux,
    dir: PathBuf,
}

impl Lab {
    async fn start(label: &str) -> Result<Self> {
        let host = std::env::var("YANTRA_MAC_RUNNER").context("YANTRA_MAC_RUNNER is not set")?;
        // Short on purpose: `%C` adds 40 characters and the budget is 90 (I-28).
        let dir = PathBuf::from("/tmp").join(format!("ym-{label}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)?;
        let ssh = Ssh::new(Machine {
            host,
            user: None,
            port: None,
            identity: None,
            state_dir: dir.clone(),
        })?;
        ensure!(
            ssh::os(&ssh).await? == Os::MacOs,
            "YANTRA_MAC_RUNNER is not a Mac"
        );
        let tmux = Tmux::resolve(&ssh).await?;
        Ok(Self { ssh, tmux, dir })
    }

    async fn run(&self, command: &str) -> Result<String> {
        let out = self.ssh.exec(command).await?;
        ensure!(
            out.success(),
            "`{command}` failed ({}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        );
        Ok(String::from_utf8(out.stdout)?)
    }

    async fn start_keeper(&self, keeper: &Keeper, agent: &str, limits: Limits) -> Result<String> {
        let run = keep::run_id()?;
        match keep::start(&self.ssh, &self.tmux, keeper, agent, &run, limits).await? {
            Started::Running { pane } => Ok(pane),
            Started::Busy => bail!("the keeper's session was already there"),
        }
    }

    async fn until_dead(&self, keeper: &Keeper) -> Result<yantra_core::tmux::Pane> {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(pane) = keep::pane(&self.ssh, &self.tmux, keeper).await?
                && pane.dead
            {
                return Ok(pane);
            }
            ensure!(Instant::now() < deadline, "the keeper's pane died in 30 s");
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    /// Kills every local `ssh` of this lab: the readers' and the ControlMaster.
    fn kill_local_ssh(&self) {
        let _ = Command::new("pkill")
            .args(["-f", &self.dir.to_string_lossy()])
            .status();
    }
}

impl Drop for Lab {
    fn drop(&mut self) {
        self.kill_local_ssh();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Reads the counter's next line, which must follow `last`.
async fn counted(lines: &mut Lines<BufReader<DuplexStream>>, last: &mut u64) -> Result<()> {
    let line = tokio::time::timeout(Duration::from_secs(20), lines.next_line())
        .await??
        .context("the reader ended early")?;
    let n = serde_json::from_str::<serde_json::Value>(&line)?["n"]
        .as_u64()
        .context("no counter")?;
    ensure!(n == *last + 1, "{n} follows {last}");
    *last = n;
    Ok(())
}

/// I-34 on a real Mac: Homebrew's tmux is not on the ssh `PATH`, and resolve
/// still finds it.
#[tokio::test]
#[ignore = "needs a disposable Mac; set YANTRA_MAC_RUNNER (CI's macos job does)"]
async fn tmux_resolves_outside_the_ssh_path() -> Result<()> {
    let lab = Lab::start("resolve").await?;
    println!("resolved {}", lab.tmux.path());
    ensure!(lab.tmux.path().starts_with('/'), "{}", lab.tmux.path());
    Ok(())
}

/// §B4 on a real Mac: the second open attaches to the first session.
#[tokio::test]
#[ignore = "needs a disposable Mac; set YANTRA_MAC_RUNNER (CI's macos job does)"]
async fn a_second_open_attaches() -> Result<()> {
    let lab = Lab::start("open").await?;
    let first = lab
        .tmux
        .ensure(&lab.ssh, "yantra-ci-open", "/tmp", Some("sleep 600"))
        .await?;
    let second = lab
        .tmux
        .ensure(&lab.ssh, "yantra-ci-open", "/tmp", Some("sleep 600"))
        .await?;
    lab.tmux.kill(&lab.ssh, "yantra-ci-open").await?;
    ensure!(first.was_created() && !second.was_created());
    ensure!(first.session().session_id == second.session().session_id);
    Ok(())
}

/// ADR-0035 on BSD `tail`: the agent outlives its `ssh` and the ControlMaster,
/// the reader carries on with no line lost or repeated, and ends with the pane.
#[tokio::test]
#[ignore = "needs a disposable Mac; set YANTRA_MAC_RUNNER (CI's macos job does)"]
async fn the_keeper_outlives_its_ssh_and_its_reader_ends_with_the_pane() -> Result<()> {
    let lab = Lab::start("outlive").await?;
    let keeper = Keeper::new("ci", "1a2b3c4d5e6f7a8b");
    let agent = "exec sh -c 'n=0; while :; do n=$((n+1)); echo \"{\\\"n\\\":$n}\"; \
                 sleep 0.2; done' yantra-ci-agent";
    let pane = lab.start_keeper(&keeper, agent, Limits::default()).await?;
    let reader = keep::follow(lab.ssh.clone(), lab.tmux.clone(), keeper.clone(), pane, 0);
    let mut lines = BufReader::new(reader).lines();
    let mut last = 0;
    for _ in 0..5 {
        counted(&mut lines, &mut last).await?;
    }
    lab.kill_local_ssh();
    for _ in 0..20 {
        counted(&mut lines, &mut last).await?;
    }

    lab.run("pkill -f yantra-ci-agen[t]; true").await?;
    lab.until_dead(&keeper).await?;
    let ended = tokio::time::timeout(Duration::from_secs(20), async {
        while let Ok(Some(_)) = lines.next_line().await {}
    })
    .await;
    ensure!(ended.is_ok(), "the reader ended with the pane");
    keep::kill(&lab.ssh, &lab.tmux, &keeper).await?;
    ensure!(keep::pane(&lab.ssh, &lab.tmux, &keeper).await?.is_none());
    Ok(())
}

/// Y-667: a keeper killed while its pane lives leaves the `-D` server with no
/// session, and the reader still ends.
#[tokio::test]
#[ignore = "needs a disposable Mac; set YANTRA_MAC_RUNNER (CI's macos job does)"]
async fn the_reader_ends_when_the_last_session_is_killed() -> Result<()> {
    let lab = Lab::start("empty").await?;
    let tmux = lab.tmux.command();
    lab.run(&format!(
        "{tmux} ls -F '#{{session_id}}' 2>/dev/null | while read -r s; do \
         {tmux} kill-session -t \"$s\"; done; true"
    ))
    .await?;
    let keeper = Keeper::new("ci", "2b3c4d5e6f7a8b9c");
    let pane = lab
        .start_keeper(&keeper, "exec sleep 600", Limits::default())
        .await?;
    let reader = keep::follow(lab.ssh.clone(), lab.tmux.clone(), keeper.clone(), pane, 0);
    keep::kill(&lab.ssh, &lab.tmux, &keeper).await?;
    ensure!(
        lab.tmux.running(&lab.ssh).await?,
        "the yantra server ended with its last session"
    );
    let ended = tokio::time::timeout(Duration::from_secs(20), async {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(_)) = lines.next_line().await {}
    })
    .await;
    ensure!(ended.is_ok(), "the reader ended on the empty server");
    Ok(())
}

/// Lines appended to `in` reach the agent, and a shut writer ends it.
#[tokio::test]
#[ignore = "needs a disposable Mac; set YANTRA_MAC_RUNNER (CI's macos job does)"]
async fn lines_reach_the_kept_agent_and_a_shut_writer_ends_it() -> Result<()> {
    let lab = Lab::start("feed").await?;
    let keeper = Keeper::new("ci", "3c4d5e6f7a8b9c0d");
    lab.start_keeper(&keeper, "exec cat", Limits::default())
        .await?;
    let run = String::from_utf8(keep::read(&lab.ssh, &keeper, File::Run, None).await?)?;
    let mut writer = keep::feed(
        lab.ssh.clone(),
        lab.tmux.clone(),
        keeper.clone(),
        run.trim(),
        0,
    );
    writer.write_all(b"{\"one\":1}\n{\"two\":2}\n").await?;
    writer.flush().await?;
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let out = keep::read(&lab.ssh, &keeper, File::Out, None).await?;
        if out == b"{\"one\":1}\n{\"two\":2}\n" {
            break;
        }
        ensure!(Instant::now() < deadline, "out holds {out:?}");
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    ensure!(keep::size(&lab.ssh, &keeper, File::In).await? == 20);
    writer.shutdown().await?;
    let dead = lab.until_dead(&keeper).await?;
    ensure!(dead.status == Some(0), "cat ended at EOF: {dead:?}");
    keep::kill(&lab.ssh, &lab.tmux, &keeper).await?;
    Ok(())
}

/// ADR-0035 decision 5 on BSD `tail` and `wc`: each limit stops the agent and
/// says why.
#[tokio::test]
#[ignore = "needs a disposable Mac; set YANTRA_MAC_RUNNER (CI's macos job does)"]
async fn both_keeper_limits_fire_on_the_mac() -> Result<()> {
    let lab = Lab::start("limits").await?;
    let big = Keeper::new("ci", "4d5e6f7a8b9c0d1e");
    let cap = Limits {
        cap: 4096,
        idle: 3600,
        tick: 1,
    };
    lab.start_keeper(&big, "exec yes", cap).await?;
    let idle = Keeper::new("ci", "5e6f7a8b9c0d1e2f");
    let quiet = Limits {
        cap: 1 << 20,
        idle: 2,
        tick: 1,
    };
    lab.start_keeper(&idle, "exec sleep 600", quiet).await?;

    lab.until_dead(&big).await?;
    let said = String::from_utf8(keep::read(&lab.ssh, &big, File::Err, None).await?)?;
    ensure!(said.contains("yantra: output passed 4096 bytes"), "{said}");
    lab.until_dead(&idle).await?;
    let said = String::from_utf8(keep::read(&lab.ssh, &idle, File::Err, None).await?)?;
    ensure!(said.contains("yantra: idle for 2 seconds"), "{said}");
    for keeper in [&big, &idle] {
        keep::kill(&lab.ssh, &lab.tmux, keeper).await?;
    }
    Ok(())
}

/// A Chat turn as `yantrad` runs one: `claude::command` in a keeper, read and
/// written through it. Its probe runs inside `c=$(…)` under the Mac's
/// `/bin/sh`, which is where Y-634 broke every turn.
#[tokio::test]
#[ignore = "needs a disposable Mac; set YANTRA_MAC_RUNNER (CI's macos job does)"]
async fn a_chat_turn_runs_through_the_keeper_on_the_mac() -> Result<()> {
    let lab = Lab::start("chat").await?;
    stub_turn(&lab, "/private/tmp/ym-chat-repo").await
}

/// I-56 closed: a Chat turn reaches no gate of its own, so with no server at
/// all `keep::start` must have the LaunchAgent start one, in the login session.
#[tokio::test]
#[ignore = "needs a disposable Mac; set YANTRA_MAC_RUNNER (CI's macos job does)"]
async fn a_chat_turn_with_no_login_server_starts_the_launch_agent() -> Result<()> {
    let lab = Lab::start("nogate").await?;
    lab.run(&format!(
        "launchctl bootout gui/$(id -u)/{LABEL} 2>/dev/null; {} kill-server 2>/dev/null; true",
        lab.tmux.command()
    ))
    .await?;
    ensure!(
        !lab.tmux.running(&lab.ssh).await?,
        "the yantra server outlived the bootout"
    );
    stub_turn(&lab, "/private/tmp/ym-nogate-repo").await?;
    let (job, server) = login_server_pids(&lab).await?;
    ensure!(job.is_some(), "the LaunchAgent is not running");
    ensure!(
        job == server,
        "the yantra server is pid {server:?} and the job is pid {job:?}, so the server is not \
         the login session's"
    );
    Ok(())
}

/// The pid `launchctl` gives the job, and the yantra server's pid, once they
/// agree or after 10 s. KeepAlive may be restarting a server that emptied.
async fn login_server_pids(lab: &Lab) -> Result<(Option<u32>, Option<u32>)> {
    let ask = format!(
        "echo \"$(launchctl print gui/$(id -u)/{LABEL} 2>/dev/null | awk '$1 == \"pid\" {{ print $3 }}')\"\n\
         echo \"$({} display-message -p '#{{pid}}' 2>/dev/null)\"",
        lab.tmux.command()
    );
    let mut pids = (None, None);
    for _ in 0..10 {
        let said = lab.run(&ask).await?;
        let mut lines = said.lines().map(|line| line.trim().parse().ok());
        pids = (lines.next().flatten(), lines.next().flatten());
        if pids.0.is_some() && pids.0 == pids.1 {
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    Ok(pids)
}

/// A turn of the stub `claude` in a thread of a new repository at `repo`.
async fn stub_turn(lab: &Lab, repo: &str) -> Result<()> {
    let stub = lab
        .run("[ -e \"$HOME/.local/bin/claude\" ] && echo there || true")
        .await?;
    ensure!(
        stub.trim().is_empty(),
        "~/.local/bin/claude exists on YANTRA_MAC_RUNNER, so this is not a disposable Mac"
    );
    lab.run(&format!(
        "rm -rf {repo} && mkdir -p {repo} && cd {repo} && git init -q && echo one > README \
         && git add README && git -c user.name=t -c user.email=t@example.com commit -qm one \
         && mkdir -p \"$HOME/.local/bin\" && cat > \"$HOME/.local/bin/claude\" <<'STUB'\n\
         {STUB}STUB\nchmod +x \"$HOME/.local/bin/claude\""
    ))
    .await?;
    let workspace = Workspace {
        name: "ci".to_owned(),
        machine: "runner".to_owned(),
        repo: repo.into(),
        startup: None,
    };
    let place = thread::open(&lab.ssh, &workspace).await?;
    let keeper = Keeper::of(&place).context("a chat place has a keeper")?;
    let agent = claude::command(
        &place.worktree,
        &keeper,
        PermissionMode::Supervised,
        Interaction::Build,
        None,
        None,
        None,
        None,
        None,
    );
    let run = keep::run_id()?;
    let Started::Running { pane } = keep::start(
        &lab.ssh,
        &lab.tmux,
        &keeper,
        &agent,
        &run,
        Limits::default(),
    )
    .await?
    else {
        bail!("the thread's keeper was already running");
    };
    let reader = keep::follow(lab.ssh.clone(), lab.tmux.clone(), keeper.clone(), pane, 0);
    let writer = keep::feed(lab.ssh.clone(), lab.tmux.clone(), keeper.clone(), &run, 0);
    let (ssh, kept) = (lab.ssh.clone(), keeper.clone());
    let said: claude::Said = Box::pin(async move {
        let err = keep::read(&ssh, &kept, File::Err, None)
            .await
            .unwrap_or_default();
        String::from_utf8_lossy(&err).into_owned()
    });
    let (_session, mut events) = Session::kept(
        reader,
        writer,
        thread::name(&place),
        &run,
        &Prompt {
            text: "Say pong.",
            mode: PermissionMode::Supervised,
            interaction: Interaction::Build,
            model: None,
            effort: None,
            context: None,
        },
        said,
    );

    let mut text = String::new();
    let done = tokio::time::timeout(Duration::from_secs(60), async {
        while let Some(next) = events.recv().await {
            match next.event {
                Event::ContentDelta(delta) if delta.stream_kind == StreamKind::AssistantText => {
                    text.push_str(&delta.delta);
                }
                Event::TurnCompleted(done) => return Some(done),
                _ => {}
            }
        }
        None
    })
    .await
    .context("the turn did not end in 60 s")?
    .context("the events ended before turn.completed")?;
    keep::kill(&lab.ssh, &lab.tmux, &keeper).await?;
    let seen = lab
        .run("cat \"$HOME/.yantra-stub-seen\" 2>/dev/null || true")
        .await?;
    lab.run("rm -f \"$HOME/.local/bin/claude\" \"$HOME/.yantra-stub-seen\"")
        .await?;

    ensure!(
        done.state == TurnState::Completed,
        "the turn ended {done:?}"
    );
    ensure!(text == "pong from the Mac", "the turn said {text:?}");
    ensure!(
        seen.lines().next() == Some(place.worktree.as_str()),
        "claude ran in {seen:?}, not the thread's worktree {}",
        place.worktree
    );
    ensure!(
        seen.contains("Say pong."),
        "the prompt did not arrive: {seen}"
    );
    Ok(())
}

/// Y-184 on the Mac's `/bin/sh` and git: a repository, its origin and a path
/// with a space.
#[tokio::test]
#[ignore = "needs a disposable Mac; set YANTRA_MAC_RUNNER (CI's macos job does)"]
async fn the_path_probe_answers_on_the_mac() -> Result<()> {
    let lab = Lab::start("probe").await?;
    lab.run(
        "rm -rf '/tmp/ym probe' && mkdir -p '/tmp/ym probe' && cd '/tmp/ym probe' \
         && git init -q && git remote add origin https://example.invalid/o/r.git",
    )
    .await?;
    let found = probe::probe_on(&lab.ssh, "runner", "/tmp/ym probe").await?;
    ensure!(found.exists);
    ensure!(found.origin.as_deref() == Some("https://example.invalid/o/r.git"));
    let absent = probe::probe_on(&lab.ssh, "runner", "/tmp/ym-no-such-place").await?;
    ensure!(!absent.exists);
    Ok(())
}

/// Every doctor check gets an answer from the Mac's own tools, and the ones a
/// runner has are present.
#[tokio::test]
#[ignore = "needs a disposable Mac; set YANTRA_MAC_RUNNER (CI's macos job does)"]
async fn doctor_asks_every_question_on_the_mac() -> Result<()> {
    let lab = Lab::start("doctor").await?;
    let checks = doctor::of(&lab.ssh, terminfo::FALLBACK).await;
    for check in &checks {
        println!("{}: {:?} — {}", check.check, check.state, check.detail);
    }
    for name in [
        "reachable",
        "sshd",
        "tmux",
        "git",
        "terminfo",
        "folder-access",
    ] {
        let check = checks
            .iter()
            .find(|check| check.check == name)
            .with_context(|| format!("doctor reported no {name} check"))?;
        ensure!(
            check.state == doctor::State::Present,
            "{name} is {:?}: {}",
            check.state,
            check.detail
        );
    }
    let broken: Vec<_> = checks
        .iter()
        .filter(|check| check.detail.contains("syntax error"))
        .collect();
    ensure!(
        broken.is_empty(),
        "a doctor script did not parse: {broken:?}"
    );
    Ok(())
}

/// ADR-0018 §7 and Y-632: with no tmux server, the LaunchAgent starts one in
/// the login session, and its panes get the login shell's `PATH` (Y-640).
#[tokio::test]
#[ignore = "needs a disposable Mac; set YANTRA_MAC_RUNNER (CI's macos job does)"]
async fn the_launch_agent_starts_the_tmux_server() -> Result<()> {
    let lab = Lab::start("launchd").await?;
    let tmux = lab.tmux.command();
    lab.run(&format!("{tmux} kill-server 2>/dev/null; true"))
        .await?;
    let started = lab.tmux.login_server(&lab.ssh).await;
    let job = lab
        .run(&format!(
            "launchctl print gui/$(id -u)/{LABEL} >/dev/null 2>&1 && echo loaded || true"
        ))
        .await?;
    lab.run(&format!(
        "{tmux} new-session -d -s yantra-ci-path 'printenv PATH > /tmp/ym-path; sleep 60'"
    ))
    .await?;
    tokio::time::sleep(Duration::from_secs(1)).await;
    let path = lab.run("cat /tmp/ym-path").await?;
    lab.run(&format!(
        "launchctl bootout gui/$(id -u)/{LABEL} 2>/dev/null; \
         rm -f \"$HOME/Library/LaunchAgents/{LABEL}.plist\" /tmp/ym-path; \
         {tmux} kill-server 2>/dev/null; true"
    ))
    .await?;

    ensure!(
        started?,
        "login_server found no one at the screen: the runner has no gui domain"
    );
    ensure!(job.trim() == "loaded", "the LaunchAgent is not loaded");
    ensure!(
        path.split(':').any(|dir| dir == "/opt/homebrew/bin"),
        "the server's panes miss Homebrew: {path}"
    );
    Ok(())
}

/// The LaunchAgent `install.sh` writes for the agent, the label join.sh uses.
const AGENT_LABEL: &str = "io.github.2002bishwajeet.yantra-agent";

/// Copies the release file the URL names from `$YANTRA_TEST_RELEASE`, so
/// `install.sh` runs whole with no network.
const CURL_STUB: &str = r#"#!/bin/sh
out=
while [ "$#" -gt 0 ]; do
    case "$1" in -o) out=$2; shift ;; esac
    url=$1
    shift
done
cp "$YANTRA_TEST_RELEASE/${url##*/}" "$out"
"#;

/// A fake release for `install.sh`: both Mac archives, each holding a
/// `yantra-agent` that writes the `YANTRA_DAEMON` it was started with to `seen`.
struct Release {
    root: PathBuf,
    uid: String,
}

impl Release {
    const VERSION: &'static str = "9.9.9";

    fn new() -> Result<Self> {
        let root = std::env::temp_dir().join("yantra-y502");
        let _ = std::fs::remove_dir_all(&root);
        let release = root.join("release");
        std::fs::create_dir_all(&release)?;
        std::fs::create_dir_all(root.join("bin"))?;
        let agent = format!(
            "#!/bin/sh\nprintf '%s\\n' \"$YANTRA_DAEMON\" >'{}'\nexec sleep 600\n",
            root.join("seen").display()
        );
        for target in ["aarch64-apple-darwin", "x86_64-apple-darwin"] {
            let name = format!("yantra-{}-{target}", Self::VERSION);
            std::fs::create_dir_all(root.join(&name))?;
            executable(&root.join(&name).join("yantra-agent"), &agent)?;
            succeed(
                Command::new("tar")
                    .arg("-C")
                    .arg(&root)
                    .arg("-czf")
                    .arg(release.join(format!("{name}.tar.gz")))
                    .arg(&name),
            )?;
        }
        succeed(
            Command::new("sh")
                .args(["-c", "shasum -a 256 *.tar.gz >SHA256SUMS"])
                .current_dir(&release),
        )?;
        executable(&root.join("bin/curl"), CURL_STUB)?;
        let uid = succeed(Command::new("id").arg("-u"))?.trim().to_owned();
        Ok(Self { root, uid })
    }

    fn home(&self, name: &str) -> Result<PathBuf> {
        let home = self.root.join(name);
        std::fs::create_dir_all(&home)?;
        Ok(home)
    }

    fn install(&self, home: &Path, daemon: Option<&str>, args: &[&str]) -> Result<Output> {
        let mut command = Command::new("/bin/bash");
        command
            .arg(install_sh())
            .args(args)
            .env("HOME", home)
            .env(
                "PATH",
                format!(
                    "{}:/usr/bin:/bin:/usr/sbin:/sbin",
                    self.root.join("bin").display()
                ),
            )
            .env("YANTRA_VERSION", Self::VERSION)
            .env("YANTRA_TEST_RELEASE", self.root.join("release"))
            .env_remove("YANTRA_DAEMON")
            .stdin(Stdio::null());
        if let Some(daemon) = daemon {
            command.env("YANTRA_DAEMON", daemon);
        }
        Ok(command.output()?)
    }

    fn loaded(&self) -> Result<bool> {
        Ok(Command::new("launchctl")
            .arg("print")
            .arg(format!("gui/{}/{AGENT_LABEL}", self.uid))
            .output()?
            .status
            .success())
    }

    fn bootout(&self) {
        let _ = Command::new("launchctl")
            .arg("bootout")
            .arg(format!("gui/{}/{AGENT_LABEL}", self.uid))
            .output();
    }

    /// Waits for the stub agent to write `want`, the address launchd gave it.
    fn until_seen(&self, want: &str) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut seen = String::new();
        while Instant::now() < deadline {
            seen = std::fs::read_to_string(self.root.join("seen")).unwrap_or_default();
            if seen.trim() == want {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        bail!("the agent never saw YANTRA_DAEMON={want}; it saw {seen:?}")
    }
}

impl Drop for Release {
    fn drop(&mut self) {
        self.bootout();
    }
}

fn install_sh() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../install.sh")
}

fn executable(path: &Path, body: &str) -> Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::write(path, body)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))?;
    Ok(())
}

fn succeed(command: &mut Command) -> Result<String> {
    let out = command.output()?;
    ensure!(
        out.status.success(),
        "{command:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn said(out: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
}

/// Y-502: `install.sh` on a Mac installs the agent alone as a LaunchAgent that
/// reads `~/.config/yantra/agent.env`, and a second run attaches (§B4). On a
/// Mac that joined, it keeps the address join.sh's LaunchAgent held.
#[test]
#[ignore = "needs a disposable Mac: it loads the agent's LaunchAgent (CI's macos job does)"]
fn install_sh_installs_the_agent_on_a_mac() -> Result<()> {
    let release = Release::new()?;
    release.bootout();

    let refused = Command::new("sudo")
        .args(["-n", "/bin/bash"])
        .arg(install_sh())
        .stdin(Stdio::null())
        .output()?;
    ensure!(
        !refused.status.success() && said(&refused).contains("not as root"),
        "a run as root was not refused: {}",
        said(&refused)
    );
    let fresh = release.home("fresh")?;
    let nightly = release.install(&fresh, Some("100.64.0.5:7717"), &["--channel", "nightly"])?;
    ensure!(
        !nightly.status.success() && said(&nightly).contains("nightly"),
        "--channel nightly was not refused: {}",
        said(&nightly)
    );

    let out = release.install(&fresh, None, &[])?;
    ensure!(out.status.success(), "install.sh failed: {}", said(&out));
    let env = std::fs::read_to_string(fresh.join(".config/yantra/agent.env"))?;
    ensure!(env.contains("#YANTRA_DAEMON="), "no placeholder: {env}");
    ensure!(!release.loaded()?, "the agent loaded with no daemon named");

    let home = release.home("home")?;
    let plist = home.join(format!("Library/LaunchAgents/{AGENT_LABEL}.plist"));
    let env_file = home.join(".config/yantra/agent.env");
    let out = release.install(&home, Some("100.64.0.5:7717"), &[])?;
    ensure!(out.status.success(), "install.sh failed: {}", said(&out));
    ensure!(
        said(&out).contains("reports to 100.64.0.5:7717"),
        "{}",
        said(&out)
    );
    ensure!(home.join(".local/bin/yantra-agent").is_file(), "no binary");
    ensure!(
        std::fs::read_to_string(&env_file)?.contains("\nYANTRA_DAEMON=100.64.0.5:7717\n"),
        "agent.env does not name the daemon"
    );
    succeed(Command::new("plutil").arg("-lint").arg(&plist))?;
    ensure!(release.loaded()?, "the LaunchAgent is not loaded");
    release.until_seen("100.64.0.5:7717")?;

    let edited = "YANTRA_DAEMON=100.64.0.6:7717\n";
    std::fs::write(&env_file, edited)?;
    std::fs::write(&plist, "")?;
    let _ = std::fs::remove_file(release.root.join("seen"));
    let out = release.install(&home, Some("100.64.0.5:7717"), &[])?;
    ensure!(
        out.status.success(),
        "the second run failed: {}",
        said(&out)
    );
    ensure!(
        std::fs::read_to_string(&env_file)? == edited,
        "the second run rewrote agent.env"
    );
    succeed(Command::new("plutil").arg("-lint").arg(&plist))?;
    ensure!(release.loaded()?, "the second run left the agent unloaded");
    release.until_seen("100.64.0.6:7717")?;

    // A Mac that joined: join.sh's LaunchAgent holds the address and no agent.env exists.
    release.bootout();
    let joined = release.home("joined")?;
    let plist = joined.join(format!("Library/LaunchAgents/{AGENT_LABEL}.plist"));
    std::fs::create_dir_all(plist.parent().context("a plist has a directory")?)?;
    std::fs::write(
        &plist,
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict>\
             <key>Label</key><string>{AGENT_LABEL}</string>\
             <key>ProgramArguments</key><array><string>/bin/sleep</string><string>600</string></array>\
             <key>EnvironmentVariables</key><dict><key>YANTRA_DAEMON</key><string>100.64.0.7:7717</string></dict>\
             <key>RunAtLoad</key><true/></dict></plist>\n"
        ),
    )?;
    succeed(
        Command::new("launchctl")
            .arg("bootstrap")
            .arg(format!("gui/{}", release.uid))
            .arg(&plist),
    )?;
    let _ = std::fs::remove_file(release.root.join("seen"));
    let out = release.install(&joined, None, &[])?;
    ensure!(
        out.status.success(),
        "the run on a joined Mac failed: {}",
        said(&out)
    );
    ensure!(
        std::fs::read_to_string(joined.join(".config/yantra/agent.env"))?
            .contains("\nYANTRA_DAEMON=100.64.0.7:7717\n"),
        "agent.env lost the address the join command wrote: {}",
        said(&out)
    );
    ensure!(release.loaded()?, "the joined Mac's agent is not loaded");
    release.until_seen("100.64.0.7:7717")?;
    Ok(())
}
