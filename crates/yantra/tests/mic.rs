//! `yantra mic <machine>` for real (Y-419, ADR-0031 §7, §B3): the built
//! binary, `pw-record`, the system `ssh`, `pw-cat` and `yantra-mic-sink`, into
//! a tmux session started with the command Yantra launches an agent with.
//!
//! Two accounts in yantrad's systemd fixture stand in for two computers, and
//! each has its own PipeWire. **The one stand-in is the voice:** `espeak-ng`
//! speaks into the laptop's own virtual mic, which is its default source,
//! because a container has no microphone.

// `expect` in a test is a deliberate abort with a message.
#![allow(clippy::expect_used)]

#[path = "../../yantrad/tests/common/mod.rs"]
mod common;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, bail, ensure};
use yantra_core::install::{self, Outcome, Report, Tool};
use yantra_core::ssh::{Exec as _, Machine, Ssh};

use common::{Systemd, UNPRIVILEGED};

const STAND_IN: &str = "mkdir -p \"$HOME/.local/bin\" \
    && printf '#!/bin/sh\\nexit 0\\n' > \"$HOME/.local/bin/claude\" \
    && chmod 755 \"$HOME/.local/bin/claude\"";
/// No such file: no card, so `yantra-mic` becomes the default source.
const NO_CARDS: &str = "/tmp/no-such-cards";
const LAPTOP: &str = "laptop";
const SESSION_AUDIO: &str = "/tmp/session.raw";

