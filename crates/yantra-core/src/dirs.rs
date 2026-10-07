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
//! **The whole filesystem, one level at a time** (Y-414, owner, 2026-09-29).
//! D4 §3.1 listed directories only and skipped dotfiles. The owner reversed
//! that: a listing now holds hidden entries, files, and directories the login
//! account cannot enter, each marked, so the picker decides what to show.
//!
//! **This is a read, and it is reached over a `POST`**, for [`crate::probe`]'s
//! reason and on the same ruling ([ADR-0019]): the answer depends on a path
//! nobody has typed yet, so no snapshot can hold it.
//!
//! [D4]: ../../../docs/archive/design/04-workspace-creation.md
//! [ADR-0019]: ../../../docs/adr/0019-a-probe-that-asks-a-machine-is-a-post.md

use crate::ssh::{self, Exec, Ssh};
use crate::tmux;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listing {
    pub machine: String,
    /// The directory that was listed, as the far side spells it — which is how
    /// a caller that named no path learns where that machine's `$HOME` is.
    pub path: String,
    /// `false` when the login account cannot read or enter `path`. The listing
    /// is then empty, and that is not the same answer as an empty directory.
    pub access: bool,
    /// Directories first, then files; each group in the far side's glob order,
    /// with dotfiles after the rest.
    pub entries: Vec<Entry>,
    /// The far side stopped at [`CAP`] entries and there were more.
    pub truncated: bool,
}

/// A directory with more entries than this is cut short: a person does not
/// scroll past it, and typing a path still reaches the rest.
pub const CAP: usize = 2000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// A symlink to a directory is one, because `cd` treats it as one.
    Dir,
    /// Anything else, a broken symlink included. Never a choice.
    File,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// Absolute, as the far side wrote it.
    pub path: String,
    /// The last segment, which is what a picker draws.
    pub name: String,
    pub kind: Kind,
    /// Whether the login account can list and enter this directory. Always
    /// `true` for a file, which nothing here opens.
    pub access: bool,
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

    #[error(
        "`{name}` is not a usable directory name: one segment, no leading dot, and only letters, \
         digits and `-_.+@`"
    )]
    InvalidName { name: String },

    /// The machine answered, and what it said is that the directory could not
    /// be made there — a file in the way, or a parent that is not there.
    #[error("{machine} could not make {path}: {reason}")]
    NotMade {
        machine: String,
        path: String,
        reason: String,
    },
}

/// `path` of `None` is the machine's own `$HOME`, which is the only directory
/// Yantra can name without asking. Nothing here composes a path.
pub async fn list(machine: &str, path: Option<&str>) -> Result<Listing, Error> {
    let ssh = Ssh::new(ssh::machine_at(machine).ok_or(Error::NoStateDir)?)?;
    list_on(&ssh, machine, path).await
}

/// Makes one directory called `name` under `path` and lists `path` again, so a
/// picker draws what it just made (Y-344). A directory already there is the
/// state asked for (§B4), and a parent that is not there is a refusal.
pub async fn make(machine: &str, path: Option<&str>, name: &str) -> Result<Listing, Error> {
    let ssh = Ssh::new(ssh::machine_at(machine).ok_or(Error::NoStateDir)?)?;
    make_on(&ssh, machine, path, name).await
}

pub async fn make_on<E: Exec>(
    exec: &E,
    machine: &str,
    path: Option<&str>,
    name: &str,
) -> Result<Listing, Error> {
    if !valid_name(name) {
        return Err(Error::InvalidName {
            name: name.to_owned(),
        });
    }
    let out = exec.exec(&make_command(path, name)).await?;
    if !out.success() {
        return Err(Error::NotMade {
            machine: machine.to_owned(),
            path: format!("{}/{name}", path.unwrap_or("~")),
            reason: String::from_utf8_lossy(&out.stderr).trim().to_owned(),
        });
    }
    list_on(exec, machine, path).await
}

/// One segment (I-24): no `/`, no `..`, and no leading dot, because the
/// picker hides dotfiles by default and would not show what it just made.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && !name.starts_with('-')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.+@".contains(c))
}

fn base(path: Option<&str>) -> String {
    match path {
        Some(path) => tmux::sq(path),
        None => r#""$HOME""#.to_owned(),
    }
}

