//! Listing one level of a machine, against a real shell (§B3).
//!
//! Y-300. The unit tests hold captured stdout and would keep passing if the
//! shell fragment stopped working entirely — it is a `for` loop over a glob
//! sent to `/bin/sh` on another machine, and only a real one can say whether it
//! parses, whether `printf '\0'` really writes a NUL, whether the glob skips
//! dotfiles and files, and whether a path holding a quote or a newline survives
//! the quoting.

#![allow(clippy::expect_used)]

mod common;

use anyhow::Result;
use common::{SshFixture, USER};
use std::path::PathBuf;
use yantra_core::dirs;
use yantra_core::ssh::{Exec, Machine, Ssh};

/// A name holding every character that ends a shell word, plus the newline
/// that would end a line-based record. The tests below build it on the far
/// side and expect it back byte for byte, or not at all.
const AWKWARD: &str = "a'quote $dollar `tick\nnewline";

async fn lab(label: &str) -> Result<Option<(SshFixture, Ssh)>> {
    let Some(fixture) = SshFixture::start()? else {
        return Ok(None);
    };
    let dir = PathBuf::from("/tmp").join(format!("ya-{label}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    let ssh = Ssh::new(Machine {
        host: fixture.host().to_owned(),
        user: Some(USER.to_owned()),
        port: Some(fixture.port()),
        identity: Some(fixture.key_path()),
        state_dir: dir,
    })?;
    Ok(Some((fixture, ssh)))
}

/// The crate's own quoting is `pub(crate)`, and a test that reached for it
/// would be arranging the machine with the code under test.
fn quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

fn named<'a>(listing: &'a dirs::Listing, name: &str) -> Option<&'a dirs::Dir> {
    listing.entries.iter().find(|entry| entry.name == name)
}

/// One level and nothing else: a repository, a plain directory, a dotfile, a
/// file and a grandchild — the last three of which must not appear.
#[tokio::test]
async fn one_level_marks_the_repositories_and_lists_nothing_else() -> Result<()> {
    let Some((_fixture, ssh)) = lab("dirs-level").await? else {
        return Ok(());
    };
    ssh.exec(
        "rm -rf /tmp/lab && mkdir -p /tmp/lab/repo/.git /tmp/lab/plain/deeper /tmp/lab/.hidden \
         && touch /tmp/lab/a-file",
    )
    .await?;

    let listing = dirs::list_on(&ssh, "fixture", Some("/tmp/lab")).await?;

    assert_eq!(listing.machine, "fixture");
    assert_eq!(listing.path, "/tmp/lab");
    let names: Vec<&str> = listing
        .entries
        .iter()
        .map(|entry| entry.name.as_str())
        .collect();
    assert_eq!(
        names,
        ["plain", "repo"],
        "a dotfile, a file and a grandchild are none of them one level of directories"
    );

    let repo = named(&listing, "repo").expect("the repository");
    assert!(repo.repo);
    assert_eq!(
        repo.path, "/tmp/lab/repo",
        "absolute and with no trailing /"
    );
    assert!(
        !named(&listing, "plain").expect("the plain directory").repo,
        "a directory with no .git is not a repository"
    );
    Ok(())
}

/// The distinction the whole answer turns on (D4 §5): a directory that is not
/// there is a refusal, and one that is there and empty is a listing.
#[tokio::test]
async fn an_empty_directory_lists_and_a_path_that_is_not_there_refuses() -> Result<()> {
    let Some((_fixture, ssh)) = lab("dirs-empty").await? else {
        return Ok(());
    };
    ssh.exec("mkdir -p /tmp/lab-empty").await?;

    let empty = dirs::list_on(&ssh, "fixture", Some("/tmp/lab-empty")).await?;
    assert!(empty.entries.is_empty());
    assert_eq!(empty.path, "/tmp/lab-empty");

    let missing = dirs::list_on(&ssh, "fixture", Some("/tmp/no-such-place"))
        .await
        .expect_err("a path that is not there is not an empty directory");
    assert!(
        matches!(missing, dirs::Error::NotADirectory { ref path, .. } if path == "/tmp/no-such-place"),
        "{missing:?}"
    );
    Ok(())
}

/// `test -d` is the question `up` asks, and a workspace names a directory — so
/// a file is not a listing of one entry.
#[tokio::test]
async fn a_path_that_is_a_file_is_not_a_directory() -> Result<()> {
    let Some((_fixture, ssh)) = lab("dirs-file").await? else {
        return Ok(());
    };
    ssh.exec("touch /tmp/lab-a-file").await?;

    let refused = dirs::list_on(&ssh, "fixture", Some("/tmp/lab-a-file"))
        .await
        .expect_err("a file holds no entries");
    assert!(
        matches!(refused, dirs::Error::NotADirectory { .. }),
        "{refused:?}"
    );
    Ok(())
}