/// Short, for I-28's socket path budget, and per process.
fn state_dir(label: &str) -> Result<PathBuf> {
    let dir = PathBuf::from("/tmp").join(format!("yy-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn keypair(dir: &Path) -> Result<(PathBuf, String)> {
    let key = dir.join("key");
    let out = Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-f"])
        .arg(&key)
        .output()
        .context("spawning ssh-keygen")?;
    ensure!(
        out.status.success(),
        "ssh-keygen: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let public = std::fs::read_to_string(dir.join("key.pub"))?;
    Ok((key, public.trim().to_owned()))
}

fn root(systemd: &Systemd, script: &str) -> Result<String> {
    systemd.run(&["bash", "-c", script])
}

/// `script` as the laptop's account, with what its login session would set.
fn laptop(systemd: &Systemd, script: &str) -> Result<String> {
    let out = systemd.exec_as(
        LAPTOP,
        &[
            "bash",
            "-c",
            &format!("export HOME=/home/{LAPTOP} XDG_RUNTIME_DIR=/run/user/$(id -u); {script}"),
        ],
    )?;
    ensure!(
        out.status.success(),
        "`{script}` failed as {LAPTOP} ({}): {}",
        out.status,
        String::from_utf8_lossy(&out.stderr).trim()
    );
    Ok(String::from_utf8(out.stdout)?.trim().to_owned())
}

/// Appends `public` to `user`'s authorized keys.
fn authorise(systemd: &Systemd, user: &str, public: &str) -> Result<()> {
    root(
        systemd,
        &format!(
            "install -d -m 700 -o {user} -g {user} /home/{user}/.ssh && \
             printf '%s\\n' '{public}' >> /home/{user}/.ssh/authorized_keys && \
             chown {user}:{user} /home/{user}/.ssh/authorized_keys && \
             chmod 600 /home/{user}/.ssh/authorized_keys"
        ),
    )?;
    Ok(())
}

async fn connect(systemd: &Systemd, user: &str, key: &Path, dir: &Path) -> Result<Ssh> {
    let ssh = Ssh::new(Machine {
        host: "127.0.0.1".to_owned(),
        user: Some(user.to_owned()),
        port: Some(systemd.ssh_port()?),
        identity: Some(key.to_owned()),
        state_dir: dir.to_owned(),
    })?;
    for _ in 0..50 {
        if ssh.exec("true").await.is_ok() {
            return Ok(ssh);
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    bail!("sshd never let {user} in")
}

async fn said(ssh: &Ssh, script: &str) -> Result<String> {
    let out = ssh.exec(script).await?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

fn mic(report: &Report) -> &Outcome {
    &report
        .steps
        .iter()
        .find(|step| step.tool == Tool::Mic)
        .expect("asked for, so reported")
        .outcome
}

/// Polls `check` until it is true, or fails naming `what`.
async fn until(what: &str, within: Duration, mut check: impl FnMut() -> bool) -> Result<()> {
    let deadline = Instant::now() + within;
    while !check() {
        ensure!(Instant::now() < deadline, "{what} within {within:?}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Ok(())
}

#[tokio::test]
async fn yantra_mic_carries_speech_into_a_yantra_session_until_ctrl_c() -> Result<()> {
    let Some(systemd) = Systemd::start()? else {
        return Ok(());
    };
    systemd.copy_in(
        Path::new(env!("CARGO_BIN_EXE_yantra")),
        "/usr/local/bin/yantra",
    )?;
    root(&systemd, "chmod 755 /usr/local/bin/yantra")?;
    // NOPASSWD, so `install` turns linger on and the laptop's PipeWire runs.
    root(
        &systemd,
        &format!(
            "useradd --create-home {LAPTOP} && \
             printf '%s ALL=(ALL) NOPASSWD: ALL\\n' {LAPTOP} > /etc/sudoers.d/{LAPTOP} && \
             chmod 440 /etc/sudoers.d/{LAPTOP}"
        ),
    )?;
    let dir = state_dir("mic")?;
    let (key, public) = keypair(&dir)?;
    authorise(&systemd, UNPRIVILEGED, &public)?;
    authorise(&systemd, LAPTOP, &public)?;
    systemd.run(&["systemctl", "start", "sshd.service"])?;

    let machine = connect(&systemd, UNPRIVILEGED, &key, &dir).await?;
    let report = install::of(&machine, "machine", STAND_IN, Some(NO_CARDS)).await?;
    assert_eq!(mic(&report), &Outcome::Installed, "{report:?}");
    let laptop_dir = state_dir("laptop")?;
    let laptop_ssh = connect(&systemd, LAPTOP, &key, &laptop_dir).await?;
    let report = install::of(&laptop_ssh, "laptop", STAND_IN, Some(NO_CARDS)).await?;
    assert!(
        matches!(mic(&report), Outcome::Installed | Outcome::Present),
        "{report:?}"
    );
    // The image has no `pgrep`, so without procps-ng every poll below fails.
    root(&systemd, "dnf -y install espeak-ng procps-ng")?;

    // The laptop reaches the machine by name, as ADR-0009 has it.
    laptop(
        &systemd,
        &format!(
            "install -d -m 700 ~/.ssh && ssh-keygen -q -t ed25519 -N '' -f ~/.ssh/id_ed25519 && \
             printf 'Host machine\\n  HostName 127.0.0.1\\n  User {UNPRIVILEGED}\\n  IdentityFile ~/.ssh/id_ed25519\\n' \
               > ~/.ssh/config && chmod 600 ~/.ssh/config"
        ),
    )?;
    let laptop_key = laptop(&systemd, "cat ~/.ssh/id_ed25519.pub")?;
    authorise(&systemd, UNPRIVILEGED, &laptop_key)?;

    // The session: agent.rs's launch command, with a `claude` that records
    // ALSA's `default` the way Claude Code's dictation does.
    said(
        &machine,
        &format!(
            "printf '#!/bin/sh\\nexec arecord -q -f S16_LE -r 16000 -c 1 -t raw {SESSION_AUDIO}\\n' \
               > ~/.local/bin/claude && chmod 755 ~/.local/bin/claude"
        ),
    )
    .await?;
    let launch = format!(
        "cd '/home/{UNPRIVILEGED}' && export PIPEWIRE_NODE=yantra-mic && \
         exec '/home/{UNPRIVILEGED}/.local/bin/claude' --session-id 'y419'"
    );
    // A tmux server a person starts has their login's runtime directory.
    let started = machine
        .exec(&format!(
            "export XDG_RUNTIME_DIR=${{XDG_RUNTIME_DIR:-/run/user/$(id -u)}}; \
             tmux new-session -d -s mic \"{launch}\""
        ))
        .await?;
    ensure!(
        started.success(),
        "tmux: {}",
        String::from_utf8_lossy(&started.stderr)
    );
    until(
        "the session's recorder runs",
        Duration::from_secs(10),
        || {
            systemd
                .exec(&["pgrep", "-u", UNPRIVILEGED, "-x", "arecord"])
                .is_ok_and(|out| out.status.success())
        },
    )
    .await?;

    laptop(
        &systemd,
        "espeak-ng -w /tmp/speech.wav 'Yantra carries this sentence from the laptop to the machine.'",
    )?;
    laptop(
        &systemd,
        "(setsid -w yantra mic machine >/tmp/mic.out 2>/tmp/mic.err </dev/null; \
          echo $? >/tmp/mic.status) >/dev/null 2>&1 </dev/null &",
    )?;
    until(
        "yantra mic says it is streaming",
        Duration::from_secs(20),
        || {
            laptop(&systemd, "cat /tmp/mic.err")
                .is_ok_and(|err| err.contains("streaming the microphone to machine"))
        },
    )
    .await
    .with_context(|| laptop(&systemd, "cat /tmp/mic.err").unwrap_or_default())?;
    tokio::time::sleep(Duration::from_secs(1)).await;
    for _ in 0..2 {
        laptop(
            &systemd,
            "pw-cat --playback --target yantra-mic-sink /tmp/speech.wav",
        )?;
    }
    tokio::time::sleep(Duration::from_secs(1)).await;

    // What a terminal does on Ctrl-C: SIGINT to the foreground process group.
    let pid = laptop(&systemd, &format!("pgrep -u {LAPTOP} -x yantra"))?;
    laptop(&systemd, &format!("kill -INT -- -{pid}"))?;
    until("yantra mic exits", Duration::from_secs(15), || {
        laptop(&systemd, "test -s /tmp/mic.status").is_ok()
    })
    .await?;
    let status = laptop(&systemd, "cat /tmp/mic.status")?;
    let err = laptop(&systemd, "cat /tmp/mic.err")?;
    assert_eq!(status, "0", "yantra mic said: {err}");

    // Ctrl-C closed both ends.
    assert!(
        laptop(&systemd, &format!("! pgrep -u {LAPTOP} -x pw-record")).is_ok(),
        "a pw-record outlived yantra mic"
    );
    until("pw-cat on the machine ends", Duration::from_secs(5), || {
        !systemd
            .exec(&["pgrep", "-u", UNPRIVILEGED, "-x", "pw-cat"])
            .is_ok_and(|out| out.status.success())
    })
    .await?;

    root(
        &systemd,
        &format!("pkill -INT -u {UNPRIVILEGED} -x arecord"),
    )?;
    until(
        "the session's recorder ends",
        Duration::from_secs(10),
        || {
            !systemd
                .exec(&["pgrep", "-u", UNPRIVILEGED, "-x", "arecord"])
                .is_ok_and(|out| out.status.success())
        },
    )
    .await?;
    let heard = root(
        &systemd,
        &format!(
            "python3 -c 'import math,struct; d=open(\"{SESSION_AUDIO}\",\"rb\").read(); n=len(d)//2; \
             s=struct.unpack(\"<%dh\" % n, d[:n*2]); \
             print(max((abs(x) for x in s), default=0), int(math.sqrt(sum(x*x for x in s)/max(n,1))))'"
        ),
    )?;
    let mut levels = heard.split_whitespace().map(str::parse::<i64>);
    let (Some(Ok(peak)), Some(Ok(rms))) = (levels.next(), levels.next()) else {
        bail!("a peak and an RMS: {heard:?}");
    };
    assert!(
        peak > 2000,
        "the speech did not reach the session: peak {peak}, RMS {rms}"
    );

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&laptop_dir);
    Ok(())
}
