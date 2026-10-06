//! Y-356 against a real `claude` in the podman fixture, per §B3: a chat turn
//! streams, resumes, asks before a tool and stops when it is cancelled.
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
use yantra_core::chat::{Decision, Event, StreamKind, TurnCompleted, TurnState};
use yantra_core::claude::{Events, Turn};
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
    let (turn, mut events) = Turn::start(ssh, place, text)?;
    let mut seen = Vec::new();
    tokio::time::timeout(PATIENCE, async {
        while let Some(next) = events.recv().await {
            if let (Event::RequestOpened(opened), Some(decision)) = (&next.event, answer) {
                turn.answer(&opened.request_id, decision)?;
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

#[tokio::test]
async fn a_real_claude_streams_resumes_asks_and_stops_in_the_threads_worktree() -> Result<()> {
    let Some(login) = credentials()? else {
        return Ok(());
    };
    let Some(fixture) = SshFixture::start()? else {
        return Ok(());
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
        state_dir: state_dir("chat")?,
    })?;
    let workspace = Workspace {
        name: "chatws".to_owned(),
        machine: "fixture".to_owned(),
        repo: REPO.into(),
        startup: None,
    };
    let place = thread::open(&ssh, &workspace).await?;

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

    // Cancel stops the turn, and no claude is left on the machine.
    let (turn, mut events) = Turn::start(
        &ssh,
        &place,
        "Count from 1 to 400, one number per line, with no tools.",
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
