//! What the Chat composer offers after `@` and `$` (Y-562): the files of a
//! thread's worktree and the skills its harness can load.
//!
//! **One round trip, asked for and never polled** ([ADR-0019]): the composer
//! asks once when a person types a trigger. A chat always runs in a git
//! worktree, so the files are git's list and nothing walks the disk.
//!
//! Each harness's skill roots are read from its own docs (accessed
//! 2026-11-03). The Claude roots match T3 Code's `ClaudeSkills.ts` at 810e8f6.
//!
//! [ADR-0019]: ../../../docs/adr/0019-a-probe-that-asks-a-machine-is-a-post.md

use std::collections::HashSet;

use crate::acp::Harness;
use crate::clone::destination;
use crate::delegate::{self, NOT_A_REPO};
use crate::ssh::{self, Exec, Ssh};
use crate::thread::{self, Place};
use crate::tmux::sq;
use crate::workspace;

/// A worktree with more files than this is cut short: a person types more of
/// the name before they scroll that far.
pub const CAP: usize = 5000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mentions {
    /// Tracked and untracked files, relative to the directory, with ignored
    /// files left out.
    pub files: Vec<String>,
    /// The far side had more than [`CAP`] files.
    pub truncated: bool,
    /// Sorted by name, one per name.
    pub skills: Vec<Skill>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    User,
    Project,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub scope: Scope,
    /// What the composer inserts: `$<name>`.
    pub mention: String,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Ssh(#[from] ssh::Error),

    #[error("`{dir}` is not a git work tree on that machine")]
    NotARepo { dir: String },

    #[error("the machine answered a mention list this build could not read: {said}")]
    Unreadable { said: String },

    #[error(transparent)]
    Workspace(#[from] workspace::Error),

    #[error(transparent)]
    Thread(#[from] delegate::Error),

    #[error("the workspace has no thread `{thread}`")]
    UnknownThread { thread: String },

    #[error("could not determine a directory for ssh control sockets")]
    NoStateDir,
}

/// Where each harness looks for `<root>/<folder>/SKILL.md`, in the order a
/// duplicate name is settled. `$d` is the directory asked about. Grok has none.
fn roots(harness: Option<Harness>) -> &'static [(Scope, &'static str)] {
    use Scope::{Project, User};
    match harness {
        None => &[
            (User, "\"$HOME\"/.claude/skills"),
            (Project, "\"$d\"/.claude/skills"),
        ],
        Some(Harness::Codex) => &[
            (User, "\"${CODEX_HOME:-$HOME/.codex}\"/skills"),
            (User, "\"$HOME\"/.agents/skills"),
            (Project, "\"$d\"/.agents/skills"),
        ],
        Some(Harness::Opencode) => &[
            (User, "\"$HOME\"/.config/opencode/skills"),
            (User, "\"$HOME\"/.claude/skills"),
            (User, "\"$HOME\"/.agents/skills"),
            (Project, "\"$d\"/.opencode/skills"),
            (Project, "\"$d\"/.claude/skills"),
            (Project, "\"$d\"/.agents/skills"),
        ],
        Some(Harness::Gemini) => &[
            (User, "\"$HOME\"/.agents/skills"),
            (User, "\"$HOME\"/.gemini/skills"),
            (Project, "\"$d\"/.agents/skills"),
            (Project, "\"$d\"/.gemini/skills"),
        ],
        Some(Harness::Grok) => &[],
    }
}

/// The mentions of workspace `name`: in `thread`'s worktree when one is named,
/// and in the workspace's repository otherwise. `None` is Claude.
pub async fn for_workspace(
    name: &str,
    thread: Option<&str>,
    harness: Option<Harness>,
) -> Result<Mentions, Error> {
    let (ssh, dir, _) = directory(name, thread).await?;
    mentions(&ssh, &dir, harness).await
}

/// The machine, the directory and the thread [`for_workspace`] reads; the
/// dictation's hotwords read the same one (ADR-0043 §5).
pub(crate) async fn directory(
    name: &str,
    thread: Option<&str>,
) -> Result<(Ssh, String, Option<Place>), Error> {
    let workspace = workspace::load(name)?;
    let ssh = Ssh::new(ssh::machine_at(&workspace.machine).ok_or(Error::NoStateDir)?)?;
    let Some(id) = thread else {
        return Ok((ssh, workspace.repo.to_string_lossy().into_owned(), None));
    };
    let place = thread::list(&ssh, &workspace)
        .await?
        .into_iter()
        .find(|place| thread::name(place) == id)
        .ok_or_else(|| Error::UnknownThread {
            thread: id.to_owned(),
        })?;
    Ok((ssh, place.worktree.clone(), Some(place)))
}

/// One remote script (I-26: it rides the base64 envelope, and `dir` is quoted).
pub async fn mentions<E: Exec>(
    exec: &E,
    dir: &str,
    harness: Option<Harness>,
) -> Result<Mentions, Error> {
    let out = exec.exec(&command(dir, harness)).await?;
    if out.status == NOT_A_REPO {
        return Err(Error::NotARepo {
            dir: dir.to_owned(),
        });
    }
    if !out.success() {
        return Err(Error::Unreadable {
            said: delegate::said(&out.stderr),
        });
    }
    parse(&out.stdout).ok_or_else(|| Error::Unreadable {
        said: "no separator between the files and the skills".to_owned(),
    })
}

/// The files, one per line and cut one past [`CAP`] so a longer list shows,
/// then a NUL, then `scope NUL path NUL front-matter NUL` per skill. Only the
/// front matter crosses the wire, never a skill's body.
fn command(dir: &str, harness: Option<Harness>) -> String {
    let mut script = format!(
        "d={}\n\
         git -C \"$d\" rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit {NOT_A_REPO}\n\
         git -C \"$d\" -c core.quotePath=false ls-files --cached --others --exclude-standard \
         | head -n {}\n\
         printf '\\0'\n",
        destination(dir),
        CAP + 1
    );
    for (scope, root) in roots(harness) {
        let scope = match scope {
            Scope::User => "user",
            Scope::Project => "project",
        };
        script.push_str(&format!(
            "for f in {root}/*/SKILL.md; do [ -f \"$f\" ] || continue; \
             printf '%s\\0%s\\0' {} \"$f\"; \
             awk 'NR==1{{if($0!~/^---[[:space:]]*$/)exit;next}} /^---[[:space:]]*$/{{exit}} {{print}}' \"$f\"; \
             printf '\\0'; done\n",
            sq(scope)
        ));
    }
    script
}

fn parse(stdout: &[u8]) -> Option<Mentions> {
    let split = stdout.iter().position(|&byte| byte == 0)?;
    let mut files: Vec<String> = String::from_utf8_lossy(&stdout[..split])
        .lines()
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect();
    let truncated = files.len() > CAP;
    files.truncate(CAP);

    let mut fields = stdout[split + 1..]
        .split(|&byte| byte == 0)
        .map(|field| String::from_utf8_lossy(field).into_owned());
    let mut seen = HashSet::new();
    let mut skills = Vec::new();
    while let (Some(scope), Some(path), Some(front)) = (fields.next(), fields.next(), fields.next())
    {
        let scope = match scope.as_str() {
            "user" => Scope::User,
            "project" => Scope::Project,
            _ => return None,
        };
        let folder = path.rsplit('/').nth(1).unwrap_or_default();
        let (name, description) = front_matter(&front);
        let name = name.unwrap_or_else(|| folder.to_owned());
        if name.is_empty() || !seen.insert(name.clone()) {
            continue;
        }
        skills.push(Skill {
            mention: format!("${name}"),
            name,
            description: description.unwrap_or_default(),
            scope,
        });
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    Some(Mentions {
        files,
        truncated,
        skills,
    })
}

/// `name:` and `description:` from YAML front matter. A `>` or `|` value is
/// the indented lines below it, joined by spaces.
fn front_matter(text: &str) -> (Option<String>, Option<String>) {
    let lines: Vec<&str> = text
        .lines()
        .map(|line| line.trim_end_matches('\r'))
        .collect();
    let value = |key: &str| {
        let at = lines.iter().position(|line| {
            line.strip_prefix(key)
                .is_some_and(|rest| rest.starts_with(':'))
        })?;
        let raw = lines[at][key.len() + 1..].trim();
        let value = if raw.is_empty() || raw.starts_with('>') || raw.starts_with('|') {
            lines[at + 1..]
                .iter()
                .take_while(|line| line.is_empty() || line.starts_with([' ', '\t']))
                .map(|line| line.trim())
                .filter(|line| !line.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        } else {
            unquote(raw).to_owned()
        };
        Some(value).filter(|value| !value.is_empty())
    };
    (value("name"), value("description"))
}

fn unquote(raw: &str) -> &str {
    ['"', '\'']
        .iter()
        .find_map(|quote| raw.strip_prefix(*quote)?.strip_suffix(*quote))
        .unwrap_or(raw)
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    fn record(scope: &str, path: &str, front: &str) -> String {
        format!("{scope}\0{path}\0{front}\0")
    }

    fn parsed(files: &str, skills: &[String]) -> Mentions {
        parse(format!("{files}\0{}", skills.concat()).as_bytes()).expect("a listing")
    }

    #[test]
    fn front_matter_gives_the_name_and_the_description() {
        let found = parsed(
            "src/main.rs\nREADME.md\n",
            &[record(
                "user",
                "/home/u/.claude/skills/review/SKILL.md",
                "name: code-review\ndescription: \"Reviews a diff.\"\nallowed-tools: Read\n",
            )],
        );
        assert_eq!(found.files, ["src/main.rs", "README.md"]);
        assert!(!found.truncated);
        assert_eq!(
            found.skills,
            [Skill {
                name: "code-review".into(),
                description: "Reviews a diff.".into(),
                scope: Scope::User,
                mention: "$code-review".into(),
            }]
        );
    }

    #[test]
    fn a_folded_description_is_joined() {
        let (name, description) =
            front_matter("description: >\n  Reads one file\n  and stops.\nname: 'x'\r\n");
        assert_eq!(name.as_deref(), Some("x"));
        assert_eq!(description.as_deref(), Some("Reads one file and stops."));
    }

    #[test]
    fn a_skill_with_no_name_takes_its_folder() {
        let found = parsed(
            "",
            &[record(
                "project",
                "/r/.claude/skills/deploy-staging/SKILL.md",
                "description: d\n",
            )],
        );
        assert_eq!(found.skills[0].name, "deploy-staging");
        assert_eq!(found.skills[0].mention, "$deploy-staging");
        assert_eq!(found.skills[0].scope, Scope::Project);
        assert!(found.files.is_empty());
    }

    #[test]
    fn the_first_root_wins_a_duplicate_and_the_list_is_sorted() {
        let found = parsed(
            "",
            &[
                record("user", "/h/s/zeta/SKILL.md", "description: z\n"),
                record("user", "/h/s/plan/SKILL.md", "description: mine\n"),
                record("project", "/r/s/plan/SKILL.md", "description: theirs\n"),
                record("project", "/r/s/alpha/SKILL.md", ""),
            ],
        );
        let seen: Vec<(&str, &str, Scope)> = found
            .skills
            .iter()
            .map(|skill| (skill.name.as_str(), skill.description.as_str(), skill.scope))
            .collect();
        assert_eq!(
            seen,
            [
                ("alpha", "", Scope::Project),
                ("plan", "mine", Scope::User),
                ("zeta", "z", Scope::User),
            ]
        );
    }

    #[test]
    fn the_list_is_cut_at_the_cap() {
        let files: String = (0..=CAP).map(|n| format!("f{n}\n")).collect();
        let found = parsed(&files, &[]);
        assert_eq!(found.files.len(), CAP);
        assert!(found.truncated);

        let exact: String = (0..CAP).map(|n| format!("f{n}\n")).collect();
        assert!(!parsed(&exact, &[]).truncated);
    }

    #[test]
    fn an_answer_with_no_separator_or_an_unknown_scope_is_unreadable() {
        assert!(parse(b"a\nb\n").is_none());
        assert!(parse(b"a\n\0team\0/x/s/SKILL.md\0\0").is_none());
    }

    #[test]
    fn the_directory_is_quoted_and_grok_reads_no_skill() {
        let script = command("/srv/it's", Some(Harness::Grok));
        assert!(script.starts_with("d='/srv/it'\\''s'\n"), "{script}");
        assert!(!script.contains("SKILL.md"));
        assert!(command("~/repo", None).starts_with("d=\"$HOME\"/'repo'\n"));
        assert!(command("/r", None).contains("\"$HOME\"/.claude/skills/*/SKILL.md"));
        assert!(command("/r", None).contains("\"$d\"/.claude/skills/*/SKILL.md"));
    }

    struct Answer(ssh::Output);

    impl Exec for Answer {
        async fn exec(&self, _command: &str) -> Result<ssh::Output, ssh::Error> {
            Ok(self.0.clone())
        }
    }

    fn answer(status: i32, stdout: &[u8], stderr: &str) -> Answer {
        Answer(ssh::Output {
            status,
            stdout: stdout.to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        })
    }

    #[tokio::test]
    async fn a_directory_outside_a_repository_and_a_failed_script_are_typed() {
        assert!(matches!(
            mentions(&answer(NOT_A_REPO, b"", ""), "/tmp", None).await,
            Err(Error::NotARepo { dir }) if dir == "/tmp"
        ));
        assert!(matches!(
            mentions(&answer(2, b"", "boom\n"), "/r", None).await,
            Err(Error::Unreadable { said }) if said == "boom"
        ));
        assert!(matches!(
            mentions(&answer(0, b"no separator", ""), "/r", None).await,
            Err(Error::Unreadable { .. })
        ));
    }
}