/// `mkdir -p` under a parent that was checked first: `-p` makes an existing
/// directory a success rather than a refusal, and the check keeps it from
/// making the parent too.
fn make_command(path: Option<&str>, name: &str) -> String {
    format!(
        "b={}\ntest -d \"$b\" || {{ echo \"no directory at $b\" >&2; exit 1; }}\nmkdir -p -- \"$b\"/{}",
        base(path),
        tmux::sq(name)
    )
}

/// The testable half, driven by the container fixture.
pub async fn list_on<E: Exec>(
    exec: &E,
    machine: &str,
    path: Option<&str>,
) -> Result<Listing, Error> {
    let out = exec.exec(&command(path)).await?;
    match parse(&out.stdout) {
        Some(Answer::Listed {
            path,
            access,
            entries,
            truncated,
        }) => Ok(Listing {
            machine: machine.to_owned(),
            path,
            access,
            entries,
            truncated,
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
/// **Records are NUL-separated**, so a name holding a newline or a tab arrives
/// whole rather than as two half rows — a path is the one string a filesystem
/// lets hold anything but `/` and NUL. `git`'s own failure is swallowed as
/// [`crate::probe`] swallows it.
///
/// The three globs match every name but `.` and `..`; a glob that matches
/// nothing stays literal, and the `-e`/`-L` test drops it. Only `test` builtins
/// classify, so GNU and BSD far sides answer alike. `$p` gives the base exactly
/// one trailing slash, so `/` lists as `/bin` rather than `//bin`.
///
/// **`ls` asks whether the read itself works** (Y-458): macOS refuses an ssh
/// login `~/Documents` with mode bits that say yes, and the glob then reads as
/// an empty folder.
fn command(path: Option<&str>) -> String {
    let base = base(path);
    format!(
        r#"b={base}
if ! test -d "$b"; then
  printf 'no\0%s\0' "$b"
elif ! {{ [ -r "$b" ] && [ -x "$b" ] && ls -A "$b" >/dev/null 2>&1; }}; then
  printf 'shut\0%s\0' "$b"
else
  printf 'yes\0%s\0' "$b"
  case "$b" in */) p=$b;; *) p=$b/;; esac
  n=0
  for f in "$p"* "$p".[!.]* "$p"..?*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    if [ "$n" -ge {CAP} ]; then printf '\0more\0\0'; break; fi
    n=$((n + 1))
    if [ ! -d "$f" ]; then
      printf '%s\0file\0\0' "$f"
    elif ! {{ [ -r "$f" ] && [ -x "$f" ]; }}; then
      printf '%s\0shut\0\0' "$f"
    elif [ -d "$f/.git" ]; then
      printf '%s\0repo\0%s\0' "$f" "$(git -C "$f" remote get-url origin 2>/dev/null)"
    else
      printf '%s\0dir\0\0' "$f"
    fi
  done
fi"#
    )
}

enum Answer {
    Listed {
        path: String,
        access: bool,
        entries: Vec<Entry>,
        truncated: bool,
    },
    NotADirectory {
        path: String,
    },
}

fn parse(stdout: &[u8]) -> Option<Answer> {
    let mut fields = stdout
        .split(|byte| *byte == 0)
        .map(|field| String::from_utf8_lossy(field).into_owned());
    let head = fields.next()?;
    let path = fields.next()?;
    let access = match head.as_str() {
        "yes" => true,
        "shut" => false,
        "no" => return Some(Answer::NotADirectory { path }),
        _ => return None,
    };

    let mut entries = Vec::new();
    let mut truncated = false;
    // A short last record is the tail after the final separator, and never an
    // entry: three fields or nothing.
    while let (Some(found), Some(kind), Some(origin)) =
        (fields.next(), fields.next(), fields.next())
    {
        let (kind, access, repo) = match kind.as_str() {
            "dir" => (Kind::Dir, true, false),
            "repo" => (Kind::Dir, true, true),
            "shut" => (Kind::Dir, false, false),
            "file" => (Kind::File, true, false),
            "more" => {
                truncated = true;
                continue;
            }
            _ => return None,
        };
        let found = found.strip_suffix('/').unwrap_or(&found).to_owned();
        entries.push(Entry {
            name: found.rsplit('/').next().unwrap_or_default().to_owned(),
            path: found,
            kind,
            access,
            repo,
            origin: Some(origin.trim().to_owned()).filter(|url| !url.is_empty()),
        });
    }
    // Stable, so each group keeps the glob's order.
    entries.sort_by_key(|entry| entry.kind == Kind::File);
    Some(Answer::Listed {
        path,
        access,
        entries,
        truncated,
    })
}

#[cfg(test)]
// `expect` in a test is a deliberate abort with a message; the workspace lint
// targets library code, where the same call would take the daemon down.
#[allow(clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn listed(stdout: &[u8]) -> (String, Vec<Entry>) {
        match parse(stdout) {
            Some(Answer::Listed { path, entries, .. }) => (path, entries),
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
                Entry {
                    path: "/home/u/yantra".to_owned(),
                    name: "yantra".to_owned(),
                    kind: Kind::Dir,
                    access: true,
                    repo: true,
                    origin: Some("https://github.com/o/r.git".to_owned()),
                },
                Entry {
                    path: "/home/u/scratch".to_owned(),
                    name: "scratch".to_owned(),
                    kind: Kind::Dir,
                    access: true,
                    repo: false,
                    origin: None,
                },
            ]
        );
    }

    /// Y-414: files and closed directories are listed and marked, and every
    /// directory comes before every file whatever order the glob gave.
    #[test]
    fn files_and_closed_directories_are_marked_and_directories_come_first() {
        let (_, entries) = listed(
            b"yes\0/srv\0/srv/notes.txt\0file\0\0/srv/data\0dir\0\0/srv/lost+found\0shut\0\0/srv/.cache\0dir\0\0",
        );

        let seen: Vec<(&str, Kind, bool)> = entries
            .iter()
            .map(|entry| (entry.name.as_str(), entry.kind, entry.access))
            .collect();
        assert_eq!(
            seen,
            [
                ("data", Kind::Dir, true),
                ("lost+found", Kind::Dir, false),
                (".cache", Kind::Dir, true),
                ("notes.txt", Kind::File, true),
            ]
        );
    }

    /// A directory the account cannot read is a listing that says so, not an
    /// empty directory and not a refusal.
    #[test]
    fn a_directory_that_cannot_be_read_is_a_closed_listing() {
        match parse(b"shut\0/root\0") {
            Some(Answer::Listed {
                path,
                access,
                entries,
                ..
            }) => {
                assert_eq!(path, "/root");
                assert!(!access);
                assert!(entries.is_empty());
            }
            _ => panic!("a closed listing"),
        }
    }

    #[test]
    fn the_cap_marker_is_not_an_entry() {
        match parse(b"yes\0/big\0/big/a\0file\0\0\0more\0\0") {
            Some(Answer::Listed {
                entries, truncated, ..
            }) => {
                assert!(truncated);
                assert_eq!(entries.len(), 1);
            }
            _ => panic!("a listing"),
        }
        match parse(b"yes\0/big\0/big/a\0file\0\0") {
            Some(Answer::Listed { truncated, .. }) => assert!(!truncated),
            _ => panic!("a listing"),
        }
    }

    /// The command and the parser are one build, so a kind neither knows is a
    /// far side that answered something else (R-23).
    #[test]
    fn an_unknown_kind_is_unreadable() {
        assert!(parse(b"yes\0/x\0/x/a\0socket\0\0").is_none());
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
        assert!(make_command(None, "x").contains("b=\"$HOME\""));
    }

    /// One segment or nothing: a name that is a path would make a directory
    /// somewhere the listing beside it never showed.
    #[test]
    fn a_directory_name_is_one_plain_segment() {
        for good in ["Github", "my-repo_2", "v1.0", "a+b@c"] {
            assert!(valid_name(good), "{good}");
        }
        for bad in [
            "", ".", "..", ".hidden", "-x", "a/b", "/abs", "~", "a b", "a;b", "$HOME", "`id`",
            "a'b", "a\nb", "a*",
        ] {
            assert!(!valid_name(bad), "{bad:?} must be refused");
        }
    }

    #[test]
    fn the_make_command_quotes_both_halves() {
        assert_eq!(
            make_command(Some("/home/u/it's"), "new"),
            "b='/home/u/it'\\''s'\ntest -d \"$b\" || { echo \"no directory at $b\" >&2; exit 1; }\nmkdir -p -- \"$b\"/'new'"
        );
    }
}
