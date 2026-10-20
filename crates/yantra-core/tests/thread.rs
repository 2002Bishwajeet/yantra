//! Y-359 against a real sshd, a real tmux and real git, per §B3: a chat thread
//! works in its own worktree while the workspace's TUI runs in the repository.

#![allow(clippy::expect_used)]

mod common;

use anyhow::Result;
use common::{SshFixture, USER};
use yantra_core::acp::Harness;
use yantra_core::keep::{self, Keeper, Limits, Started};
use yantra_core::ssh::{Exec, Machine, Os, Ssh};
use yantra_core::tmux::Tmux;
use yantra_core::workspace::Workspace;
use yantra_core::{github, logs, thread, tokens, up};

const REPO: &str = "/home/yantra/repo";
const NAME: &str = "chatws";
const SESSION: &str = "11111111-1111-4111-8111-111111111111";

/// Short on purpose: `%C` adds 40 characters and the socket path budget is 90.
fn state_dir(label: &str) -> Result<std::path::PathBuf> {
    let dir = std::path::PathBuf::from("/tmp").join(format!("yt-{label}"));
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn slug(path: &str) -> String {
    path.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// One typed prompt and one response that spent `input` input tokens.
fn transcript(said: &str, input: u64) -> String {
    format!(
        "{{\"type\":\"user\",\"timestamp\":\"2026-10-06T10:00:00Z\",\
         \"message\":{{\"role\":\"user\",\"content\":\"{said}\"}}}}\n\
         {{\"type\":\"assistant\",\"requestId\":\"r1\",\"timestamp\":\"2026-10-06T10:00:01Z\",\
         \"message\":{{\"model\":\"claude-opus-5\",\"role\":\"assistant\",\
         \"content\":[{{\"type\":\"text\",\"text\":\"ok\"}}],\
         \"usage\":{{\"input_tokens\":{input},\"output_tokens\":1,\
         \"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":0}}}}}}\n"
    )
}

/// The same session id under both directories, so only the directory can
/// decide which file is read.
async fn seed(ssh: &Ssh, dir: &str, said: &str, input: u64) -> Result<()> {
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(transcript(said, input));
    let out = ssh
        .exec(&format!(
            "mkdir -p ~/.claude/projects/{slug} && printf %s '{b64}' | base64 -d \
             > ~/.claude/projects/{slug}/{SESSION}.jsonl",
            slug = slug(dir)
        ))
        .await?;
    assert!(out.success(), "{}", String::from_utf8_lossy(&out.stderr));
    Ok(())
}

