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

pub mod about;
pub mod acp;
pub mod agent;
pub mod attach;
pub mod attention;
pub mod chat;
pub mod checkpoint;
pub mod claude;
pub mod clone;
pub mod delegate;
pub mod dirs;
pub mod doctor;
pub mod down;
pub mod edit;
pub mod github;
pub mod heartbeat;
pub mod history;
pub mod identity;
pub mod image;
pub mod install;
pub mod inventory;
pub mod join;
pub mod logs;
pub mod mic;
pub mod notify;
pub mod placement;
pub mod price;
pub mod probe;
pub mod pty;
pub mod remove;
pub mod resume;
pub mod sessions;
pub mod snapshot;
pub mod ssh;
pub mod status;
pub mod terminfo;
pub mod thread;
pub mod tmux;
pub mod tokens;
pub mod up;
pub mod update;
pub mod workspace;
