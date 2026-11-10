//! Y-356 against a real `claude` in the podman fixture, per §B3: a chat turn
//! streams, resumes, asks before a tool and stops when it is cancelled, and
//! (Y-424) reads an image pasted into the chat, (Y-565) writes nothing in
//! plan mode, and (Y-658) keeps a background task alive after its turn.
//!
//! It logs in with the owner's own credentials, copied in read-only
//! (docs/development.md#testing). Without them it skips, and
//! `YANTRA_REQUIRE_CLAUDE=1` turns that skip into a failure.

#![allow(clippy::expect_used)]

mod common;

use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use common::{SshFixture, USER};
use yantra_core::chat::{
    Decision, Event, Interaction, PermissionMode, StreamKind, TurnCompleted, TurnState,
};
use yantra_core::claude::{Events, Prompt, Session};
use yantra_core::image::Images;
use yantra_core::keep::Keeper;
use yantra_core::ssh::{Machine, Ssh};
use yantra_core::thread::{self, Place};
use yantra_core::workspace::Workspace;

const REPO: &str = "/home/yantra/repo";
/// A turn on a cold container loads claude's 240 MB binary first.
const PATIENCE: Duration = Duration::from_secs(180);

/// The owner's login, or `None` and a skip that names why.
fn credentials() -> Result<Option<PathBuf>> {
    let path = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(".claude/.credentials.json");
    let why = if std::env::var_os("CI").is_some() {
        "CI has no claude login"
    } else if !path.is_file() {
        "there is no ~/.claude/.credentials.json to log in with"
    } else {
        return Ok(Some(path));
    };
    if std::env::var_os("YANTRA_REQUIRE_CLAUDE").is_some() {
        bail!("YANTRA_REQUIRE_CLAUDE is set, but {why}");
    }
    eprintln!("SKIPPED: {why}, so the real claude cannot run. See docs/development.md#testing.");
    Ok(None)
}

