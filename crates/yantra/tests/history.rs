//! `yantra history stage` on a machine with a real Claude Code and a real
//! gitleaks, in a disposable podman container (§B3, Y-430).
//!
//! The transcript is produced, not described: a real `claude -p` writes it
//! against a stand-in for the Messages API. The proof that redaction left it
//! usable is a real `claude --resume` of the staged copy, and the stand-in's
//! log of what that resume sent.

use std::io::Write as _;
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result, bail, ensure};

/// Bump the tag when `tests/fixture/` changes; the image is built once and
/// then reused from the local store.
const IMAGE: &str = "localhost/yantra-history:1";
const BUILD_ATTEMPTS: u32 = 2;

/// R18 §11.3's three fake secrets. The last is the one gitleaks' own rules miss.
const GHP: &str = "ghp_aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6";
const API_TOKEN: &str = "Zq7Xw2Lp9Rt4Vb8Nm3Kc";
const DB_PASSWORD: &str = "Hunter2Correct9xQ";

const STAGING: &str = "/home/dev/.local/share/yantra/history";
const API_LOG: &str = "/tmp/api.jsonl";
const CLAUDE_ENV: &str = "export ANTHROPIC_BASE_URL=http://127.0.0.1:8080 \
     ANTHROPIC_API_KEY=sk-ant-fake CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1;";

struct Fixture {
    container: String,
}

