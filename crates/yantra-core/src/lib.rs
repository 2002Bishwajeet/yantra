//! `yantra-core` — the orchestration logic, with no opinion about who calls it.
//!
//! Everything Yantra actually *does* — load a workspace, reach a machine over
//! SSH, ensure a tmux session — lives here. The binaries around it are thin:
//!
//! - `yantra` (CLI) calls into this crate directly for now, and becomes an HTTP
//!   client of `yantrad` in M2.
//! - `yantrad` (daemon) will call the *same* functions from an axum handler.
//!
//! That is the whole point of the crate boundary: the M2 change is *where* this
//! code is called from, not *what* it does. See
//! [ADR-0005](../../../docs/adr/0005-core-logic-in-a-library-crate.md).
//!
//! ## Two rules this boundary exists to enforce
//!
//! 1. **Never print, never exit.** No `println!`, no `eprintln!`, no
//!    `std::process::exit`. Fallible operations return `Result` with a typed
//!    error and let the caller decide how to surface it. A daemon that inherits
//!    a CLI's habit of exiting on failure is a daemon that dies on its first bad
//!    workspace file.
//! 2. **Keep the public surface small.** A `pub` item is a promise to two
//!    callers and a temptation to generalise. Export the operation and its error
//!    type; keep the rest private until something outside genuinely needs it.
//!
//! Nothing is implemented yet — this is the crate boundary landing ahead of the
//! M1 walking skeleton (Y-040 through Y-043).
