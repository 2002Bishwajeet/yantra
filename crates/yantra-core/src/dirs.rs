//! Asking a machine what one directory holds, so a form can offer a choice
//! rather than a blank field.
//!
//! **One level, and never a sweep.** [D4] §2 measured `find $HOME -maxdepth 4
//! -name .git` at 8.6 s over ssh to this fleet's Mac — warm, and only 1.3 s of
//! it recoverable by pruning — against 0.026 s on its Linux box. One level with
//! the git marker cost 0.23 s, which is what [`crate::probe`] already charges.
//! So the verb walks and does not search, and this module holds no recursion,
//! no cache and no file.
//!
//! **This is a read, and it is reached over a `POST`**, for [`crate::probe`]'s
//! reason and on the same ruling ([ADR-0019]): the answer depends on a path
//! nobody has typed yet, so no snapshot can hold it.
//!
//! [D4]: ../../../docs/design/04-workspace-creation.md
//! [ADR-0019]: ../../../docs/adr/0019-a-probe-that-asks-a-machine-is-a-post.md

use crate::ssh::{self, Exec, Ssh};
use crate::tmux;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listing {
    pub machine: String,
    /// The directory that was listed, as the far side spells it — which is how
    /// a caller that named no path learns where that machine's `$HOME` is.
    pub path: String,
    /// Ordered as the far side's shell globbed them, and holding only
    /// directories: **a name beginning with a dot is not among them**, because
    /// `*/` skips it (D4 §3.1). Such a directory is reached by naming it.
    pub entries: Vec<Dir>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dir {
    /// Absolute, as the far side wrote it.
    pub path: String,
    /// The last segment, which is what a picker draws.
    pub name: String,
    pub repo: bool,
    /// `origin`'s URL where this is a repository that has one. `None` covers
    /// both *not a repository* and *a repository with no origin*, exactly as
    /// [`crate::probe`] leaves them together.
    pub origin: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Ssh(#[from] ssh::Error),

    /// The machine answered, and what it said is that there is nothing to list
    /// there. Distinct from an empty directory, which is a listing.
    #[error("{machine} has no directory at {path}")]
    NotADirectory { machine: String, path: String },

    /// The far side printed something this build cannot read. Not an absence:
    /// claiming one that was not earned is the confident lie R-23 is about.
    #[error("{machine} answered a listing this build could not read")]
    Unreadable { machine: String },

    #[error("could not determine a directory for ssh control sockets")]
    NoStateDir,
}

/// `path` of `None` is the machine's own `$HOME`, which is the only directory
/// Yantra can name without asking. Nothing here composes a path.
pub async fn list(machine: &str, path: Option<&str>) -> Result<Listing, Error> {
    let ssh = Ssh::new(ssh::machine_at(machine).ok_or(Error::NoStateDir)?)?;
    list_on(&ssh, machine, path).await
}

/// The testable half, driven by the container fixture.
pub async fn list_on<E: Exec>(
    exec: &E,
    machine: &str,
    path: Option<&str>,
) -> Result<Listing, Error> {
    let out = exec.exec(&command(path)).await?;
    match parse(&out.stdout) {
        Some(Answer::Listed { path, entries }) => Ok(Listing {
            machine: machine.to_owned(),
            path,
            entries,
        }),
        Some(Answer::NotADirectory { path }) => Err(Error::NotADirectory {
            machine: machine.to_owned(),
            path,
        }),
        None => Err(Error::Unreadable {
            machine: machine.to_owned(),
        }),
    }
}

/// One round trip, for [`crate::probe::probe`]'s reason: whether an entry is a
/// repository and what origin it holds only matter for the entries being shown
/// now, and a person is waiting on all of it.
///
/// **Records are NUL-separated**, so a directory whose name holds a newline or
/// a tab arrives whole rather than as two half rows — a path is the one string
/// a filesystem lets hold anything but `/` and NUL. `git`'s own failure is
/// swallowed as [`crate::probe`] swallows it.
///
/// The trailing `/` on the glob is what restricts it to directories, and it is
/// also why a dotfile is not listed (D4 §3.1). `$p` gives the base exactly one
/// trailing slash, so `/` lists as `/bin` rather than `//bin`.
fn command(path: Option<&str>) -> String {
    let base = match path {
        Some(path) => tmux::sq(path),
        None => r#""$HOME""#.to_owned(),
    };
    format!(
        r#"b={base}
if test -d "$b"; then
  printf 'yes\0%s\0' "$b"
  case "$b" in */) p=$b;; *) p=$b/;; esac
  for d in "$p"*/; do
    [ -d "$d" ] || continue
    if [ -d "${{d}}.git" ]; then
      printf '%s\0repo\0%s\0' "$d" "$(git -C "$d" remote get-url origin 2>/dev/null)"
    else
      printf '%s\0dir\0\0' "$d"
    fi
  done
else
  printf 'no\0%s\0' "$b"
fi"#
    )
}