/// **The highest-value test here.** A path is a value a person typed, so it
/// reaches a remote shell as one word or it reaches it as several commands —
/// and it comes back as the name it is or it does not come back.
#[tokio::test]
async fn a_name_holding_a_quote_a_dollar_a_backtick_and_a_newline_survives() -> Result<()> {
    let Some((_fixture, ssh)) = lab("dirs-quoting").await? else {
        return Ok(());
    };
    let parent = format!("/tmp/lab-odd/{AWKWARD}");
    ssh.exec(&format!(
        "rm -rf /tmp/lab-odd && mkdir -p {} && touch /tmp/lab-odd/marker",
        quoted(&format!("{parent}/child"))
    ))
    .await?;

    // The awkward name as an entry of the directory above it.
    let above = dirs::list_on(&ssh, "fixture", Some("/tmp/lab-odd")).await?;
    let entry = named(&above, AWKWARD).expect("the awkward directory, whole");
    assert_eq!(entry.path, parent);
    assert_eq!(above.entries.len(), 1, "the marker is a file: {above:?}");

    // And as the directory being listed, which is where it reaches the shell.
    let inside = dirs::list_on(&ssh, "fixture", Some(&parent)).await?;
    assert_eq!(inside.path, parent);
    assert_eq!(
        inside
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>(),
        ["child"]
    );

    // And a path written to end the quoting runs nothing: it is a directory
    // with an odd name that is not there, which is an answer and not a command.
    let injection = "/tmp/lab-odd'; touch /tmp/pwned; echo '";
    let refused = dirs::list_on(&ssh, "fixture", Some(injection))
        .await
        .expect_err("no directory is spelled that way");
    assert!(
        matches!(refused, dirs::Error::NotADirectory { ref path, .. } if path == injection),
        "{refused:?}"
    );
    let ran = ssh
        .exec("test -e /tmp/pwned && echo yes || echo no")
        .await?;
    assert_eq!(String::from_utf8_lossy(&ran.stdout).trim(), "no");
    Ok(())
}

/// The half the unit tests cannot reach: whether `git`'s own failure is really
/// swallowed on a real `/bin/sh`, rather than taking the listing with it.
#[tokio::test]
async fn a_real_repository_reports_its_origin_and_a_bare_one_does_not() -> Result<()> {
    let Some((fixture, ssh)) = lab("dirs-git").await? else {
        return Ok(());
    };
    // The fixture image carries no git, and adding it there would rebuild an
    // image five other suites share for one assertion. Installing it into the
    // running container needs a network the test run is not promised.
    let _ = fixture.arrange_as_root("apk add --no-cache git");
    let out = ssh.exec("command -v git || true").await?;
    if String::from_utf8_lossy(&out.stdout).trim().is_empty() {
        // Saying so beats a silent pass: this test's whole subject is git.
        eprintln!("skipped: no git in the fixture container");
        return Ok(());
    }

    ssh.exec(
        "rm -rf /tmp/lab-git && mkdir -p /tmp/lab-git/with /tmp/lab-git/without \
         && cd /tmp/lab-git/with && git init -q \
         && git remote add origin https://example.invalid/o/r.git \
         && cd /tmp/lab-git/without && git init -q",
    )
    .await?;

    let listing = dirs::list_on(&ssh, "fixture", Some("/tmp/lab-git")).await?;
    let with = named(&listing, "with").expect("the repository with an origin");
    assert_eq!(
        with.origin.as_deref(),
        Some("https://example.invalid/o/r.git")
    );

    let without = named(&listing, "without").expect("the repository with none");
    assert!(
        without.repo,
        "it is a repository whatever git said about origin"
    );
    assert_eq!(without.origin, None, "no origin here, and not a failure");
    Ok(())
}

/// D4 §3: the daemon composes no path, so the machine's own `$HOME` is the
/// only place a listing can start.
#[tokio::test]
async fn no_path_lists_the_machines_own_home() -> Result<()> {
    let Some((_fixture, ssh)) = lab("dirs-home").await? else {
        return Ok(());
    };
    ssh.exec("mkdir -p ~/Github").await?;

    let listing = dirs::list_on(&ssh, "fixture", None).await?;

    assert_eq!(listing.path, format!("/home/{USER}"));
    assert!(named(&listing, "Github").is_some(), "{listing:?}");
    assert!(
        named(&listing, ".ssh").is_none(),
        "a dotfile is reached by naming it (D4 §3.1): {listing:?}"
    );
    Ok(())
}

/// R-23: a machine that could not be asked is not a machine with no
/// directories, and the diagnosis travels so the operator knows which it was.
#[tokio::test]
async fn a_machine_that_cannot_be_reached_is_not_an_empty_listing() -> Result<()> {
    let Some((fixture, _)) = lab("dirs-unreachable").await? else {
        return Ok(());
    };
    let dir = PathBuf::from("/tmp/ya-dirs-shut");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    let shut = Ssh::new(Machine {
        host: fixture.host().to_owned(),
        user: Some(USER.to_owned()),
        // The container publishes one port and this is not it.
        port: Some(1),
        identity: Some(fixture.key_path()),
        state_dir: dir,
    })?;

    let refused = dirs::list_on(&shut, "fixture", Some("/tmp"))
        .await
        .expect_err("nothing answered, so nothing was listed");
    assert!(matches!(refused, dirs::Error::Ssh(_)), "{refused:?}");
    assert!(
        refused.to_string().contains("127.0.0.1"),
        "the ssh chain names what was tried: {refused}"
    );
    Ok(())
}
