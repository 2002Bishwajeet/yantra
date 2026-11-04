//! Y-433 against a real ACP agent, per §B3: `opencode acp` in the fixture,
//! reached over the same `ssh` that `Agent::start` uses in production. Its model
//! is `tests/fixture/model-stub.py`, which counts slowly, so the turn is still
//! running when the cancel arrives (Y-471).

// `expect` in a test is a deliberate abort with a message.
#![allow(clippy::expect_used)]

mod common;

use std::future::Future;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail, ensure};
use common::{SshFixture, USER};
use yantra_core::acp::{Agent, Harness};
use yantra_core::chat::{ContentDelta, Event, StopReason, StreamKind};
use yantra_core::ssh::{Exec, Machine, Ssh};

/// opencode's first start fetches its plugins.
const PATIENCE: Duration = Duration::from_secs(120);
const CWD: &str = "/home/yantra/acp";
/// `small_model` too, so a title request never reaches opencode's hosted model.
const CONFIG: &str = r#"{"autoupdate":false,"model":"stub/slow","small_model":"stub/slow","provider":{"stub":{"npm":"@ai-sdk/openai-compatible","options":{"baseURL":"http://127.0.0.1:8471/v1","apiKey":"stub"},"models":{"slow":{}}}}}"#;

fn ssh_to(fixture: &SshFixture, state_dir: &std::path::Path) -> Result<Ssh> {
    Ok(Ssh::new(Machine {
        host: fixture.host().to_owned(),
        user: Some(USER.to_owned()),
        port: Some(fixture.port()),
        identity: Some(fixture.key_path()),
        state_dir: state_dir.to_owned(),
    })?)
}

/// Short on purpose: `%C` adds 40 characters and the socket path budget is 90.
/// The pid keeps two runs apart.
fn state_dir(label: &str) -> Result<std::path::PathBuf> {
    let dir = std::path::PathBuf::from("/tmp").join(format!("yx-{label}-{}", std::process::id()));
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

async fn within<T, E>(what: &str, step: impl Future<Output = Result<T, E>>) -> Result<T>
where
    E: std::error::Error + Send + Sync + 'static,
{
    tokio::time::timeout(PATIENCE, step)
        .await
        .with_context(|| format!("{what} took longer than {PATIENCE:?}"))?
        .with_context(|| what.to_owned())
}

/// A process that is gone, or a zombie no one has reaped yet.
fn exited(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat")).map_or(true, |stat| {
        stat.rsplit_once(')')
            .is_some_and(|(_, rest)| rest.trim_start().starts_with('Z'))
    })
}

async fn until(what: &str, limit: Duration, mut done: impl FnMut() -> Result<bool>) -> Result<()> {
    let start = Instant::now();
    while !done()? {
        if start.elapsed() > limit {
            bail!("{what} did not happen within {limit:?}");
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Ok(())
}

#[tokio::test]
async fn a_failed_step_names_itself() {
    let failed = within("session/load", async {
        Err::<(), _>(std::io::Error::other("Internal error"))
    })
    .await
    .expect_err("the step failed");
    assert_eq!(format!("{failed:#}"), "session/load: Internal error");
}

async fn start_model_stub(fixture: &SshFixture) -> Result<()> {
    let stub = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixture/model-stub.py");
    fixture.copy_in(&stub, "/tmp/model-stub.py")?;
    fixture.run("nohup python3 /tmp/model-stub.py >/tmp/stub.log 2>&1 </dev/null &")?;
    until("the model stub answering", Duration::from_secs(10), || {
        Ok(fixture
            .run("wget -q -O- http://127.0.0.1:8471/health")
            .is_ok())
    })
    .await?;
    fixture.run(&format!(
        "mkdir -p ~/.config/opencode && printf '%s' '{CONFIG}' > ~/.config/opencode/opencode.json"
    ))?;
    Ok(())
}

/// The end of opencode's newest log and of the stub's, or why they could not be read.
fn logs(fixture: &SshFixture) -> String {
    fixture
        .run(
            r#"tail -n 200 "$(ls -t ~/.local/share/opencode/log/*.log | head -n 1)" /tmp/stub.log 2>&1; true"#,
        )
        .unwrap_or_else(|error| format!("{error:#}"))
}

#[tokio::test]
async fn opencode_initializes_reloads_and_cancels_over_ssh() -> Result<()> {
    let Some(fixture) = SshFixture::start()? else {
        return Ok(());
    };
    initialize_reload_and_cancel(&fixture)
        .await
        .map_err(|error| {
            error.context(format!(
                "opencode's and the stub's logs:\n{}",
                logs(&fixture)
            ))
        })
}

async fn initialize_reload_and_cancel(fixture: &SshFixture) -> Result<()> {
    let dir = state_dir("acp")?;
    let ssh = ssh_to(fixture, &dir)?;
    let made = ssh
        .exec(&format!("mkdir -p {CWD} && git init -q {CWD}"))
        .await?;
    ensure!(made.success(), "{}", String::from_utf8_lossy(&made.stderr));
    start_model_stub(fixture).await?;

    let (agent, _events) = Agent::start(&ssh, Harness::Opencode)?;
    let capabilities = within("initialize", agent.initialize()).await?;
    ensure!(
        capabilities.load_session,
        "R19 §1: opencode can load a session"
    );
    let session = within("session/new", agent.new_session(CWD)).await?;

    // Dropping the agent ends the local ssh, and the agent sees its stdin close.
    let pid = agent.pid().context("the local ssh has a pid")?;
    drop(agent);
    until("the local ssh exiting", Duration::from_secs(10), || {
        Ok(exited(pid))
    })
    .await?;
    until(
        "opencode exiting on the machine",
        Duration::from_secs(30),
        || Ok(fixture.run("pgrep -x opencode || true")?.trim().is_empty()),
    )
    .await?;

    let (agent, mut events) = Agent::start(&ssh, Harness::Opencode)?;
    within("initialize again", agent.initialize()).await?;
    within("session/load", agent.load_session(&session, CWD)).await?;
    // The replayed history is already here, and is not the turn's.
    while events.try_recv().is_ok() {}

    let turn = agent.prompt(&session, "Count slowly from 1 to 500, one number per line.");
    let cancel = async {
        // Y-625: cancel mid-stream. opencode 1.18.34 answers an earlier cancel with
        // -32603: its usage reads `tokens.cache` of a message that has no `tokens`.
        tokio::time::timeout(PATIENCE, async {
            while let Some(update) = events.recv().await {
                match update.event {
                    Event::ContentDelta(ContentDelta {
                        stream_kind: StreamKind::AssistantText,
                        ..
                    }) => return Ok(()),
                    Event::TurnCompleted(_) => bail!("the turn ended before its first text"),
                    _ => {}
                }
            }
            bail!("the events ended before the turn's first text")
        })
        .await
        .context("the turn's first text took too long")??;
        Ok::<_, anyhow::Error>(agent.cancel(&session)?)
    };
    let (stopped, cancelled) = tokio::join!(within("a cancelled prompt", turn), cancel);
    let stopped = stopped?;
    cancelled?;
    ensure!(
        stopped == StopReason::Cancelled,
        "the cancelled turn stopped as {stopped:?}"
    );

    drop(agent);
    std::fs::remove_dir_all(&dir)?;
    Ok(())
}
