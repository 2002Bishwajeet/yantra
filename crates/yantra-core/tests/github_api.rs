//! `Github` against the real API, with a real grant.
//!
//! GitHub cannot go in the podman fixture, so root §B3's *"tested against the
//! real thing"* lands here as an ignored test rather than a container one — the
//! same choice `tailscale_inventory.rs` makes for the tailnet, and ignored
//! rather than silently skipped is the crate rule.
//!
//! What only this can prove: that the three endpoints still answer the shapes
//! `github.rs` reads, and that the `Link` header still spells pagination the
//! way it did on 2026-09-06. The unit tests hold scripted answers and would
//! keep passing through an API change that renamed all of it.
//!
//! Run with `YANTRA_GITHUB_TOKEN` set to a grant `yantra github login` made.

// A failing assertion is this file's whole output; the workspace lint targets
// library code, where the same call would take the daemon down.
#![allow(clippy::panic, clippy::expect_used)]

use yantra_core::github::{self, Github};

#[tokio::test]
#[ignore = "needs a real GitHub grant in YANTRA_GITHUB_TOKEN; run with --ignored"]
async fn the_real_api_answers_in_the_shapes_this_crate_reads() {
    let token = github::from_env().expect("YANTRA_GITHUB_TOKEN names a grant");
    let api = Github::default();

    let login = api.login_name(&token).await.expect("GET /user");
    assert!(!login.is_empty(), "a login is never empty");

    let repos = api.repos(&token).await.expect("GET /user/repos");
    for repo in &repos {
        assert!(
            repo.full_name.contains('/'),
            "`full_name` should be owner/name, got {:?}",
            repo.full_name
        );
        assert!(
            repo.clone_url.ends_with(".git"),
            "`clone_url` should be the https clone URL, got {:?}",
            repo.clone_url
        );
        assert!(!repo.default_branch.is_empty());
    }

    // Emptiness is a real answer — an owner with nothing waiting is not a
    // failure. What is asserted is that every item that *did* arrive is whole.
    let attention = api.attention(&token).await.expect("the three reads");
    for item in attention.reviews.iter().chain(&attention.issues) {
        assert!(
            item.repo.contains('/'),
            "the repository should be owner/name, got {:?}",
            item.repo
        );
        assert!(item.number > 0, "an issue or PR number is never zero");
        assert!(
            item.url.starts_with("https://github.com/"),
            "the web URL should be GitHub's own, got {:?}",
            item.url
        );
        assert!(!item.title.is_empty(), "a title is never empty");
        assert!(
            item.updated_at.ends_with('Z'),
            "`updated_at` should be RFC 3339 UTC, got {:?}",
            item.updated_at
        );
    }
}
