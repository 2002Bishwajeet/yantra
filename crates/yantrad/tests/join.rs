//! The join command run for real (Y-387, §B3): the script `GET /join` serves,
//! piped into `sh` by an unprivileged account on a machine with a real
//! `systemd` and a real `sshd` that is installed and **off**.
//!
//! **What the host proves at the end is the row's done criterion.** The
//! appliance's config holds only the block [`identity::join_in`] wrote from
//! what the script reported, plus where the container is. Nothing names the
//! account or the key but that block, and ssh first fails without it.
//!
//! **Two things stand in, and both are said where they are used.** The
//! tailnet: no container holds `tailscaled`, so the machine name is given
//! rather than read from `whois`, and `listen.py` answers `POST /api/join`.
//! `write.rs`'s own tests prove that route names the machine from the caller.
//! And GitHub: `release.sh` serves the agent's release with real TLS and real
//! checksums, as it does for `installer.rs`.

// `expect` in a test is a deliberate abort with a message.
#![allow(clippy::expect_used)]

mod common;

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use anyhow::{Context, Result, bail};
use yantra_core::{identity, join};

use common::{Systemd, UNPRIVILEGED, fixture_dir, repo_root};

const REPO: &str = "2002Bishwajeet/yantra";
const DAEMON: &str = "127.0.0.1:7717";
const REPORTS: &str = "/srv/reports";
/// When present, `listen.py` answers that a kept block logs in as this account.
const KEPT_AS: &str = "/srv/kept-as";
const ALIAS: &str = "fixture-box";
const EDITED_ENV: &str = "YANTRA_DAEMON=100.64.0.5:7717";

fn scratch(label: &str) -> Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!("yantra-join-{label}"));
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// `curl | sh` as the person types it. `HOME` is set because a terminal has
/// one and `podman exec` is not a login.
fn run_join(systemd: &Systemd, answer: Option<&str>) -> Result<Output> {
    let mut env = vec![format!("HOME=/home/{UNPRIVILEGED}")];
    if let Some(answer) = answer {
        env.push(format!("YANTRA_JOIN_ANSWER={answer}"));
    }
    let mut argv = vec!["env"];
    argv.extend(env.iter().map(String::as_str));
    argv.extend(["sh", "-c", "cat /fixture/join.sh | sh"]);
    systemd.exec_as(UNPRIVILEGED, &argv)
}

fn succeeded(out: &Output, run: &str) -> Result<String> {
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if !out.status.success() {
        bail!(
            "the {run} join failed ({}):\n{stdout}\n{}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        );
    }
    Ok(stdout)
}

fn sh(systemd: &Systemd, script: &str) -> Result<String> {
    systemd.run(&["bash", "-c", script])
}

fn keys_line_count(systemd: &Systemd, key: &str) -> Result<usize> {
    let keys = sh(
        systemd,
        &format!("cat /home/{UNPRIVILEGED}/.ssh/authorized_keys"),
    )?;
    Ok(keys.lines().filter(|line| *line == key).count())
}

/// The host's own `ssh`, reading only the config at `dir` — never the
/// developer's, and never their agent.
fn ssh_by_name(dir: &Path, command: &str) -> Result<Output> {
    Ok(Command::new("ssh")
        .arg("-F")
        .arg(dir.join("config"))
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "LogLevel=ERROR",
            "-o",
            "IdentityAgent=none",
            "-o",
            "GlobalKnownHostsFile=/dev/null",
        ])
        .arg("-o")
        .arg(format!(
            "UserKnownHostsFile={}",
            dir.join("known_hosts").display()
        ))
        .args([ALIAS, "--", command])
        .output()?)
}

