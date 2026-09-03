//! `Gh` against the real binary and the real GitHub.
//!
//! GitHub cannot go in the podman fixture, so root §B3's *"tested against the
//! real thing"* lands here as an ignored test rather than a container one — the
//! same choice `tailscale_inventory.rs` makes for the tailnet, and ignored
//! rather than silently skipped is the crate rule.
//!
//! What only this can prove: that the flags still exist, that `--json` still
//! spells the five fields this asks for, and that a real answer parses. The unit
//! tests hold captured output and would keep passing through a `gh` release
//! that renamed all of it.

// A failing assertion is this file's whole output; the workspace lint targets
// library code, where the same call would take the daemon down.
#![allow(clippy::panic)]

use yantra_core::attention::{Error, Forge, Gh};

#[tokio::test]
#[ignore = "needs a real `gh`, logged in; run with --ignored"]
async fn the_real_gh_answers_in_the_shape_this_crate_parses() {
    let got = Gh.attention().await;

    let attention = match got {
        Ok(a) => a,
        // A machine without the credential is the documented state, not a
        // broken test — say which one it is and stop.
        Err(e @ (Error::NotInstalled | Error::LoggedOut | Error::Unreachable)) => {
            panic!("this machine cannot answer: {e}")
        }
        Err(e) => panic!("`gh` failed in a way the classifier did not expect: {e}"),
    };

    // Emptiness is a real answer — an owner with nothing waiting is not a
    // failure. What is asserted is that every item that *did* arrive is whole,
    // because a silently-renamed field would arrive as a parse error above.
    for item in attention.reviews.iter().chain(&attention.issues) {
        assert!(
            item.repo.contains('/'),
            "`nameWithOwner` should be owner/name, got {:?}",
            item.repo
        );
        assert!(item.number > 0, "an issue or PR number is never zero");
        assert!(
            item.url.starts_with("https://"),
            "the web URL should be absolute, got {:?}",
            item.url
        );
        assert!(!item.title.is_empty(), "a title is never empty");
        assert!(
            item.updated_at.ends_with('Z'),
            "`updatedAt` should be RFC 3339 UTC, got {:?}",
            item.updated_at
        );
    }
}