impl Fixture {
    /// `Ok(None)` when podman is not installed, unless `YANTRA_REQUIRE_PODMAN`
    /// is set (I-32).
    fn start() -> Result<Option<Self>> {
        if !podman(&["--version"]).is_ok_and(|out| out.status.success()) {
            if std::env::var_os("YANTRA_REQUIRE_PODMAN").is_some() {
                bail!("YANTRA_REQUIRE_PODMAN is set but `podman` is not available");
            }
            eprintln!("SKIPPED: `podman` is not available, so the history fixture cannot run.");
            return Ok(None);
        }
        ensure_image()?;
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let name = format!("yantra-history-{}-{stamp}", std::process::id());
        let out = podman(&[
            "run",
            "-d",
            "--rm",
            "--name",
            &name,
            "--label",
            "yantra-fixture=1",
            IMAGE,
        ])?;
        ensure!(
            out.status.success(),
            "podman run failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
        let fixture = Self { container: name };

        let yantra = Path::new(env!("CARGO_BIN_EXE_yantra"))
            .display()
            .to_string();
        let copied = podman(&[
            "cp",
            &yantra,
            &format!("{}:/usr/local/bin/yantra", fixture.container),
        ])?;
        ensure!(copied.status.success(), "copying yantra in failed");
        fixture.root("chmod 755 /usr/local/bin/yantra")?;

        let stub = podman(&[
            "exec",
            "-d",
            "-u",
            "dev",
            &fixture.container,
            "python3",
            "/opt/messages.py",
            "8080",
            API_LOG,
        ])?;
        ensure!(stub.status.success(), "the API stand-in did not start");
        let deadline = Instant::now() + Duration::from_secs(15);
        while fixture
            .sh("curl -s -o /dev/null http://127.0.0.1:8080/")
            .map(|out| !out.status.success())
            .unwrap_or(true)
        {
            ensure!(Instant::now() < deadline, "the API stand-in never listened");
            sleep(Duration::from_millis(200));
        }
        Ok(Some(fixture))
    }

    /// `script` under `sh -c`, as the unprivileged account, in its work dir.
    fn sh(&self, script: &str) -> Result<Output> {
        podman(&[
            "exec",
            "-u",
            "dev",
            "-w",
            "/home/dev/work",
            &self.container,
            "sh",
            "-c",
            script,
        ])
    }

    /// `sh`, failing the test with what the script said when it fails.
    fn ok(&self, script: &str) -> Result<String> {
        let out = self.sh(script)?;
        ensure!(
            out.status.success(),
            "`{script}` failed ({}): {}{}",
            out.status,
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        Ok(String::from_utf8(out.stdout)?)
    }

    fn root(&self, script: &str) -> Result<()> {
        let out = podman(&["exec", &self.container, "sh", "-c", script])?;
        ensure!(out.status.success(), "`{script}` failed as root");
        Ok(())
    }

    /// Writes `text` to `path` as the unprivileged account, through stdin, so
    /// no shell quoting touches it.
    fn put(&self, path: &str, text: &str) -> Result<()> {
        let mut child = Command::new("podman")
            .args(["exec", "-i", "-u", "dev", &self.container, "sh", "-c"])
            .arg(format!(
                "mkdir -p \"$(dirname '{path}')\" && cat > '{path}'"
            ))
            .stdin(Stdio::piped())
            .spawn()?;
        child
            .stdin
            .take()
            .context("no stdin")?
            .write_all(text.as_bytes())?;
        ensure!(child.wait()?.success(), "writing {path} failed");
        Ok(())
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = podman(&["rm", "-f", "-t", "0", &self.container]);
    }
}

fn podman(args: &[&str]) -> Result<Output> {
    Command::new("podman")
        .args(args)
        .output()
        .context("spawning podman")
}

fn ensure_image() -> Result<()> {
    if podman(&["image", "exists", IMAGE])?.status.success() {
        return Ok(());
    }
    let context = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixture");
    let mut failures = Vec::new();
    for attempt in 1..=BUILD_ATTEMPTS {
        let out = Command::new("podman")
            .args(["build", "-t", IMAGE, "."])
            .current_dir(&context)
            .output()
            .context("spawning podman build")?;
        if out.status.success() {
            return Ok(());
        }
        failures.push(format!(
            "attempt {attempt}: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
        sleep(Duration::from_secs(2));
    }
    bail!("building {IMAGE} failed:\n{}", failures.join("\n"))
}

/// One JSON line holding all three secrets and the word the resume must keep.
fn transcript_line() -> String {
    format!(
        "{{\"type\":\"message\",\"text\":\"PINEAPPLE {GHP} API_TOKEN={API_TOKEN}\\nDATABASE_PASSWORD={DB_PASSWORD}\"}}\n"
    )
}

const LIVE_HASHES: &str = "find .claude/projects .codex .gemini .grok -type f -print0 \
     | sort -z | xargs -0 sha256sum";

/// Every line of every `.jsonl` staging file, and every whole `.json` one,
/// parses.
const JSON_CHECK: &str = r#"python3 - <<'PY'
import json, pathlib
for p in pathlib.Path("/home/dev/.local/share/yantra/history").rglob("*"):
    if p.suffix == ".jsonl":
        for n, line in enumerate(p.read_text().splitlines(), 1):
            json.loads(line)
    elif p.suffix == ".json":
        json.loads(p.read_text())
PY"#;

#[test]
fn a_redacted_transcript_is_staged_for_every_harness_and_still_resumes() -> Result<()> {
    let Some(machine) = Fixture::start()? else {
        return Ok(());
    };

    // a. A real transcript, from a real Claude Code.
    machine.ok(&format!(
        "{CLAUDE_ENV} claude -p 'remember PINEAPPLE. {GHP} API_TOKEN={API_TOKEN} \
         DATABASE_PASSWORD={DB_PASSWORD}' </dev/null"
    ))?;
    let live = machine.ok("cd ~/.claude/projects && find . -name '*.jsonl' | sed 's|^./||'")?;
    let claude_rel = match live.lines().collect::<Vec<_>>().as_slice() {
        [one] => (*one).to_owned(),
        other => bail!("expected one Claude transcript, found {other:?}"),
    };
    let session = Path::new(&claude_rel)
        .file_stem()
        .and_then(|s| s.to_str())
        .context("no session id")?
        .to_owned();
    ensure!(
        machine
            .ok(&format!("cat ~/.claude/projects/{claude_rel}"))?
            .contains(DB_PASSWORD),
        "the live transcript does not hold the secret, so nothing below tests redaction"
    );

    // b. The other harnesses' shapes.
    let others = [
        (
            ".codex/sessions/2026/10/06/rollout-a.jsonl",
            "codex/2026/10/06/rollout-a.jsonl",
        ),
        (
            ".codex/sessions/2026/10/06/rollout-b.jsonl",
            "codex/2026/10/06/rollout-b.jsonl",
        ),
        (
            ".gemini/tmp/abc123/chats/session-1.jsonl",
            "gemini/abc123/chats/session-1.jsonl",
        ),
        (".grok/sessions/s1.jsonl", "grok/s1.jsonl"),
    ];
    for (path, _) in others {
        machine.put(&format!("/home/dev/{path}"), &transcript_line())?;
    }
    machine.put(
        "/home/dev/.grok/sessions/s2.json",
        &format!("{{\n  \"messages\": [\n    \"API_KEY: {API_TOKEN}\"\n  ]\n}}\n"),
    )?;
    let before = machine.ok(&format!("cd && {LIVE_HASHES}"))?;

    // c. One pass.
    let summary = machine.ok("yantra history stage")?;
    ensure!(summary.contains("failed:     0"), "{summary}");
    let mut staged = vec![format!("claude/{claude_rel}"), "grok/s2.json".to_owned()];
    staged.extend(others.iter().map(|(_, s)| (*s).to_owned()));
    for rel in &staged {
        machine.ok(&format!("test -f {STAGING}/{rel}"))?;
    }
    let leaked = machine.sh(&format!(
        "grep -rlF -e {GHP} -e {API_TOKEN} -e {DB_PASSWORD} {STAGING}"
    ))?;
    ensure!(
        leaked.status.code() == Some(1),
        "a secret survived in: {}",
        String::from_utf8_lossy(&leaked.stdout)
    );
    machine.ok(JSON_CHECK)?;
    ensure!(
        machine.ok(&format!("cd && {LIVE_HASHES}"))? == before,
        "a live transcript changed"
    );

    // d. The staged copy resumes, alone, in a fresh HOME.
    machine.ok(&format!(
        "mkdir -p ~/fresh/.claude/projects/\"$(dirname -- '{claude_rel}')\" && \
         cp ~/.claude.json ~/fresh/ && \
         cp {STAGING}/claude/{claude_rel} ~/fresh/.claude/projects/{claude_rel} && \
         : > {API_LOG}"
    ))?;
    machine.ok(&format!(
        "{CLAUDE_ENV} HOME=/home/dev/fresh claude -p --resume {session} 'repeat the word' </dev/null"
    ))?;
    let sent = machine.ok(&format!("cat {API_LOG}"))?;
    ensure!(
        sent.contains("PINEAPPLE"),
        "the resume lost the history: {sent}"
    );
    ensure!(
        sent.contains("[REDACTED]"),
        "the resume sent no redacted text"
    );
    for secret in [GHP, API_TOKEN, DB_PASSWORD] {
        ensure!(!sent.contains(secret), "the resume sent {secret}");
    }

    // e. A live file goes, and its staging copy goes with it.
    machine.ok("rm ~/.codex/sessions/2026/10/06/rollout-b.jsonl")?;
    let summary = machine.ok("yantra history stage")?;
    ensure!(summary.contains("removed:    1"), "{summary}");
    machine.ok(&format!(
        "test ! -e {STAGING}/codex/2026/10/06/rollout-b.jsonl"
    ))?;
    machine.ok(&format!(
        "test -f {STAGING}/codex/2026/10/06/rollout-a.jsonl"
    ))?;

    // f. With no gitleaks, nothing new is staged and the verb says so.
    machine.put("/home/dev/.codex/sessions/new.jsonl", &transcript_line())?;
    let listing = format!("find {STAGING} -type f | sort");
    let staged_before = machine.ok(&listing)?;
    let blind = machine.sh("PATH=/usr/bin:/bin /usr/local/bin/yantra history stage")?;
    ensure!(
        blind.status.code() == Some(1),
        "expected exit 1 without gitleaks, got {}",
        blind.status
    );
    ensure!(String::from_utf8_lossy(&blind.stderr).contains("gitleaks"));
    ensure!(
        machine.ok(&listing)? == staged_before,
        "a file was staged with no scanner"
    );
    Ok(())
}