/// Short on purpose: `%C` adds 40 characters and the socket path budget is 90.
fn state_dir(label: &str) -> Result<PathBuf> {
    let dir = PathBuf::from("/tmp").join(format!("yc-{label}"));
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Every event of one turn, answering each permission request with `answer`.
async fn run(ssh: &Ssh, place: &Place, text: &str, answer: Option<Decision>) -> Result<Vec<Event>> {
    run_in(
        ssh,
        place,
        text,
        answer,
        PermissionMode::Supervised,
        Interaction::Build,
    )
    .await
}

async fn run_in(
    ssh: &Ssh,
    place: &Place,
    text: &str,
    answer: Option<Decision>,
    mode: PermissionMode,
    interaction: Interaction,
) -> Result<Vec<Event>> {
    let (turn, mut events) = Session::start(
        ssh,
        place,
        &Prompt {
            text,
            mode,
            interaction,
            model: None,
            effort: None,
        },
    )?;
    let mut seen = Vec::new();
    tokio::time::timeout(PATIENCE, async {
        while let Some(next) = events.recv().await {
            if let (Event::RequestOpened(opened), Some(decision)) = (&next.event, answer) {
                turn.answer(&opened.request_id, decision, None)?;
            }
            let done = matches!(next.event, Event::TurnCompleted(_));
            seen.push(next.event);
            if done {
                return Ok::<_, anyhow::Error>(());
            }
        }
        bail!("the events ended before turn.completed: {seen:?}")
    })
    .await
    .with_context(|| format!("a turn took longer than {PATIENCE:?}"))??;
    turn.close();
    Ok(seen)
}

fn text(seen: &[Event]) -> String {
    seen.iter()
        .filter_map(|event| match event {
            Event::ContentDelta(delta) if delta.stream_kind == StreamKind::AssistantText => {
                Some(delta.delta.as_str())
            }
            _ => None,
        })
        .collect()
}

fn completed(seen: &[Event]) -> Option<&TurnCompleted> {
    match seen.last() {
        Some(Event::TurnCompleted(done)) => Some(done),
        _ => None,
    }
}

async fn next_delta(events: &mut Events) -> Result<()> {
    tokio::time::timeout(PATIENCE, async {
        while let Some(next) = events.recv().await {
            if matches!(next.event, Event::ContentDelta(_)) {
                return Ok(());
            }
            if matches!(next.event, Event::TurnCompleted(_)) {
                bail!("the turn ended before it streamed: {:?}", next.event);
            }
        }
        bail!("the events ended")
    })
    .await
    .context("no delta arrived")?
}

/// A container signed in to claude, with a repository and one thread in it.
async fn signed_in(label: &str) -> Result<Option<(SshFixture, Ssh, Place)>> {
    let Some(login) = credentials()? else {
        return Ok(None);
    };
    let Some(fixture) = SshFixture::start()? else {
        return Ok(None);
    };
    fixture.arrange_as_root(&format!(
        "install -d -o {USER} -g {USER} -m 700 /home/{USER}/.claude"
    ))?;
    fixture.copy_in(&login, &format!("/home/{USER}/.claude/.credentials.json"))?;
    // The cheapest model, set where only this container reads it.
    fixture.arrange_as_root(&format!(
        "cd /home/{USER}/.claude && chown {USER}:{USER} .credentials.json \
         && chmod 400 .credentials.json \
         && printf '{{\"model\":\"haiku\"}}' > settings.json && chown {USER}:{USER} settings.json"
    ))?;
    // Where the vendor's installer links it; the image keeps it off PATH.
    fixture.run("mkdir -p ~/.local/bin && ln -s /opt/claude/claude ~/.local/bin/claude")?;
    fixture.run(&format!(
        "mkdir -p {REPO} && cd {REPO} && git init -q && echo one > README \
         && git add README && git -c user.name=t -c user.email=t@example.com commit -qm one"
    ))?;
    let ssh = Ssh::new(Machine {
        host: fixture.host().to_owned(),
        user: Some(USER.to_owned()),
        port: Some(fixture.port()),
        identity: Some(fixture.key_path()),
        state_dir: state_dir(label)?,
    })?;
    let workspace = Workspace {
        name: "chatws".to_owned(),
        machine: "fixture".to_owned(),
        repo: REPO.into(),
        startup: None,
    };
    let place = thread::open(&ssh, &workspace).await?;
    Ok(Some((fixture, ssh, place)))
}

#[tokio::test]
async fn a_real_claude_streams_resumes_asks_and_stops_in_the_threads_worktree() -> Result<()> {
    let Some((fixture, ssh, place)) = signed_in("chat").await? else {
        return Ok(());
    };

    // Streams: more than one partial delta before the turn ends.
    let first = run(
        &ssh,
        &place,
        "Write three short sentences about the sea. One of them must contain the word periwinkle.",
        None,
    )
    .await?;
    let deltas = first
        .iter()
        .filter(|event| {
            matches!(event, Event::ContentDelta(delta)
            if delta.stream_kind == StreamKind::AssistantText)
        })
        .count();
    assert!(deltas >= 2, "{deltas} deltas: {first:?}");
    assert_eq!(first.first(), Some(&Event::TurnStarted), "{first:?}");
    assert_eq!(
        completed(&first).map(|done| done.state),
        Some(TurnState::Completed),
        "{first:?}"
    );

    // Resumes: the second process recalls what the first was told.
    let second = run(
        &ssh,
        &place,
        "Which unusual flower word did your sentences contain? Answer with that one word.",
        None,
    )
    .await?;
    assert!(
        text(&second).to_lowercase().contains("periwinkle"),
        "{second:?}"
    );

    // Accept runs the tool in the worktree, and the repository is untouched.
    let accepted = run(
        &ssh,
        &place,
        "Use the Bash tool to run exactly this command: touch accepted.txt",
        Some(Decision::Accept),
    )
    .await?;
    assert!(
        accepted
            .iter()
            .any(|event| matches!(event, Event::RequestOpened(_))),
        "{accepted:?}"
    );
    fixture
        .run(&format!("test -f '{}/accepted.txt'", place.worktree))
        .with_context(|| format!("{accepted:?}"))?;
    fixture.run(&format!("test ! -e {REPO}/accepted.txt"))?;

    // Decline refuses it, and nothing is written anywhere.
    let declined = run(
        &ssh,
        &place,
        "Use the Bash tool to run exactly this command: touch declined.txt. If it is refused, say so and stop.",
        Some(Decision::Decline),
    )
    .await?;
    assert!(
        declined
            .iter()
            .any(|event| matches!(event, Event::RequestResolved(resolved)
                if resolved.decision == Decision::Decline)),
        "{declined:?}"
    );
    fixture.run(&format!(
        "test ! -e '{}/declined.txt' && test ! -e {REPO}/declined.txt",
        place.worktree
    ))?;

    // Cancel stops the turn, and closing stdin leaves no claude on the machine.
    let (turn, mut events) = Session::start(
        &ssh,
        &place,
        &Prompt {
            text: "Count from 1 to 400, one number per line, with no tools.",
            mode: PermissionMode::Supervised,
            interaction: Interaction::Build,
            model: None,
            effort: None,
        },
    )?;
    next_delta(&mut events).await?;
    turn.cancel();
    let mut ended = Vec::new();
    tokio::time::timeout(PATIENCE, async {
        while let Some(next) = events.recv().await {
            let done = matches!(next.event, Event::TurnCompleted(_));
            ended.push(next.event);
            if done {
                break;
            }
        }
    })
    .await
    .context("the cancelled turn never completed")?;
    assert_eq!(
        completed(&ended).map(|done| done.state),
        Some(TurnState::Cancelled),
        "{ended:?}"
    );
    turn.close();
    drop(turn);
    let start = Instant::now();
    loop {
        // The bracket keeps pgrep from finding the shell that runs it.
        let left = fixture.run("pgrep -f '[c]laude -p' || true")?;
        if left.trim().is_empty() {
            break;
        }
        if start.elapsed() > Duration::from_secs(30) {
            bail!("claude is still running after cancel: {left}");
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Ok(())
}

/// Y-424: a pasted image lands over ssh, and Claude reads it. Every request is
/// declined, so a pass proves `--add-dir` let the read go without a prompt.
/// Every session adds the directory, so the turn names none (ADR-0041).
#[tokio::test]
async fn a_real_claude_reads_a_pasted_image() -> Result<()> {
    let Some((_fixture, ssh, place)) = signed_in("img").await? else {
        return Ok(());
    };
    let red = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixture/red.png"
    ))?;
    let mut images = Images::of(&Keeper::of(&place).expect("a chat thread"));
    let path = images.put(&ssh, &red).await?;

    let seen = run(
        &ssh,
        &place,
        &format!("What colour fills the image at {path}? Answer in one word."),
        Some(Decision::Decline),
    )
    .await?;
    assert_eq!(
        completed(&seen).map(|done| done.state),
        Some(TurnState::Completed),
        "{seen:?}"
    );
    assert!(text(&seen).to_lowercase().contains("red"), "{seen:?}");
    images.remove(&ssh).await?;
    Ok(())
}

/// Y-565: a plan turn writes nothing, even in Full access with every request
/// accepted. Claude proposes the plan with `ExitPlanMode`, which the daemon
/// denies without asking.
#[tokio::test]
async fn a_real_claude_in_plan_mode_writes_no_file() -> Result<()> {
    let Some((fixture, ssh, place)) = signed_in("plan").await? else {
        return Ok(());
    };
    let seen = run_in(
        &ssh,
        &place,
        "Create a file named plan-proof.txt that holds the word proof. \
         Use the Bash tool: echo proof > plan-proof.txt",
        Some(Decision::Accept),
        PermissionMode::FullAccess,
        Interaction::Plan,
    )
    .await?;
    assert_eq!(
        completed(&seen).map(|done| done.state),
        Some(TurnState::Completed),
        "{seen:?}"
    );
    // Only an `ExitPlanMode` item starts with output: the plan.
    let plans: Vec<&str> = seen
        .iter()
        .filter_map(|event| match event {
            Event::ItemStarted(item) if item.output.is_some() => Some(item.item_id.as_str()),
            _ => None,
        })
        .collect();
    assert!(
        !seen
            .iter()
            .any(|event| matches!(event, Event::RequestOpened(opened)
            if opened.item_id.as_deref().is_some_and(|id| plans.contains(&id)))),
        "ExitPlanMode reached the person: {seen:?}"
    );
    let status = fixture.run(&format!(
        "cd '{}' && git status --porcelain",
        place.worktree
    ))?;
    assert!(status.trim().is_empty(), "{status}: {seen:?}");
    fixture.run(&format!("test ! -e '{}/plan-proof.txt'", place.worktree))?;
    Ok(())
}

/*
 * The prompt is T3 Code's, at commit 67eebaca:
 * https://github.com/pingdotgg/t3code/blob/67eebaca/apps/server/src/orchestration-v2/testkit/fixtures/claude_background_task_wake/input.ts
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
const BACKGROUND_WAKE: &str = "Live-test a background Bash wake. You must call the Bash tool before replying. \
    Do exactly this, with no extra steps.\n\n\
    1) Call the Bash tool with run_in_background set to true and this exact command:\n   \
    sleep 8 && echo BG_DONE\n\
    2) After that tool call returns, reply with exactly STARTED and stop. \
    Do not poll, read its output, or wait for it.\n\
    3) When its completion is reported later, reply with exactly WAKE_DONE and stop.";

/// Y-658, ADR-0041: the turn that starts a background Bash task ends, the
/// task runs on in the same process, and its end opens a wake turn.
#[tokio::test]
async fn a_real_claude_background_task_outlives_its_turn() -> Result<()> {
    let Some((_fixture, ssh, place)) = signed_in("bg").await? else {
        return Ok(());
    };
    let (session, mut events) = Session::start(
        &ssh,
        &place,
        &Prompt {
            text: BACKGROUND_WAKE,
            mode: PermissionMode::FullAccess,
            interaction: Interaction::Build,
            model: None,
            effort: None,
        },
    )?;
    let mut seen = Vec::new();
    let mut ended = 0;
    tokio::time::timeout(PATIENCE, async {
        while let Some(next) = events.recv().await {
            if let Event::RequestOpened(opened) = &next.event {
                session.answer(&opened.request_id, Decision::Accept, None)?;
            }
            if matches!(next.event, Event::TurnCompleted(_)) {
                ended += 1;
            }
            seen.push(next.event);
            if ended == 2 {
                return Ok::<_, anyhow::Error>(());
            }
        }
        bail!("the events ended before the wake turn: {seen:?}")
    })
    .await
    .with_context(|| format!("no wake turn within {PATIENCE:?}: {seen:?}"))??;
    session.close();

    let rosters: Vec<usize> = seen
        .iter()
        .filter_map(|event| match event {
            Event::BackgroundUpdated { tasks } => Some(tasks.len()),
            _ => None,
        })
        .collect();
    assert_eq!(rosters.first(), Some(&1), "{seen:?}");
    assert_eq!(rosters.last(), Some(&0), "{seen:?}");
    let first_end = seen
        .iter()
        .position(|event| matches!(event, Event::TurnCompleted(_)))
        .context("a first turn.completed")?;
    assert!(
        seen[first_end + 1..].contains(&Event::TurnStarted),
        "a wake turn opens after the first ends: {seen:?}"
    );
    assert!(text(&seen).contains("WAKE_DONE"), "{seen:?}");
    Ok(())
}
