//! Y-058 against a real terminfo database, per §B3.
//!
//! The container carries Alpine's ncurses, which knows `alacritty` but not
//! `xterm-ghostty` — so both halves of the question have a real answer here and
//! neither is arranged. What it cannot cover is macOS's decade-older ncurses;
//! `manual_macbook.rs` holds that, and per I-32 green here does not mean it.

// `expect` in a test is a deliberate abort with a message.
#![allow(clippy::expect_used)]

mod common;

use anyhow::Result;
use common::{SshFixture, USER};
use yantra_core::ssh::{Machine, Ssh};
use yantra_core::terminfo::{self, Chosen, Error};

/// Known to Alpine's ncurses, so `choose` has something real to say yes to.
const KNOWN_REMOTELY: &str = "alacritty";

/// Tried in order for the install test, which needs one this machine can
/// describe and the container has never heard of. The list spans developer
/// boxes and CI runners because their terminfo databases barely overlap:
/// measured, Arch has `xterm-ghostty` and no `rxvt-unicode-256color`, and
/// Ubuntu has exactly the reverse.
const CANDIDATES: [&str; 5] = [
    "xterm-ghostty",
    "foot",
    "wezterm",
    "rxvt-unicode-256color",
    "xterm-kitty",
];

struct Lab {
    fixture: SshFixture,
    ssh: Ssh,
    dir: std::path::PathBuf,
}

