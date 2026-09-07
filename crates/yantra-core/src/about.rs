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