#[test]
fn a_bare_machine_joined_with_one_paste_is_reached_with_the_config_the_join_wrote() -> Result<()> {
    let Some(systemd) = Systemd::start()? else {
        return Ok(());
    };

    // The appliance's half, made the way `GET /join` makes it.
    let appliance = scratch("appliance")?;
    let prepared = identity::prepare_in(&appliance, &[])?;
    let script = join::script(DAEMON.parse()?, &prepared.public_key)?;
    let rendered = appliance.join("join.sh");
    std::fs::write(&rendered, script)?;

    systemd.run(&["mkdir", "-p", "/fixture", "/srv/units"])?;
    for (from, to) in [
        (rendered.clone(), "/fixture/join.sh"),
        (fixture_dir().join("listen.py"), "/fixture/listen.py"),
        (fixture_dir().join("release.sh"), "/fixture/release.sh"),
        (fixture_dir().join("server.py"), "/fixture/server.py"),
        (
            repo_root().join("crates/yantrad/yantrad.service"),
            "/srv/units/yantrad.service",
        ),
        (
            repo_root().join("crates/yantra-agent/yantra-agent.service"),
            "/srv/units/yantra-agent.service",
        ),
    ] {
        systemd.copy_in(&from, to)?;
    }
    sh(&systemd, "chmod 644 /fixture/join.sh")?;
    sh(&systemd, "bash /fixture/release.sh serve")?;
    sh(
        &systemd,
        &format!(
            "bash /fixture/release.sh publish {REPO} {} join",
            yantra_core::about::VERSION
        ),
    )?;
    // The published agent is `sleep`, which exits at once with no argument. This
    // stand-in runs until stopped, and only when systemd handed it the address.
    sh(
        &systemd,
        r#"printf '%s\n' '#!/bin/sh' '[ -n "$YANTRA_DAEMON" ] || exit 1' 'exec sleep infinity' > /srv/staging/yantra-*/yantra-agent"#,
    )?;
    sh(
        &systemd,
        &format!(
            "bash /fixture/release.sh pack {REPO} {}",
            yantra_core::about::VERSION
        ),
    )?;
    sh(
        &systemd,
        &format!("systemd-run --unit=join-listener python3 /fixture/listen.py {REPORTS} {KEPT_AS}"),
    )?;
    sh(
        &systemd,
        "for _ in $(seq 50); do (exec 3<>/dev/tcp/127.0.0.1/7717) 2>/dev/null && exit 0; sleep 0.2; done; exit 1",
    )
    .context("the stand-in for POST /api/join never listened")?;

    assert_eq!(
        systemd.property("sshd.service", "UnitFileState")?,
        "disabled",
        "the machine has to start bare, or turning sshd on proves nothing"
    );

    let accounts = sh(&systemd, "sha256sum /etc/passwd")?;

    // A run with no terminal and no answer takes no step that needs root, and
    // still places the key and reports.
    let quiet = succeeded(&run_join(&systemd, None)?, "unanswered")?;
    assert_eq!(
        systemd.property("sshd.service", "ActiveState")?,
        "inactive",
        "nobody said yes, so sshd must still be off:\n{quiet}"
    );
    assert!(
        !systemd
            .exec(&["test", "-e", "/usr/local/bin/yantra-agent"])?
            .status
            .success(),
        "nobody said yes, so no agent may be installed:\n{quiet}"
    );
    assert_eq!(keys_line_count(&systemd, &prepared.public_key)?, 1);
    assert_eq!(
        sh(
            &systemd,
            &format!(
                "stat -c '%a %U' /home/{UNPRIVILEGED}/.ssh /home/{UNPRIVILEGED}/.ssh/authorized_keys"
            )
        )?,
        format!("700 {UNPRIVILEGED}\n600 {UNPRIVILEGED}\n")
    );

    // Yes to every question: sshd comes on, and the agent is installed.
    let yes = succeeded(&run_join(&systemd, Some("y"))?, "answered")?;
    assert_eq!(
        systemd.property("sshd.service", "UnitFileState")?,
        "enabled",
        "{yes}"
    );
    assert_eq!(systemd.property("sshd.service", "ActiveState")?, "active");
    assert_eq!(keys_line_count(&systemd, &prepared.public_key)?, 1, "{yes}");
    assert_eq!(
        sh(
            &systemd,
            "sha256sum /usr/local/bin/yantra-agent | cut -d' ' -f1"
        )?,
        sh(
            &systemd,
            "sha256sum /srv/staging/yantra-*/yantra-agent | cut -d' ' -f1"
        )?,
        "the agent is not the one the verified archive carried"
    );
    assert_eq!(
        systemd.property("yantra-agent.service", "UnitFileState")?,
        "enabled"
    );
    let env = sh(&systemd, "cat /etc/yantra/agent.env")?;
    assert!(
        env.lines()
            .any(|line| line == format!("YANTRA_DAEMON={DAEMON}")),
        "the daemon's address is the one the script was served with:\n{env}"
    );

    // Owner, 2026-09-12: the agent runs as a systemd DynamicUser, so the
    // machine gains no account and the unit still runs with its address.
    let mut state = String::new();
    for _ in 0..50 {
        state = systemd.property("yantra-agent.service", "ActiveState")?;
        if state == "active" {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    assert_eq!(
        state,
        "active",
        "{}",
        systemd.journal("yantra-agent.service")
    );
    assert!(
        !systemd.exec(&["id", "yantra"])?.status.success(),
        "no yantra account may be created on a joined machine"
    );
    assert_eq!(
        sh(&systemd, "sha256sum /etc/passwd")?,
        accounts,
        "/etc/passwd gained an entry"
    );
    let pid = systemd.property("yantra-agent.service", "MainPID")?;
    let uid: u32 = sh(&systemd, &format!("stat -c %u /proc/{pid}"))?
        .trim()
        .parse()?;
    assert!(
        (61184..=65519).contains(&uid),
        "the agent runs under a dynamic uid, not {uid}"
    );

    // The report: the account the script ran as, and no machine name.
    let reports = sh(&systemd, &format!("cat {REPORTS}"))?;
    let last = reports.lines().last().context("nothing was reported")?;
    let body: serde_json::Value = serde_json::from_str(last)?;
    assert_eq!(
        body,
        serde_json::json!({ "user": UNPRIVILEGED }),
        "{reports}"
    );

    // The host, as the appliance. Where the container is, and nothing else,
    // before the join's block exists: ssh logs in as this account with no key
    // the far side knows, and is refused.
    let config = appliance.join("config");
    let whereabouts = format!(
        "\nHost {ALIAS}\n    HostName 127.0.0.1\n    Port {}\n",
        systemd.ssh_port()?
    );
    std::fs::write(&config, &whereabouts)?;
    let refused = ssh_by_name(&appliance, "true")?;
    assert!(
        !refused.status.success(),
        "without the join's block nothing may authenticate"
    );

    std::fs::remove_file(&config)?;
    std::fs::remove_file(appliance.join("known_hosts")).ok();
    let user = body["user"].as_str().context("a user")?;
    let joined = identity::join_in(&appliance, ALIAS, user)?;
    assert!(!joined.kept && !joined.generated);
    assert_eq!(joined.logs_in_as.as_deref(), Some(UNPRIVILEGED));
    std::fs::write(&config, std::fs::read_to_string(&config)? + &whereabouts)?;
    let out = ssh_by_name(&appliance, "whoami")?;
    if !out.status.success() {
        bail!(
            "the joined machine was not reached with the config the join wrote: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    assert_eq!(String::from_utf8(out.stdout)?.trim(), UNPRIVILEGED);

    // A second run changes nothing that is already there.
    sh(
        &systemd,
        &format!("printf '%s\\n' '{EDITED_ENV}' > /etc/yantra/agent.env"),
    )?;
    let again = succeeded(&run_join(&systemd, Some("y"))?, "second")?;
    assert_eq!(
        keys_line_count(&systemd, &prepared.public_key)?,
        1,
        "{again}"
    );
    assert_eq!(
        sh(&systemd, "cat /etc/yantra/agent.env")?.trim(),
        EDITED_ENV,
        "ADR-0013 §4: an address somebody wrote is never rewritten"
    );
    assert!(
        again.contains("already installed"),
        "the agent is installed once:\n{again}"
    );

    // The owner's re-join ruling: a kept block that logs in as another account
    // is said on this machine's terminal, and the run does not claim success.
    sh(&systemd, &format!("printf 'yantra\\n' > {KEPT_AS}"))?;
    let warned = run_join(&systemd, Some("y"))?;
    let said = String::from_utf8_lossy(&warned.stderr);
    assert!(!warned.status.success(), "{said}");
    assert!(
        said.contains(&format!(
            "yantrad logs in to this machine as yantra, not as {UNPRIVILEGED}"
        )),
        "{said}"
    );

    std::fs::remove_dir_all(&appliance)?;
    Ok(())
}
