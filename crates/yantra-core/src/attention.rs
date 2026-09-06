//! What is waiting for the owner on GitHub.
//!
//! **Read with the grant this process holds** (Y-342,
//! [ADR-0023]). Until then this module spawned `gh` where the daemon ran and
//! held no credential; the appliance has no `gh` and nobody logged in, so the
//! daemon now reads GitHub's REST API with an OAuth App token of its own —
//! [`crate::github`] holds the wire, and this module holds what the inbox is.
//!
//! [ADR-0023]: ../../../docs/adr/0023-the-github-grant-lives-beside-the-relay.md

pub use crate::github::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    /// `owner/name`, the only spelling that is unique across GitHub.
    pub repo: String,
    pub number: u64,
    pub title: String,
    /// GitHub's own web URL, so the page links out rather than rebuilding it
    /// from the parts and getting `/issues` versus `/pull` wrong.
    pub url: String,
    /// RFC 3339, as GitHub sent it. Not parsed here: this crate does no layout
    /// (ADR-0005), and the age a reader wants is against *now*, not against the
    /// poll.
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Attention {
    /// Pull requests waiting on this account's review.
    pub reviews: Vec<Item>,
    /// Issues assigned to this account.
    pub issues: Vec<Item>,
    /// Unread notifications. A count rather than a list: the titles are the
    /// part that would land in a journal, and nothing draws them.
    pub notifications: u32,
}

/// The seam the layers above are tested against (§B2). GitHub cannot be put in
/// a container, so like [`crate::inventory::Inventory`] and unlike
/// [`crate::ssh::Exec`] this one is faked above and proved against the real
/// thing in `tests/github_api.rs`. [`crate::github::Api`] is the one the CLI
/// uses; the daemon wraps a grant that can change under it.
pub trait Forge {
    fn attention(&self) -> impl std::future::Future<Output = Result<Attention, Error>> + Send;
}
