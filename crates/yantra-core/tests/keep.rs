//! Y-447 against a real sshd and tmux in the container, per §B3: the keeper
//! (ADR-0035) holds an agent through a killed `ssh` and a killed
//! ControlMaster, its reader ends with its pane (I-27), and both limits fire
//! on busybox's `tail`, `wc` and `sh`.

// `expect` in a test is a deliberate abort with a message.
#![allow(clippy::expect_used)]

mod common;

use std::process::Command;
use std::time::{Duration, Instant};

use anyhow::{Result, bail, ensure};
use common::{SshFixture, USER};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use yantra_core::keep::{self, File, Keeper, Limits, Started};
use yantra_core::ssh::{Machine, Ssh};
use yantra_core::tmux::Tmux;

/// Prints `{"n":1}`, `{"n":2}`… five times a second, and is named by its `$0`.
/// Each `pgrep` pattern below brackets a letter, so it never finds the shell
/// that runs it.
const COUNTER: &str = "exec sh -c 'n=0; while :; do n=$((n+1)); echo \"{\\\"n\\\":$n}\"; \
                       sleep 0.2; done' yantra-test-agent";

struct Lab {
    fixture: SshFixture,
    ssh: Ssh,
    tmux: Tmux,
    dir: std::path::PathBuf,
}

impl Lab {
    async fn start(label: &str) -> Result<Option<Self>> {
        let Some(fixture) = SshFixture::start()? else {
            return Ok(None);
        };
        let dir = std::path::PathBuf::from("/tmp").join(format!("yk-{label}"));
        if dir.exists() {
            std::fs::remove_dir_all(&dir)?;
        }
        std::fs::create_dir_all(&dir)?;
        let ssh = Ssh::new(Machine {
            host: fixture.host().to_owned(),
            user: Some(USER.to_owned()),
            port: Some(fixture.port()),
            identity: Some(fixture.key_path()),
            state_dir: dir.clone(),
        })?;
        let tmux = Tmux::resolve(&ssh).await?;
        Ok(Some(Self {
            fixture,
            ssh,
            tmux,
            dir,
        }))
    }

    async fn start_keeper(&self, keeper: &Keeper, agent: &str, limits: Limits) -> Result<String> {
        let run = keep::run_id()?;
        match keep::start(&self.ssh, &self.tmux, keeper, agent, &run, limits).await? {
            Started::Running { pane } => Ok(pane),
            Started::Busy => bail!("the keeper's session was already there"),
        }
    }

    /// Kills every local `ssh` of this lab: the reader's and the ControlMaster.
    fn kill_local_ssh(&self) {
        let _ = Command::new("pkill")
            .args(["-f", &self.dir.to_string_lossy()])
            .status();
    }

    fn out_size(&self, keeper: &Keeper) -> Result<u64> {
        let size = self.fixture.run(&format!(
            "wc -c < ~/.yantra/keep/{}/{}/out",
            keeper.workspace(),
            keeper.thread()
        ))?;
        Ok(size.trim().parse()?)
    }

