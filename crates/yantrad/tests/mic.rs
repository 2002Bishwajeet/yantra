//! The virtual microphone set up for real (Y-417, §B3): `install::of` with the
//! microphone asked for, over a real sshd, on a machine with a real `systemd`,
//! a real user manager and Fedora's real PipeWire packages.
//!
//! Fedora rather than the Alpine fixture, which has no systemd user manager
//! (ADR-0031, "Left open"). A container has no sound card, so the card list
//! is a file the test writes, which is why `install::of` takes its path.
//!
//! **One stand-in, as in `yantra-core/tests/install.rs`:** `claude`'s
//! installer writes a stub, so nothing is fetched from claude.ai. The audio
//! packages are fetched by the container's own `dnf`.

// `expect` in a test is a deliberate abort with a message.
#![allow(clippy::expect_used)]

mod common;

// The event a dashboard reads, built from the same report (Y-394). The
// daemon is a binary, so its module is compiled in here.
#[allow(dead_code)]
#[path = "../src/events.rs"]
mod events;

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail};
use yantra_core::doctor::{self, Check, State};
use yantra_core::install::{self, Because, Outcome, Report, Tool};
use yantra_core::ssh::{Exec as _, Machine, Ssh};

use common::{Systemd, UNPRIVILEGED};

const STAND_IN: &str = "mkdir -p \"$HOME/.local/bin\" \
    && printf '#!/bin/sh\\nexit 0\\n' > \"$HOME/.local/bin/claude\" \
    && chmod 755 \"$HOME/.local/bin/claude\"";

/// An account whose sudo asks for a password, made by the test.
const LISTENER: &str = "listener";
/// No such file: a machine with no card, as Claude Code reads it.
const NO_CARDS: &str = "/tmp/no-such-cards";
const ONE_CARD: &str = "/tmp/one-card";
const RUNTIME: &str = "export XDG_RUNTIME_DIR=/run/user/$(id -u); ";
const TERM: &str = "xterm-256color";

/// Short, for I-28's socket path budget, and per process.
fn state_dir(label: &str) -> Result<PathBuf> {
    let dir = PathBuf::from("/tmp").join(format!("ym-{label}-{}", std::process::id()));
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
    if !out.status.success() {
        bail!("ssh-keygen: {}", String::from_utf8_lossy(&out.stderr));
    }
    let public = std::fs::read_to_string(dir.join("key.pub"))?;
    Ok((key, public.trim().to_owned()))
}

fn sh(systemd: &Systemd, script: &str) -> Result<String> {
    systemd.run(&["bash", "-c", script])
}

