//! Whether the machine you attach *to* knows the terminal you sit *at* (I-36).
//!
//! tmux does not degrade when it cannot find the client's terminal — it refuses
//! to start. So every remote attach needs an answer to one question, and the
//! answer is per-machine: measured, `cachyos-g14` knows 9 of 11 terminals tested
//! and this MacBook knows 5, with `xterm-ghostty` present on one and absent on
//! the other. Hence a probe rather than a list of terminals to support.

use crate::ssh::{self, Exec, Ssh};

/// The entry every terminfo database carries, used when the far side has no
/// description of the caller's own terminal.
pub const FALLBACK: &str = "xterm-256color";

/// Which terminal a remote tmux will be given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Chosen {
    /// The far side has this entry, so it goes through unchanged.
    Known(String),
    /// The far side has no entry for `wanted`. Attaching still works; what is
    /// lost is whatever the fallback lacks — for Ghostty that is truecolour
    /// (`Tc`) and styled underlines (`Su`).
    Substituted { wanted: String },
}

impl Chosen {
    pub fn term(&self) -> &str {
        match self {
            Self::Known(term) => term,
            Self::Substituted { .. } => FALLBACK,
        }
    }
}

/// What `tic` made of the description. It exits 0 on entries it accepted with
/// reservations, so the version-skew warning belongs here and not in an error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installed {
    pub term: String,
    pub warnings: String,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Ssh(#[from] ssh::Error),

    #[error("`{term}` is not a usable terminal name")]
    InvalidName { term: String },

    #[error("could not run `infocmp` here — is ncurses installed?")]
    NoInfocmp(#[source] std::io::Error),

    #[error("this machine has no description of `{term}` to copy")]
    UnknownLocally { term: String },

    #[error("`tic` on the far side rejected the description: {stderr}")]
    Rejected { stderr: String },

    /// `tic` succeeded and the entry still cannot be found, which usually means
    /// `TERMINFO`/`TERMINFO_DIRS` points somewhere else on that machine.
    #[error("`{term}` compiled on the far side but is still not visible there")]
    NotVisible { term: String },

    #[error("could not determine a directory for ssh control sockets")]
    NoStateDir,
}

/// The terminal to hand a remote tmux: `preferred` when the far side has an
/// entry, [`FALLBACK`] otherwise.
///
/// A machine without `infocmp` is treated as not having the entry. The two are
/// indistinguishable from here, and guessing wrong the other way costs an
/// attach that aborts rather than one that loses colour depth.
pub async fn choose<E: Exec>(exec: &E, preferred: &str) -> Result<Chosen, Error> {
    if preferred == FALLBACK || !is_name(preferred) {
        return Ok(Chosen::Known(FALLBACK.to_owned()));
    }
    if exec.exec(&known(preferred)).await?.success() {
        Ok(Chosen::Known(preferred.to_owned()))
    } else {
        Ok(Chosen::Substituted {
            wanted: preferred.to_owned(),
        })
    }
}

/// Copies this machine's description of `term` into the remote user's
/// `~/.terminfo`. Never system-wide: that needs root, and Yantra has no
/// business holding it.
///
/// Deliberately explicit rather than part of `up` — writing to someone's
/// machine should be something they asked for, not a side effect of attaching.
pub async fn install<E: Exec>(exec: &E, term: &str) -> Result<Installed, Error> {
    if !is_name(term) {
        return Err(Error::InvalidName {
            term: term.to_owned(),
        });
    }
    let source = describe(term).await?;
    let out = exec.exec(&compile(term, &source)).await?;
    let said = String::from_utf8_lossy(&out.stderr).trim().to_owned();

    match out.status {
        0 => Ok(Installed {
            term: term.to_owned(),
            warnings: said,
        }),
        2 => Err(Error::NotVisible {
            term: term.to_owned(),
        }),
        _ => Err(Error::Rejected { stderr: said }),
    }
}

/// [`install`] against a machine named the way a workspace names one (ADR-0009).
pub async fn install_on(machine: &str, term: &str) -> Result<Installed, Error> {
    let ssh = Ssh::new(ssh::machine_at(machine).ok_or(Error::NoStateDir)?)?;
    install(&ssh, term).await
}

/// `-x` because the extended capabilities are the whole reason for copying:
/// without them the entry arrives without `Tc` and the colour depth is lost.
/// The second command is the check that `tic` exiting 0 does not give — it
/// compiled somewhere, but not necessarily somewhere that machine reads.
fn compile(term: &str, source: &[u8]) -> String {
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(source);
    format!(
        "printf %s '{b64}' | base64 -d | tic -x - || exit 1\n{}\n",
        known(term)
    )
}

/// `infocmp` is asked bare, unlike tmux (I-34): ncurses ships in the base system
/// on both real machines, so `/usr/bin/infocmp` is on sshd's `PATH` where
/// Homebrew's tmux is not.
///
/// I-43: this answers for the *system* terminfo database, which is not always
/// the one tmux reads. The error only ever runs one way — a needless fallback,
/// never an attach that aborts — and [`install`] settles it either way.
fn known(term: &str) -> String {
    format!("infocmp {term} >/dev/null 2>&1 || exit 2")
}

/// This machine's description of `term`, in the source form `tic` reads.
async fn describe(term: &str) -> Result<Vec<u8>, Error> {
    let out = tokio::process::Command::new("infocmp")
        .args(["-x", term])
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .map_err(Error::NoInfocmp)?;
    if !out.status.success() {
        return Err(Error::UnknownLocally {
            term: term.to_owned(),
        });
    }
    Ok(out.stdout)
}

/// `term` reaches a remote shell interpolated into a command, so this is a trust
/// boundary and not a tidiness check — `TERM` is an environment variable and
/// anything outside this alphabet is either a typo or an attempt to break out.
fn is_name(term: &str) -> bool {
    !term.is_empty()
        && term.len() <= 64
        && term
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'+' | b'.' | b'_'))
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn real_terminal_names_are_accepted() {
        for term in [
            "xterm-256color",
            "xterm-ghostty",
            "alacritty",
            "screen.linux",
            "Eterm",
            "tmux-256color",
            "vt100+keypad",
            "st-256color",
        ] {
            assert!(is_name(term), "{term} is a real terminfo name");
        }
    }

    #[test]
    fn a_name_that_could_escape_the_command_is_refused() {
        for hostile in [
            "xterm; rm -rf /",
            "$(id)",
            "`id`",
            "a b",
            "x'y",
            "x\"y",
            "x|y",
            "x\ny",
            "x&y",
            "",
        ] {
            assert!(!is_name(hostile), "{hostile:?} must not reach a shell");
        }
    }

    /// Long enough to be a buffer probe rather than a terminal.
    #[test]
    fn an_absurdly_long_name_is_refused() {
        assert!(!is_name(&"x".repeat(65)));
    }

    #[test]
    fn the_fallback_is_what_a_substitution_resolves_to() {
        let fell_back = Chosen::Substituted {
            wanted: "xterm-ghostty".to_owned(),
        };
        assert_eq!(fell_back.term(), FALLBACK);
        assert_eq!(Chosen::Known("alacritty".to_owned()).term(), "alacritty");
    }

    /// The compiled payload must carry no trace of the description's own bytes,
    /// which are full of escapes and commas.
    #[test]
    fn the_description_travels_base64_encoded() {
        let script = compile("xterm-ghostty", b"xterm-ghostty|Ghostty,\n\tTc, Su,\n");
        assert!(!script.contains("Tc,"), "{script}");
        assert!(script.contains("base64 -d | tic -x -"), "{script}");
        assert!(script.contains("infocmp xterm-ghostty"), "{script}");
    }
}