#[tokio::test]
async fn a_thread_edits_its_own_worktree_while_the_tui_keeps_the_repo() -> Result<()> {
    let Some(fixture) = SshFixture::start()? else {
        return Ok(());
    };
    let dir = state_dir("thr")?;
    let ssh = Ssh::new(Machine {
        host: fixture.host().to_owned(),
        user: Some(USER.to_owned()),
        port: Some(fixture.port()),
        identity: Some(fixture.key_path()),
        state_dir: dir.clone(),
    })?;
    let tmux = Tmux::resolve(&ssh).await?;
    fixture.run(&format!(
        "mkdir -p {REPO} && cd {REPO} && git init -q && echo one > README \
         && git add README && git -c user.name=t -c user.email=t@example.com \
         commit -qm one"
    ))?;
    let head = fixture.run(&format!("git -C {REPO} rev-parse HEAD"))?;
    let workspace = Workspace {
        name: NAME.to_owned(),
        machine: "fixture".to_owned(),
        repo: REPO.into(),
        startup: None,
    };

    // The pane stands in for the live TUI.
    let opened = up::open(&ssh, &tmux, &workspace, None, Os::Other).await?;
    let pane = opened.session().pane_id.clone();
    let tui =
        format!("tmux display-message -p -t '{pane}' '#{{pane_dead}} #{{pane_current_path}}'");
    assert_eq!(fixture.run(&tui)?.trim(), format!("0 {REPO}"));

    let one = thread::open(&ssh, &workspace).await?;
    let two = thread::open(&ssh, &workspace).await?;
    assert_ne!(one.worktree, two.worktree);
    for place in [&one, &two] {
        assert_eq!(place.repo, REPO);
        assert_ne!(place.worktree, REPO);
        assert!(
            !place.worktree.starts_with(&format!("{REPO}/")),
            "{place:?}"
        );
        assert!(
            place.branch.starts_with(&format!("yantra/chat/{NAME}/")),
            "{place:?}"
        );
        assert_eq!(
            place.worktree,
            format!("/home/{USER}/.yantra/worktrees/{}", place.id)
        );
        assert_eq!(place.base, head.trim());
    }

    // The chat turn: one commit, and one file it has not committed yet.
    fixture.run(&format!(
        "cd {} && echo hi > chat.txt && git add chat.txt \
         && git -c user.name=t -c user.email=t@example.com commit -qm chat \
         && echo draft > draft.txt",
        one.worktree
    ))?;
    assert_eq!(
        fixture
            .run(&format!("git -C {REPO} status --porcelain"))?
            .trim(),
        ""
    );
    assert_eq!(
        fixture
            .run(&format!("test -e {REPO}/chat.txt && echo there || true"))?
            .trim(),
        ""
    );
    assert_eq!(fixture.run(&tui)?.trim(), format!("0 {REPO}"));
    assert_eq!(fixture.run(&format!("git -C {REPO} rev-parse HEAD"))?, head);

    seed(&ssh, &one.worktree, "from the thread", 7).await?;
    seed(&ssh, REPO, "from the repo", 100).await?;
    let said = |transcript: &logs::Transcript| {
        transcript
            .entries
            .first()
            .map(|entry| entry.text.clone())
            .unwrap_or_default()
    };
    let read = thread::logs(&ssh, &one, Some(SESSION), 50, 0).await?;
    assert_eq!(said(&read), "from the thread", "{read:?}");
    let spend = thread::spent(&ssh, &one, Some(SESSION), None).await?;
    assert_eq!(spend.total().input, 7, "{spend:?}");
    let read = logs::read(&ssh, REPO, Some(SESSION), 50, 0).await?;
    assert_eq!(said(&read), "from the repo", "{read:?}");
    let spend = tokens::spent(&ssh, REPO, Some(SESSION), None).await?;
    assert_eq!(spend.total().input, 100, "{spend:?}");

    let status = thread::status(&ssh, &one).await?;
    for written in ["chat.txt", "draft.txt"] {
        assert!(
            status.summary.changed.iter().any(|path| path == written),
            "{written}: {status:?}"
        );
    }

    // The session ends. Nothing is deleted until the owner removes the thread.
    let ended = one.clone();
    drop(one);
    let mut listed = thread::list(&ssh, &workspace).await?;
    listed.sort_by(|a, b| a.id.cmp(&b.id));
    let mut both = vec![ended.clone(), two.clone()];
    both.sort_by(|a, b| a.id.cmp(&b.id));
    assert_eq!(listed, both);
    fixture.run(&format!(
        "test -f {wt}/draft.txt && test -f {wt}/chat.txt \
         && git -C {REPO} rev-parse --verify -q {branch}",
        wt = ended.worktree,
        branch = ended.branch
    ))?;

    thread::remove(&ssh, Some(&tmux), &ended).await?;
    assert_eq!(
        fixture
            .run(&format!("test -e {} && echo there || true", ended.worktree))?
            .trim(),
        ""
    );
    let branches = fixture.run(&format!("git -C {REPO} branch --list 'yantra/*'"))?;
    assert!(!branches.contains(&ended.branch), "{branches}");
    assert!(branches.contains(&two.branch), "{branches}");
    fixture.run(&format!("test -f {}/README", two.worktree))?;
    assert_eq!(
        thread::list(&ssh, &workspace).await?,
        std::slice::from_ref(&two)
    );

    thread::remove(&ssh, Some(&tmux), &two).await?;
    tmux.kill(&ssh, NAME).await?;
    std::fs::remove_dir_all(&dir)?;
    Ok(())
}

/// Y-434: an ACP thread's harness and session live in git config under its
/// branch, and removing the thread forgets them.
#[tokio::test]
async fn a_thread_remembers_its_harness_and_acp_session() -> Result<()> {
    let Some(fixture) = SshFixture::start()? else {
        return Ok(());
    };
    let dir = state_dir("thk")?;
    let ssh = Ssh::new(Machine {
        host: fixture.host().to_owned(),
        user: Some(USER.to_owned()),
        port: Some(fixture.port()),
        identity: Some(fixture.key_path()),
        state_dir: dir.clone(),
    })?;
    let repo = "/home/yantra/keeps";
    fixture.run(&format!(
        "mkdir -p {repo} && cd {repo} && git init -q && echo one > README \
         && git add README && git -c user.name=t -c user.email=t@example.com \
         commit -qm one"
    ))?;
    let workspace = Workspace {
        name: "keeps".to_owned(),
        machine: "fixture".to_owned(),
        repo: repo.into(),
        startup: None,
    };

    let place = thread::open(&ssh, &workspace).await?;
    assert_eq!(thread::recall(&ssh, &place).await?, None, "a Claude thread");

    // A quote and a `$` in the session reach git as they are.
    let session = "ses_'$(id)'";
    thread::remember(&ssh, &place, Harness::Opencode, session).await?;
    assert_eq!(
        thread::recall(&ssh, &place).await?,
        Some((Harness::Opencode, session.to_owned()))
    );

    thread::remove(&ssh, Some(&Tmux::resolve(&ssh).await?), &place).await?;
    let left = fixture.run(&format!(
        "git -C {repo} config --get-regexp '^branch\\.' || true"
    ))?;
    assert_eq!(left.trim(), "", "branch -D drops the section");
    std::fs::remove_dir_all(&dir)?;
    Ok(())
}