impl Lab {
    fn start(label: &str) -> Result<Option<Self>> {
        let Some(fixture) = SshFixture::start()? else {
            return Ok(None);
        };
        let dir = std::path::PathBuf::from("/tmp").join(format!("yt-{label}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)?;
        let ssh = Ssh::new(Machine {
            host: fixture.host().to_owned(),
            user: Some(USER.to_owned()),
            port: Some(fixture.port()),
            identity: Some(fixture.key_path()),
            state_dir: dir.clone(),
        })?;
        Ok(Some(Self { fixture, ssh, dir }))
    }

    /// A terminal this machine can describe and the container cannot resolve.
    /// Failing rather than skipping is I-32: a test that quietly stops
    /// exercising the install is worse than one that says the list needs a name.
    fn installable(&self) -> Result<&'static str> {
        for term in CANDIDATES {
            let here = std::process::Command::new("infocmp")
                .args(["-x", term])
                .output()?;
            // `|| true`: absence is the answer being looked for, not a failure.
            let there = self.fixture.run(&format!(
                "infocmp {term} >/dev/null 2>&1 && echo yes || true"
            ))?;
            if here.status.success() && there.trim().is_empty() {
                return Ok(term);
            }
        }
        anyhow::bail!(
            "none of {CANDIDATES:?} is describable here and missing there, so the \
             install path cannot be exercised — add a terminal this machine has"
        )
    }
}

impl Drop for Lab {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// The pass-through half: a terminal the far side has must survive unchanged,
/// or Y-058 has bought nothing over the pinned constant it replaced.
#[tokio::test]
async fn a_terminal_the_machine_has_is_used_as_is() -> Result<()> {
    let Some(lab) = Lab::start("known")? else {
        return Ok(());
    };
    let chosen = terminfo::choose(&lab.ssh, KNOWN_REMOTELY).await?;
    assert_eq!(chosen, Chosen::Known(KNOWN_REMOTELY.to_owned()));
    assert_eq!(chosen.term(), KNOWN_REMOTELY);
    Ok(())
}

/// The fallback half. tmux refuses to start on a terminal it cannot find, so
/// the wrong answer here is an attach that aborts, not one that looks duller.
#[tokio::test]
async fn a_terminal_the_machine_lacks_falls_back_to_one_it_has() -> Result<()> {
    let Some(lab) = Lab::start("unknown")? else {
        return Ok(());
    };
    let chosen = terminfo::choose(&lab.ssh, "xterm-ghostty").await?;
    assert_eq!(
        chosen,
        Chosen::Substituted {
            wanted: "xterm-ghostty".to_owned()
        }
    );
    assert_eq!(chosen.term(), terminfo::FALLBACK);

    // And the floor must actually be on the floor.
    let has_fallback = lab.fixture.run(&format!(
        "infocmp {} >/dev/null && echo yes",
        terminfo::FALLBACK
    ))?;
    assert_eq!(has_fallback.trim(), "yes");
    Ok(())
}

/// The whole point of supporting the install: a machine that did not know the
/// terminal knows it afterwards, and `choose` changes its answer.
#[tokio::test]
async fn installing_turns_a_substitution_into_a_pass_through() -> Result<()> {
    let Some(lab) = Lab::start("install")? else {
        return Ok(());
    };
    let term = lab.installable()?;

    let before = terminfo::choose(&lab.ssh, term).await?;
    assert_eq!(
        before,
        Chosen::Substituted {
            wanted: term.to_owned()
        },
        "precondition: the container must not already have {term}"
    );

    let installed = terminfo::install(&lab.ssh, term).await?;
    assert_eq!(installed.term, term);

    let after = terminfo::choose(&lab.ssh, term).await?;
    assert_eq!(after, Chosen::Known(term.to_owned()));

    // User-scoped, never system-wide: Yantra holds no root on anyone's machine.
    let home = lab.fixture.run("ls ~/.terminfo | head -1")?;
    assert!(!home.trim().is_empty(), "nothing landed in ~/.terminfo");
    let system = lab
        .fixture
        .run("find /usr/share/terminfo -newer /etc/hostname 2>/dev/null | head -1")?;
    assert!(
        system.trim().is_empty(),
        "the system database was touched: {}",
        system.trim()
    );
    Ok(())
}

/// Installing the same terminal twice must not be an error — the fix is
/// something a person runs when unsure whether they ran it already.
#[tokio::test]
async fn installing_twice_is_not_an_error() -> Result<()> {
    let Some(lab) = Lab::start("twice")? else {
        return Ok(());
    };
    let term = lab.installable()?;
    terminfo::install(&lab.ssh, term).await?;
    terminfo::install(&lab.ssh, term).await?;
    assert_eq!(
        terminfo::choose(&lab.ssh, term).await?,
        Chosen::Known(term.to_owned())
    );
    Ok(())
}

/// A machine with no `infocmp` cannot answer the question. Falling back is the
/// safe reading: it costs colour depth, where believing the terminal is present
/// costs the attach itself.
#[tokio::test]
async fn a_machine_that_cannot_answer_falls_back_rather_than_failing() -> Result<()> {
    let Some(lab) = Lab::start("noinfocmp")? else {
        return Ok(());
    };
    lab.fixture
        .arrange_as_root("mv /usr/bin/infocmp /usr/bin/infocmp.hidden")?;
    let gone = lab.fixture.run("command -v infocmp || true")?;
    assert!(
        gone.trim().is_empty(),
        "precondition failed: infocmp is still at {}",
        gone.trim()
    );

    // Even the terminal it certainly has, because it can no longer say so.
    assert_eq!(
        terminfo::choose(&lab.ssh, KNOWN_REMOTELY).await?,
        Chosen::Substituted {
            wanted: KNOWN_REMOTELY.to_owned()
        }
    );
    Ok(())
}

/// `TERM` is an environment variable that ends up inside a remote command, so
/// this is the trust boundary, not a tidiness check.
#[tokio::test]
async fn a_hostile_terminal_name_never_reaches_the_far_side() -> Result<()> {
    let Some(lab) = Lab::start("hostile")? else {
        return Ok(());
    };
    let hostile = "x; touch /tmp/pwned";

    // `choose` refuses by falling back; it never asks the far side at all.
    assert_eq!(
        terminfo::choose(&lab.ssh, hostile).await?,
        Chosen::Known(terminfo::FALLBACK.to_owned())
    );
    // `install` refuses louder, because it was asked to change something.
    assert!(matches!(
        terminfo::install(&lab.ssh, hostile).await,
        Err(Error::InvalidName { .. })
    ));

    let landed = lab.fixture.run("ls /tmp/pwned 2>/dev/null || true")?;
    assert!(landed.trim().is_empty(), "the injection ran: {landed}");
    Ok(())
}