/// Lets `user` in with `public`, the way the join command places a key.
fn authorise(systemd: &Systemd, user: &str, public: &str) -> Result<()> {
    sh(
        systemd,
        &format!(
            "install -d -m 700 -o {user} -g {user} /home/{user}/.ssh && \
             printf '%s\\n' '{public}' > /home/{user}/.ssh/authorized_keys && \
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
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
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

fn mic_check(checks: &[Check]) -> &Check {
    checks
        .iter()
        .find(|check| check.check == "mic")
        .expect("doctor reports every check")
}

/// The configured default source WirePlumber keeps, if any: what
/// `set-default-source` writes, and what an automatic choice does not.
async fn configured_source(ssh: &Ssh) -> Result<String> {
    said(
        ssh,
        &format!("{RUNTIME}pw-metadata -n default 0 default.configured.audio.source 2>&1"),
    )
    .await
}

#[tokio::test]
async fn install_sets_up_the_virtual_microphone_and_a_second_run_changes_nothing() -> Result<()> {
    let Some(systemd) = Systemd::start()? else {
        return Ok(());
    };
    let dir = state_dir("deploy")?;
    let (key, public) = keypair(&dir)?;
    authorise(&systemd, UNPRIVILEGED, &public)?;
    systemd.run(&["systemctl", "start", "sshd.service"])?;
    let ssh = connect(&systemd, UNPRIVILEGED, &key, &dir).await?;

    // (h) before: never installed is absent, and says why.
    let before = doctor::of(&ssh, TERM).await;
    let check = mic_check(&before);
    assert_eq!(check.state, State::Absent, "{}", check.detail);
    assert!(check.detail.contains("not installed"), "{}", check.detail);

    let report = install::of(&ssh, "fixture", STAND_IN, Some(NO_CARDS)).await?;
    assert_eq!(mic(&report), &Outcome::Installed, "{report:?}");
    assert!(report.complete(), "{report:?}");

    // (a) the packages, by the commands the rest of ADR-0031 runs.
    for tool in ["pactl --version", "pw-cat --version", "arecord --version"] {
        assert!(ssh.exec(tool).await?.success(), "{tool}");
    }
    // (b)
    assert!(
        ssh.exec(&format!("test -s \"$HOME/{}\"", install::MIC_DROP_IN))
            .await?
            .success()
    );
    // (c)
    let sources = said(&ssh, &format!("{RUNTIME}pactl list short sources")).await?;
    let names: Vec<&str> = sources
        .lines()
        .filter_map(|line| line.split('\t').nth(1))
        .collect();
    assert_eq!(
        names.iter().filter(|name| **name == "yantra-mic").count(),
        1,
        "{sources}"
    );
    // The writer ADR-0031 §5 runs reaches a recorder that only names the
    // variable §3 sets: a 440 Hz tone in, the same peak out.
    let peak = said(
        &ssh,
        &format!(
            r#"{RUNTIME}
PIPEWIRE_NODE=yantra-mic arecord -q -f S16_LE -r 16000 -c 1 -t raw -d 3 /tmp/heard.raw &
sleep 0.5
python3 -c 'import math,struct,sys; sys.stdout.buffer.write(b"".join(struct.pack("<h", int(12000*math.sin(2*math.pi*440*i/16000))) for i in range(32000)))' \
  | pw-cat --playback --raw --target yantra-mic-sink --format s16 --rate 16000 --channels 1 -
wait
python3 -c 'import struct; d=open("/tmp/heard.raw","rb").read(); n=len(d)//2; print(max((abs(x) for x in struct.unpack("<%dh" % n, d[:n*2])), default=0))'"#
        ),
    )
    .await?;
    let peak: i32 = peak.parse().with_context(|| format!("a peak: {peak:?}"))?;
    assert!(
        peak > 6000,
        "the tone did not reach yantra-mic: peak {peak}"
    );

    // (d) ADR-0031 "Left open": the sink never takes what the machine plays.
    let sink = said(&ssh, &format!("{RUNTIME}pactl get-default-sink 2>&1")).await?;
    assert_ne!(sink, "yantra-mic-sink");
    // (e) no card, so the default source is the microphone, and it was chosen.
    let source = said(&ssh, &format!("{RUNTIME}pactl get-default-source")).await?;
    assert_eq!(source, "yantra-mic");
    assert!(
        configured_source(&ssh).await?.contains("yantra-mic"),
        "set-default-source ran"
    );
    assert_eq!(
        said(&ssh, "loginctl show-user \"$(id -un)\" -p Linger --value").await?,
        "yes",
        "sudo asks for nothing here, so linger is on"
    );

    // (h) after.
    let after = doctor::of(&ssh, TERM).await;
    let check = mic_check(&after);
    assert_eq!(check.state, State::Present, "{}", check.detail);

    // (i) §B4: nothing changes, and nothing is restarted.
    let pid = said(
        &ssh,
        "systemctl --user show pipewire-pulse -p MainPID --value",
    )
    .await?;
    let again = install::of(&ssh, "fixture", STAND_IN, Some(NO_CARDS)).await?;
    assert_eq!(mic(&again), &Outcome::Present, "{again:?}");
    let sources = said(&ssh, &format!("{RUNTIME}pactl list short sources")).await?;
    assert_eq!(
        sources
            .lines()
            .filter(|line| line.split('\t').nth(1) == Some("yantra-mic"))
            .count(),
        1,
        "{sources}"
    );
    assert_eq!(
        said(&ssh, &format!("{RUNTIME}pactl get-default-sink 2>&1")).await?,
        sink
    );
    assert_eq!(
        said(&ssh, &format!("{RUNTIME}pactl get-default-source")).await?,
        source
    );
    assert_eq!(
        said(
            &ssh,
            "systemctl --user show pipewire-pulse -p MainPID --value"
        )
        .await?,
        pid,
        "a second run restarts nothing"
    );

    // (f) and (g): an account whose sudo asks for a password, on a machine
    // whose card list names a card. The packages are there now.
    sh(
        &systemd,
        &format!(
            "useradd --create-home {LISTENER} && \
             printf '%s ALL=(ALL) ALL\\n' {LISTENER} > /etc/sudoers.d/{LISTENER} && \
             chmod 440 /etc/sudoers.d/{LISTENER} && \
             printf ' 0 [PCH            ]: HDA-Intel - HDA Intel PCH\\n' > {ONE_CARD} && \
             chmod 644 {ONE_CARD}"
        ),
    )?;
    authorise(&systemd, LISTENER, &public)?;
    let listener_dir = state_dir("listener")?;
    let listener = connect(&systemd, LISTENER, &key, &listener_dir).await?;

    let report = install::of(&listener, "fixture", STAND_IN, Some(ONE_CARD)).await?;
    let linger = format!("sudo loginctl enable-linger {LISTENER}");
    assert_eq!(
        mic(&report),
        &Outcome::ForYou {
            because: Because::SudoAsks,
            command: Some(linger.clone()),
        },
        "{report:?}"
    );
    assert!(!report.complete());
    let event = events::Event::install(&report);
    assert_eq!(event.kind, "install_stopped");
    assert_eq!(event.commands, [linger], "{}", event.said);
    // (f) a card, so Install chose no default source.
    let configured = configured_source(&listener).await?;
    assert!(!configured.contains("yantra-mic"), "{configured}");
    // The ssh login started the user manager, so yantra-mic may be listed;
    // without linger it stops at the next logout, and doctor says so.
    let lingerless = doctor::of(&listener, TERM).await;
    let check = mic_check(&lingerless);
    assert_eq!(check.state, State::Absent, "{}", check.detail);
    assert!(check.detail.contains("linger"), "{}", check.detail);

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&listener_dir);
    Ok(())
}

/// 1.5 s of a 440 Hz tone at 16 kHz, s16le: what the dashboard sends.
fn tone() -> Vec<u8> {
    (0..24_000u32)
        .flat_map(|i| {
            let phase = 2.0 * std::f64::consts::PI * 440.0 * f64::from(i) / 16_000.0;
            #[allow(clippy::cast_possible_truncation)]
            let sample = (12_000.0 * phase.sin()) as i16;
            sample.to_le_bytes()
        })
        .collect()
}

/// Y-418 (ADR-0031 §5–6): the daemon's writer, fed the way the bridge feeds
/// it, reaches a recorder that names `yantra-mic`; and closing it leaves no
/// `pw-cat` behind.
#[tokio::test]
async fn the_dashboards_writer_carries_a_tone_into_yantra_mic_and_ends_when_closed() -> Result<()> {
    let Some(systemd) = Systemd::start()? else {
        return Ok(());
    };
    let dir = state_dir("writer")?;
    let (key, public) = keypair(&dir)?;
    authorise(&systemd, UNPRIVILEGED, &public)?;
    systemd.run(&["systemctl", "start", "sshd.service"])?;
    let ssh = connect(&systemd, UNPRIVILEGED, &key, &dir).await?;

    let report = install::of(&ssh, "fixture", STAND_IN, Some(NO_CARDS)).await?;
    assert_eq!(mic(&report), &Outcome::Installed, "{report:?}");

    let recorder = {
        let ssh = ssh.clone();
        tokio::spawn(async move {
            said(
                &ssh,
                &format!(
                    r#"{RUNTIME}PIPEWIRE_NODE=yantra-mic arecord -q -f S16_LE -r 16000 -c 1 -t raw -d 3 /tmp/pressed.raw
python3 -c 'import struct; d=open("/tmp/pressed.raw","rb").read(); n=len(d)//2; print(max((abs(x) for x in struct.unpack("<%dh" % n, d[:n*2])), default=0))'"#
                ),
            )
            .await
        })
    };
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    let mut stream = yantra_core::mic::open(&ssh)?;
    let mut pace = tokio::time::interval(std::time::Duration::from_millis(20));
    for chunk in tone().chunks(640) {
        pace.tick().await;
        stream.write(chunk).await?;
    }
    stream.close().await?;

    let peak = recorder.await??;
    let peak: i32 = peak.parse().with_context(|| format!("a peak: {peak:?}"))?;
    assert!(
        peak > 6000,
        "the tone did not reach yantra-mic: peak {peak}"
    );

    // Release closed both ends: nothing is left playing into the sink.
    assert!(
        !ssh.exec(&format!("pgrep -u {UNPRIVILEGED} -x pw-cat"))
            .await?
            .success(),
        "a pw-cat outlived its stream"
    );

    let _ = std::fs::remove_dir_all(&dir);
    Ok(())
}
