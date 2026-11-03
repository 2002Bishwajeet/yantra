//! Y-562 against a real sshd and real git, per §B3: the composer's `@` and `$`
//! lists come from git's file list and from each skill's front matter.

#![allow(clippy::expect_used)]

mod common;

use anyhow::Result;
use common::{SshFixture, USER};
use yantra_core::mention::{self, Error, Scope};
use yantra_core::ssh::{Machine, Ssh};

const REPO: &str = "/home/yantra/mentions";

/// Short on purpose: `%C` adds 40 characters and the socket path budget is 90.
fn state_dir(label: &str) -> Result<std::path::PathBuf> {
    let dir = std::path::PathBuf::from("/tmp").join(format!("ym-{label}-{}", std::process::id()));
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[tokio::test]
async fn files_come_from_git_and_skills_from_both_roots() -> Result<()> {
    let Some(fixture) = SshFixture::start()? else {
        return Ok(());
    };
    let ssh = Ssh::new(Machine {
        host: fixture.host().to_owned(),
        user: Some(USER.to_owned()),
        port: Some(fixture.port()),
        identity: Some(fixture.key_path()),
        state_dir: state_dir("men")?,
    })?;
    fixture.run(&format!(
        "mkdir -p {REPO}/src && cd {REPO} && git init -q \
         && echo one > src/tracked.rs && echo target > .gitignore \
         && git add . && git -c user.name=t -c user.email=t@example.com commit -qm one \
         && echo two > untracked.md && mkdir target && echo three > target/ignored.o \
         && mkdir -p ~/.claude/skills/review .claude/skills/deploy-staging \
         && printf -- '---\\nname: code-review\\ndescription: Reviews a diff.\\n---\\nBody\\n' \
            > ~/.claude/skills/review/SKILL.md \
         && printf -- '---\\ndescription: Ships to staging.\\n---\\n' \
            > .claude/skills/deploy-staging/SKILL.md \
         && mkdir -p /home/yantra/plain"
    ))?;

    let found = mention::mentions(&ssh, REPO, None).await?;
    let mut files = found.files.clone();
    files.sort();
    assert_eq!(
        files,
        [
            ".claude/skills/deploy-staging/SKILL.md",
            ".gitignore",
            "src/tracked.rs",
            "untracked.md"
        ]
    );
    assert!(!found.truncated);
    let skills: Vec<(&str, &str, Scope, &str)> = found
        .skills
        .iter()
        .map(|skill| {
            (
                skill.name.as_str(),
                skill.description.as_str(),
                skill.scope,
                skill.mention.as_str(),
            )
        })
        .collect();
    assert_eq!(
        skills,
        [
            (
                "code-review",
                "Reviews a diff.",
                Scope::User,
                "$code-review"
            ),
            (
                "deploy-staging",
                "Ships to staging.",
                Scope::Project,
                "$deploy-staging"
            ),
        ]
    );

    let grok = mention::mentions(&ssh, REPO, Some(yantra_core::acp::Harness::Grok)).await?;
    assert!(grok.skills.is_empty());
    assert_eq!(grok.files.len(), 4);

    assert!(matches!(
        mention::mentions(&ssh, "/home/yantra/plain", None).await,
        Err(Error::NotARepo { dir }) if dir == "/home/yantra/plain"
    ));
    Ok(())
}