    async fn until_dead(&self, keeper: &Keeper) -> Result<yantra_core::tmux::Pane> {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(pane) = keep::pane(&self.ssh, &self.tmux, keeper).await?
                && pane.dead
            {
                return Ok(pane);
            }
            ensure!(
                Instant::now() < deadline,
                "the keeper's pane died within 30 s"
            );
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
}

impl Drop for Lab {
    fn drop(&mut self) {
        self.kill_local_ssh();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn counted(line: &str) -> Result<u64> {
    let value: serde_json::Value = serde_json::from_str(line.trim())?;
    value["n"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("no counter in {line}"))
}

/// ADR-0035's done line, steps 2 and 7 at the keeper: the agent outlives its
/// `ssh` and the ControlMaster, the reader carries on with no line lost or
/// repeated, and the far reader ends with the pane (I-27).
#[tokio::test]
async fn the_agent_outlives_its_ssh_and_the_reader_carries_on() -> Result<()> {
    let Some(lab) = Lab::start("outlive").await? else {
        return Ok(());
    };
    let keeper = Keeper::new("web", "1a2b3c4d5e6f7a8b");
    let pane = lab
        .start_keeper(&keeper, COUNTER, Limits::default())
        .await?;
    let mode = lab.fixture.run(&format!(
        "stat -c %a ~/.yantra/keep/{}/{}",
        keeper.workspace(),
        keeper.thread()
    ))?;
    ensure!(mode.trim() == "700", "the journal directory is {mode}");

    let agent = lab.fixture.run("pgrep -f yantra-test-agen[t]")?;
    let reader = keep::follow(
        lab.ssh.clone(),
        lab.tmux.clone(),
        keeper.clone(),
        pane.clone(),
        0,
    );
    let mut lines = BufReader::new(reader).lines();
    let mut last = 0;
    for _ in 0..5 {
        let line = tokio::time::timeout(Duration::from_secs(10), lines.next_line())
            .await??
            .expect("a line");
        let n = counted(&line)?;
        ensure!(n == last + 1, "{n} follows {last}");
        last = n;
    }

    lab.kill_local_ssh();
    let before = lab.out_size(&keeper)?;
    tokio::time::sleep(Duration::from_secs(2)).await;
    ensure!(
        lab.out_size(&keeper)? > before,
        "out still grows with no ssh"
    );
    ensure!(
        lab.fixture.run("pgrep -f yantra-test-agen[t]")? == agent,
        "the agent is the one that started"
    );

    // The reader reconnects from the next byte: nothing lost, nothing twice.
    for _ in 0..20 {
        let line = tokio::time::timeout(Duration::from_secs(20), lines.next_line())
            .await??
            .expect("a line");
        let n = counted(&line)?;
        ensure!(n == last + 1, "{n} follows {last} across the reconnect");
        last = n;
    }

    lab.fixture.run("pkill -f yantra-test-agen[t]; true")?;
    let dead = lab.until_dead(&keeper).await?;
    ensure!(
        dead.status.is_some() || dead.signal.is_some(),
        "the dead pane keeps how the keeper ended: {dead:?}"
    );
    let ended = tokio::time::timeout(Duration::from_secs(20), async {
        while let Ok(Some(line)) = lines.next_line().await {
            let n = counted(&line)?;
            ensure!(n == last + 1, "{n} follows {last} in the drain");
            last = n;
        }
        Ok(())
    })
    .await;
    ensure!(
        matches!(ended, Ok(Ok(()))),
        "the reader ended with the pane"
    );
    // The far side of the first reader was orphaned, and still ended (I-27).
    let deadline = Instant::now() + Duration::from_secs(10);
    while lab.fixture.run("pgrep -f 'tail -[c]' || true")?.trim() != "" {
        ensure!(Instant::now() < deadline, "no far tail outlives the pane");
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    ensure!(
        lab.fixture
            .run("pgrep -f 'tail -[n]' || true")?
            .trim()
            .is_empty(),
        "the keeper's own tail went with it"
    );

    keep::kill(&lab.ssh, &lab.tmux, &keeper).await?;
    keep::kill(&lab.ssh, &lab.tmux, &keeper).await?;
    ensure!(keep::pane(&lab.ssh, &lab.tmux, &keeper).await?.is_none());
    Ok(())
}

/// I-1: the session is the thread's lock, so a second start is busy and does
/// not empty the running turn's journals.
#[tokio::test]
async fn a_second_start_is_busy_and_leaves_the_journals() -> Result<()> {
    let Some(lab) = Lab::start("busy").await? else {
        return Ok(());
    };
    let keeper = Keeper::new("web", "2b3c4d5e6f7a8b9c");
    lab.start_keeper(&keeper, COUNTER, Limits::default())
        .await?;
    tokio::time::sleep(Duration::from_secs(1)).await;
    let before = lab.out_size(&keeper)?;
    let again = keep::start(
        &lab.ssh,
        &lab.tmux,
        &keeper,
        COUNTER,
        &keep::run_id()?,
        Limits::default(),
    )
    .await?;
    ensure!(again == Started::Busy, "{again:?}");
    ensure!(lab.out_size(&keeper)? >= before, "out was not emptied");
    keep::kill(&lab.ssh, &lab.tmux, &keeper).await?;
    Ok(())
}

/// Lines appended to `in` reach the agent in order, a retried append lands
/// once, and shutting the writer closes the agent's stdin.
#[tokio::test]
async fn lines_reach_the_agent_and_a_shut_writer_ends_it() -> Result<()> {
    let Some(lab) = Lab::start("feed").await? else {
        return Ok(());
    };
    let keeper = Keeper::new("web", "3c4d5e6f7a8b9c0d");
    lab.start_keeper(&keeper, "exec cat", Limits::default())
        .await?;
    let mut writer = keep::feed(lab.ssh.clone(), keeper.clone(), 0);
    writer.write_all(b"{\"one\":1}\n{\"two\":2}\n").await?;
    writer.flush().await?;
    let deadline = Instant::now() + Duration::from_secs(20);
    while keep::read(&lab.ssh, &keeper, File::In, None).await?.len() < 20 {
        ensure!(Instant::now() < deadline, "the writer appended both lines");
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    keep::append(&lab.ssh, &keeper, 20, b"{\"three\":3}\n").await?;
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let out = keep::read(&lab.ssh, &keeper, File::Out, None).await?;
        if out == b"{\"one\":1}\n{\"two\":2}\n{\"three\":3}\n" {
            break;
        }
        ensure!(Instant::now() < deadline, "out holds {out:?}");
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    // The same line at the same offset is already there.
    keep::append(&lab.ssh, &keeper, 20, b"{\"three\":3}\n").await?;
    let behind = keep::append(&lab.ssh, &keeper, 3, b"{\"no\":0}\n").await;
    ensure!(
        matches!(behind, Err(keep::Error::Behind { .. })),
        "{behind:?}"
    );
    let input = keep::read(&lab.ssh, &keeper, File::In, None).await?;
    ensure!(
        input == b"{\"one\":1}\n{\"two\":2}\n{\"three\":3}\n",
        "in holds {input:?}"
    );

    writer.shutdown().await?;
    let dead = lab.until_dead(&keeper).await?;
    ensure!(dead.status == Some(0), "cat ended at EOF: {dead:?}");
    keep::kill(&lab.ssh, &lab.tmux, &keeper).await?;
    Ok(())
}

/// ADR-0035 decision 5 on busybox: the size cap and the idle limit each stop
/// the agent and say why in `err`.
#[tokio::test]
async fn both_limits_stop_the_agent_and_say_why() -> Result<()> {
    let Some(lab) = Lab::start("limits").await? else {
        return Ok(());
    };
    let big = Keeper::new("web", "4d5e6f7a8b9c0d1e");
    lab.start_keeper(
        &big,
        "exec yes",
        Limits {
            cap: 4096,
            idle: 3600,
            tick: 1,
        },
    )
    .await?;
    let idle = Keeper::new("web", "5e6f7a8b9c0d1e2f");
    lab.start_keeper(
        &idle,
        "exec sleep 600",
        Limits {
            cap: 1 << 20,
            idle: 2,
            tick: 1,
        },
    )
    .await?;

    lab.until_dead(&big).await?;
    let said = String::from_utf8(keep::read(&lab.ssh, &big, File::Err, None).await?)?;
    ensure!(said.contains("yantra: output passed 4096 bytes"), "{said}");

    lab.until_dead(&idle).await?;
    let said = String::from_utf8(keep::read(&lab.ssh, &idle, File::Err, None).await?)?;
    ensure!(said.contains("yantra: idle for 2 seconds"), "{said}");

    for keeper in [&big, &idle] {
        keep::kill(&lab.ssh, &lab.tmux, keeper).await?;
    }
    ensure!(
        lab.fixture
            .run("pgrep -x yes || pgrep -f 'sleep 60[0]' || true")?
            .trim()
            .is_empty(),
        "no agent outlives its keeper"
    );
    Ok(())
}
