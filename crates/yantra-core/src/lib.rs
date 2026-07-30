//! `yantra-core` — the orchestration logic, with no opinion about who calls it.
//!
//! The CLI calls this in-process today; `yantrad` will call the same functions
//! from an axum handler in M2. See
//! [ADR-0005](../../../docs/adr/0005-core-logic-in-a-library-crate.md).
//!
//! Two rules bind this crate:
//!
//! 1. **Never print, never exit.** Return `Result` and let the caller decide.
//! 2. **Keep the public surface small.** Export the operation and its error
//!    type; keep the rest private until something outside needs it.

pub mod inventory;
pub mod ssh;
pub mod tmux;
pub mod up;
pub mod workspace;
