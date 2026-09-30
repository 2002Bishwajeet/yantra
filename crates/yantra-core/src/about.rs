//! What this build is — `yantra about` and `GET /api/about` (Y-343).
//!
//! One `build.rs`, here rather than in each binary: every binary compiles this
//! crate for its own target in the same build and the workspace has one
//! version, so the three constants are the binary's own.

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// The target triple this was compiled for.
pub const TARGET: &str = env!("YANTRA_TARGET");
/// The UTC date the build script last ran, `YYYY-MM-DD`.
pub const BUILT: &str = env!("YANTRA_BUILT");

/// Whether a published release is newer than this build (ADR-0027 §2). The
/// decision is the library's, so `yantra update --check` and About agree.
pub fn newer(published: &crate::github::Release) -> bool {
    newer_than(published, VERSION)
}

fn newer_than(published: &crate::github::Release, running: &str) -> bool {
    // An unparsable running version orders below every release, so a check
    // says *newer* rather than *current* when it cannot tell.
    crate::github::Release::parse(running).is_none_or(|running| published.parts > running.parts)
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
    }

    #[test]
    fn this_build_is_not_newer_than_itself() {
        assert!(!newer(&release(VERSION)));
    }
}
