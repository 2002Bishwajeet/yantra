//! What this build is — `yantra about` and `GET /api/about` (Y-343).
//!
//! One `build.rs`, here rather than in each binary: every binary compiles this
//! crate for its own target in the same build and the workspace has one
//! version, so the three constants are the binary's own.

/// A nightly build carries its own version, which the workflow sets (Y-662).
pub const VERSION: &str = match option_env!("YANTRA_BUILD_VERSION") {
    Some(version) if !version.is_empty() => version,
    _ => env!("CARGO_PKG_VERSION"),
};
/// The target triple this was compiled for.
pub const TARGET: &str = env!("YANTRA_TARGET");
/// The UTC date the build script last ran, `YYYY-MM-DD`.
pub const BUILT: &str = env!("YANTRA_BUILT");

/// Whether a published release is newer than this build (ADR-0027 §2). The
/// decision is the library's, so `yantra update --check` and About agree.
pub fn newer(published: &crate::github::Release) -> bool {
    newer_than(published, VERSION)
}

/// Whether `version` orders below `than`. Either one unparsable is not older,
/// so a caller warns only on versions it can read (Y-713).
pub fn older(version: &str, than: &str) -> bool {
    use crate::github::Release;
    Release::parse(version)
        .zip(Release::parse(than))
        .is_some_and(|(version, than)| than.is_newer_than(&version))
}

fn newer_than(published: &crate::github::Release, running: &str) -> bool {
    // An unparsable running version orders below every release, so a check
    // says *newer* rather than *current* when it cannot tell.
    crate::github::Release::parse(running).is_none_or(|running| published.is_newer_than(&running))
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use crate::github::Release;

    fn release(tag: &str) -> Release {
        Release::parse(tag).expect("a version")
    }

    #[test]
    fn newer_orders_by_number_and_not_by_text() {
        assert!(newer_than(&release("0.3.4"), "0.3.3"));
        assert!(!newer_than(&release("0.3.3"), "0.3.3"), "equal is current");
        assert!(!newer_than(&release("0.3.2"), "0.3.3"), "older is current");
        assert!(newer_than(&release("1.0.0"), "0.9.9"));
        assert!(newer_than(&release("0.10.0"), "0.9.9"), "multi-digit minor");
        let nightly = "0.10.4-nightly.20261110143205.abc1234";
        assert!(
            newer_than(&release(nightly), "0.10.3"),
            "a nightly past stable"
        );
        assert!(
            !newer_than(&release("0.10.3"), nightly),
            "stable below a nightly"
        );
    }

    #[test]
    fn older_orders_nightlies_and_ignores_what_it_cannot_read() {
        assert!(older("0.3.2", "0.11.0"));
        assert!(!older("0.11.0", "0.11.0"));
        assert!(!older("0.12.0", "0.11.0"));
        assert!(older("0.11.0", "0.11.1-nightly.20261111000000.abc1234"));
        assert!(!older("0.11.1-nightly.20261111000000.abc1234", "0.11.0"));
        assert!(!older("garbage", "0.11.0"));
        assert!(!older("0.3.2", "garbage"));
    }

    #[test]
    fn this_build_is_not_newer_than_itself() {
        assert!(!newer(&release(VERSION)));
    }
}