/// Y-488: a thread opened from an issue keeps it in git config, `listed`
/// reads it back with the upstream git keeps, and removing the thread forgets
/// both.
#[tokio::test]
async fn a_thread_from_an_issue_lists_its_issue_and_its_upstream() -> Result<()> {
    let Some(fixture) = SshFixture::start()? else {
        return Ok(());
    };
    let dir = state_dir("thi")?;
    let ssh = Ssh::new(Machine {
        host: fixture.host().to_owned(),
        user: Some(USER.to_owned()),
        port: Some(fixture.port()),
        identity: Some(fixture.key_path()),
        state_dir: dir.clone(),
    })?;
    let repo = "/home/yantra/issues";
    fixture.run(&format!(
        "mkdir -p {repo} && cd {repo} && git init -q && echo one > README \
         && git add README && git -c user.name=t -c user.email=t@example.com \
         commit -qm one"
    ))?;
    let workspace = Workspace {
        name: "issues".to_owned(),
        machine: "fixture".to_owned(),
        repo: repo.into(),
        startup: None,
    };
    let issue: github::IssueRef = "o/r#7".parse()?;

    let from_issue = thread::open_for_issue(&ssh, &workspace, &issue).await?;
    let plain = thread::open(&ssh, &workspace).await?;
    let issue_of = |listed: &[thread::Listed], place: &thread::Place| {
        listed
            .iter()
            .find(|l| &l.place == place)
            .map(|l| (l.issue.clone(), l.upstream.clone()))
    };
    let listed = thread::listed(&ssh, &workspace).await?;
    assert_eq!(listed.len(), 2, "{listed:?}");
    assert_eq!(
        issue_of(&listed, &from_issue),
        Some((Some("o/r#7".to_owned()), None))
    );
    assert_eq!(issue_of(&listed, &plain), Some((None, None)));

    // What `git push -u origin HEAD:fix-7` would leave behind.
    fixture.run(&format!(
        "git -C {repo} remote add origin git@github.com:o/r.git \
         && git -C {repo} config branch.{b}.remote origin \
         && git -C {repo} config branch.{b}.merge refs/heads/fix-7",
        b = plain.branch
    ))?;
    let listed = thread::listed(&ssh, &workspace).await?;
    assert_eq!(
        issue_of(&listed, &plain),
        Some((
            None,
            Some(("git@github.com:o/r.git".to_owned(), "fix-7".to_owned()))
        ))
    );

    let tmux = Tmux::resolve(&ssh).await?;
    thread::remove(&ssh, Some(&tmux), &from_issue).await?;
    thread::remove(&ssh, Some(&tmux), &plain).await?;
    let left = fixture.run(&format!(
        "git -C {repo} config --get-regexp '^branch\\.' || true"
    ))?;
    assert_eq!(
        left.trim(),
        "",
        "branch -D drops the issue and the upstream"
    );
    std::fs::remove_dir_all(&dir)?;
    Ok(())
}

/// Y-542: removing a thread kills its keeper's session first, so no agent
/// writes the journals while they go, and neither is left after.
#[tokio::test]
async fn removing_a_thread_ends_its_keeper_and_its_journals() -> Result<()> {
    let Some(fixture) = SshFixture::start()? else {
        return Ok(());
    };
    let dir = state_dir("thr-rm")?;
    let ssh = Ssh::new(Machine {
        host: fixture.host().to_owned(),
        user: Some(USER.to_owned()),
        port: Some(fixture.port()),
        identity: Some(fixture.key_path()),
        state_dir: dir.clone(),
    })?;
    let tmux = Tmux::resolve(&ssh).await?;
    let repo = "/home/yantra/removes";
    fixture.run(&format!(
        "mkdir -p {repo} && cd {repo} && git init -q && echo one > README \
         && git add README && git -c user.name=t -c user.email=t@example.com \
         commit -qm one"
    ))?;
    let workspace = Workspace {
        name: "removes".to_owned(),
        machine: "fixture".to_owned(),
        repo: repo.into(),
        startup: None,
    };
    let place = thread::open(&ssh, &workspace).await?;
    let keeper = Keeper::of(&place).expect("a chat thread has a keeper");
    let started = keep::start(
        &ssh,
        &tmux,
        &keeper,
        "exec sleep 600",
        &keep::run_id()?,
        Limits::default(),
    )
    .await?;
    assert!(matches!(started, Started::Running { .. }), "{started:?}");

    thread::remove(&ssh, Some(&tmux), &place).await?;
    assert!(
        keep::pane(&ssh, &tmux, &keeper).await?.is_none(),
        "the keeper's session is gone"
    );
    assert_eq!(
        fixture
            .run(&format!(
                "test -e ~/.yantra/keep/removes/{} && echo there || true",
                keeper.thread()
            ))?
            .trim(),
        "",
        "the journals are gone"
    );
    assert!(
        fixture
            .run("pgrep -f 'sleep 60[0]' || true")?
            .trim()
            .is_empty(),
        "no agent outlives its thread"
    );
    std::fs::remove_dir_all(&dir)?;
    Ok(())
}
