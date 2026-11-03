//! Y-563 against a real sshd, per §B3: the composer's `/` list is Claude's
//! answer to `initialize`, asked in the directory by one bounded script.

#![allow(clippy::expect_used)]

mod common;

use anyhow::Result;
use base64::Engine as _;
use common::{SshFixture, USER};
use yantra_core::chat::Command;
use yantra_core::command::{self, Error};
use yantra_core::ssh::{Exec as _, Machine, Ssh};

const REPO: &str = "/home/yantra/commands";
/// Where Claude Code's installer puts the binary, as in `tests/agent.rs`.
const INSTALLED_AT: &str = "/home/yantra/.local/bin/claude";
const SEEN_CWD: &str = "/tmp/commands-claude-cwd";
const SEEN_STDIN: &str = "/tmp/commands-claude-stdin";

/// Short on purpose: `%C` adds 40 characters and the socket path budget is 90.
fn state_dir(label: &str) -> Result<std::path::PathBuf> {
    let dir = std::path::PathBuf::from("/tmp").join(format!("yc-{label}-{}", std::process::id()));
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Records where it ran and what it read, and answers as `claude -p
/// --input-format stream-json` answers `initialize`.
async fn install_claude(ssh: &Ssh) -> Result<()> {
    let reply = serde_json::json!({"type": "control_response", "response": {
    "subtype": "success", "request_id": "yantra-commands", "response": {"commands": [
        {"name": "review", "description": "Review a pull request", "argumentHint": "<pr>"},
        {"name": "init", "description": "Initialize a new CLAUDE.md file", "argumentHint": ""},
    ]}}});
    let script = format!(
        "#!/bin/sh\n\
         pwd > {SEEN_CWD}\n\
         cat > {SEEN_STDIN}\n\
         cat <<'EOF'\n{reply}\nEOF\n"
    );
    let b64 = base64::engine::general_purpose::STANDARD.encode(script);
    let out = ssh
        .exec(&format!(
            "mkdir -p ~/.local/bin && printf %s '{b64}' | base64 -d > {INSTALLED_AT} \
             && chmod 755 {INSTALLED_AT}"
        ))
        .await?;
    assert!(out.success(), "{}", String::from_utf8_lossy(&out.stderr));
    Ok(())
}

#[tokio::test]
async fn claude_lists_its_commands_in_the_directory() -> Result<()> {
    let Some(fixture) = SshFixture::start()? else {
        return Ok(());
    };
    let ssh = Ssh::new(Machine {
        host: fixture.host().to_owned(),
        user: Some(USER.to_owned()),
        port: Some(fixture.port()),
        identity: Some(fixture.key_path()),
        state_dir: state_dir("cmd")?,
    })?;
    fixture.run(&format!(
        "mkdir -p {REPO} && cd {REPO} && git init -q && echo one > README \
         && git add README && git -c user.name=t -c user.email=t@example.com commit -qm one \
         && mkdir -p /home/yantra/plain"
    ))?;

    assert!(matches!(
        command::commands(&ssh, REPO).await,
        Err(Error::NoClaude { said }) if said.contains("claude was not found")
    ));

    install_claude(&ssh).await?;
    let found = command::commands(&ssh, REPO).await?;
    let command = |name: &str, description: &str, hint: Option<&str>| Command {
        name: name.to_owned(),
        description: description.to_owned(),
        hint: hint.map(str::to_owned),
    };
    assert_eq!(
        found,
        [
            command(
                "compact",
                "Free up context by summarizing the conversation so far",
                None
            ),
            command("init", "Initialize a new CLAUDE.md file", None),
            command("review", "Review a pull request", Some("<pr>")),
        ]
    );
    assert_eq!(fixture.run(&format!("cat {SEEN_CWD}"))?.trim(), REPO);
    let stdin = fixture.run(&format!("cat {SEEN_STDIN}"))?;
    let request: serde_json::Value = serde_json::from_str(stdin.trim())?;
    assert_eq!(request["request"]["subtype"], "initialize");

    assert!(matches!(
        command::commands(&ssh, "/home/yantra/plain").await,
        Err(Error::NotARepo { dir }) if dir == "/home/yantra/plain"
    ));
    Ok(())
}