enum Answer {
    Listed { path: String, entries: Vec<Dir> },
    NotADirectory { path: String },
}

fn parse(stdout: &[u8]) -> Option<Answer> {
    let mut fields = stdout
        .split(|byte| *byte == 0)
        .map(|field| String::from_utf8_lossy(field).into_owned());
    let head = fields.next()?;
    let path = fields.next()?;
    if head != "yes" {
        return (head == "no").then_some(Answer::NotADirectory { path });
    }

    let mut entries = Vec::new();
    // A short last record is the tail after the final separator, and never an
    // entry: three fields or nothing.
    while let (Some(found), Some(kind), Some(origin)) =
        (fields.next(), fields.next(), fields.next())
    {
        let found = found.strip_suffix('/').unwrap_or(&found).to_owned();
        entries.push(Dir {
            name: found.rsplit('/').next().unwrap_or_default().to_owned(),
            path: found,
            repo: kind == "repo",
            origin: Some(origin.trim().to_owned()).filter(|url| !url.is_empty()),
        });
    }
    Some(Answer::Listed { path, entries })
}

#[cfg(test)]
// `expect` in a test is a deliberate abort with a message; the workspace lint
// targets library code, where the same call would take the daemon down.
#[allow(clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn listed(stdout: &[u8]) -> (String, Vec<Dir>) {
        match parse(stdout) {
            Some(Answer::Listed { path, entries }) => (path, entries),
            _ => panic!("a listing"),
        }
    }

    #[test]
    fn a_repository_carries_its_origin_and_a_plain_directory_does_not() {
        let (path, entries) = listed(
            b"yes\0/home/u\0/home/u/yantra/\0repo\0https://github.com/o/r.git\0/home/u/scratch/\0dir\0\0",
        );

        assert_eq!(path, "/home/u");
        assert_eq!(
            entries,
            vec![
                Dir {
                    path: "/home/u/yantra".to_owned(),
                    name: "yantra".to_owned(),
                    repo: true,
                    origin: Some("https://github.com/o/r.git".to_owned()),
                },
                Dir {
                    path: "/home/u/scratch".to_owned(),
                    name: "scratch".to_owned(),
                    repo: false,
                    origin: None,
                },
            ]
        );
    }

    /// The two `None`s [`crate::probe`] keeps together, kept together here: a
    /// repository with no `origin` is still a repository.
    #[test]
    fn a_repository_with_no_origin_is_still_marked_as_one() {
        let (_, entries) = listed(b"yes\0/home/u\0/home/u/local/\0repo\0\0");

        assert!(entries[0].repo);
        assert_eq!(entries[0].origin, None);
    }

    /// An empty directory and a directory that is not there are different
    /// answers, and only one of them is a reason to stop (D4 §5).
    #[test]
    fn an_empty_directory_lists_and_a_missing_one_refuses() {
        let (path, entries) = listed(b"yes\0/home/u/empty\0");
        assert_eq!(path, "/home/u/empty");
        assert!(entries.is_empty());

        assert!(matches!(
            parse(b"no\0/home/u/typo\0"),
            Some(Answer::NotADirectory { path }) if path == "/home/u/typo"
        ));
    }

    /// A name may hold anything but `/` and NUL, so the record separator is the
    /// one byte it cannot hold — and a newline in a name is not two rows.
    #[test]
    fn a_name_holding_a_newline_arrives_whole() {
        let (_, entries) = listed(b"yes\0/home/u\0/home/u/two\nlines/\0dir\0\0");

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "two\nlines");
        assert_eq!(entries[0].path, "/home/u/two\nlines");
    }

    /// Neither *absent* nor *empty*: nothing was decided, and saying either
    /// would be a claim this build did not earn (R-23).
    #[test]
    fn an_answer_that_cannot_be_read_is_not_read_as_an_absence() {
        assert!(parse(b"").is_none());
        assert!(parse(b"maybe\0/home/u\0").is_none());
    }

    /// A path is a value from a person, so it reaches a remote shell quoted —
    /// the crate's rule for anything that gets there.
    #[test]
    fn a_path_is_quoted_before_it_reaches_a_shell() {
        let built = command(Some("/tmp/a b; rm -rf /"));
        assert!(
            built.contains("b='/tmp/a b; rm -rf /'\n"),
            "the whole path is one quoted word: {built}"
        );

        let quoted = command(Some("/tmp/it's"));
        assert!(quoted.contains(r"b='/tmp/it'\''s'"), "{quoted}");
    }

    /// D4 §3: the daemon never composes a path, so the far side's own `$HOME`
    /// is the only default there is.
    #[test]
    fn no_path_lists_the_machines_own_home() {
        assert!(command(None).contains("b=\"$HOME\""));
    }
}
