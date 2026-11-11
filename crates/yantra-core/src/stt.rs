//! What dictation shares between `yantrad` and `yantra-stt` ([ADR-0043]): the
//! hotword score, the audio cap, and the hotword list built from a workspace.
//!
//! The list is spelled as the person wants it written, because the model
//! writes a hotword as it is spelled (§5). A dash, a slash or a dot in a
//! hotword sprays fragments into other sentences (R26 §4), so no entry has one.
//!
//! [ADR-0043]: ../../../docs/adr/0043-dictation-runs-a-local-speech-model.md

use std::collections::HashSet;

use crate::delegate::{self, NOT_A_REPO};
use crate::logs::Entry;
use crate::mention::{self, Error};
use crate::ssh::Exec;
use crate::thread;

/// At 4.0 the model wrote hotwords nobody said; at 3.0 it wrote none (R26 §4).
pub const HOTWORD_SCORE: f32 = 3.0;

/// 16 kHz mono s16le, the format of ADR-0031 §4.
pub const RATE: usize = 16_000;

/// Sixty seconds of audio: the most one utterance may hold (§4).
pub const MAX_BYTES: usize = 60 * RATE * 2;

/// The longest hotword list sent with one utterance (§5).
pub const MAX_HOTWORDS: usize = 200;

/// How many of the thread's messages are read for identifiers (§5).
pub const MESSAGES: usize = 50;

/// The most files in the index the list reads, as [`mention::CAP`] is.
const FILES: usize = mention::CAP;

/// The most manifests and scripts read, and the most bytes read of each.
const READ: usize = 60;
const READ_BYTES: usize = 64 * 1024;

/// What one remote script says about a directory.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Listing {
    /// Paths in the git index.
    pub files: Vec<String>,
    /// `(path, text)` of each `Cargo.toml`, `package.json`, `justfile` and `*.sh`.
    pub read: Vec<(String, String)>,
}

/// The hotwords for workspace `name`, from `thread`'s worktree and its last
/// [`MESSAGES`] messages when a thread is named.
pub async fn for_workspace(name: &str, thread: Option<&str>) -> Result<Vec<String>, Error> {
    let (ssh, dir, place) = mention::directory(name, thread).await?;
    let listing = listing(&ssh, &dir).await?;
    let said = match &place {
        // A thread with no transcript yet, or an ACP one, has said nothing to read.
        Some(place) => thread::logs(&ssh, place, None, MESSAGES, 0)
            .await
            .map(|transcript| transcript.entries)
            .unwrap_or_default(),
        None => Vec::new(),
    };
    Ok(hotwords(&listing, &said))
}

/// One remote script (I-26: it rides the base64 envelope, and `dir` is quoted).
pub async fn listing<E: Exec>(exec: &E, dir: &str) -> Result<Listing, Error> {
    let out = exec.exec(&command(dir)).await?;
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
        said: "no separator between the files and the manifests".to_owned(),
    })
}

/// The index's paths one per line, a NUL, then `path NUL text NUL` for each
/// file read: the justfile first, then the manifests, then the scripts.
fn command(dir: &str) -> String {
    format!(
        "d={}\n\
         git -C \"$d\" rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit {NOT_A_REPO}\n\
         cd \"$d\" || exit 1\n\
         git -c core.quotePath=false ls-files --cached | head -n {FILES}\n\
         printf '\\0'\n\
         {{ git -c core.quotePath=false ls-files --cached -- justfile Justfile; \
         git -c core.quotePath=false ls-files --cached -- Cargo.toml '*/Cargo.toml' package.json '*/package.json'; \
         git -c core.quotePath=false ls-files --cached -- '*.sh'; }} | head -n {READ} | \
         while IFS= read -r f; do [ -f \"$f\" ] || continue; \
         printf '%s\\0' \"$f\"; head -c {READ_BYTES} \"$f\" | tr -d '\\000'; printf '\\0'; done\n",
        crate::clone::destination(dir),
    )
}

fn parse(stdout: &[u8]) -> Option<Listing> {
    let split = stdout.iter().position(|&byte| byte == 0)?;
    let files = String::from_utf8_lossy(&stdout[..split])
        .lines()
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect();
    let mut fields = stdout[split + 1..]
        .split(|&byte| byte == 0)
        .map(|field| String::from_utf8_lossy(field).into_owned());
    let mut read = Vec::new();
    while let (Some(path), Some(text)) = (fields.next(), fields.next()) {
        read.push((path, text));
    }
    Some(Listing { files, read })
}

/// ADR-0043 §5's order: package names, then the index's file and directory
/// names, then the tools the scripts run, then identifiers the thread used,
/// newest first. The first spelling wins and the list stops at [`MAX_HOTWORDS`].
pub fn hotwords(listing: &Listing, said: &[Entry]) -> Vec<String> {
    let manifests = listing
        .read
        .iter()
        .flat_map(|(path, text)| match name_of(path) {
            "Cargo.toml" => crates(text),
            "package.json" => packages(text),
            _ => Vec::new(),
        });
    let names = listing.files.iter().flat_map(|path| path.split('/'));
    let tools = listing
        .read
        .iter()
        .filter(|(path, _)| {
            matches!(name_of(path), "justfile" | "Justfile") || path.ends_with(".sh")
        })
        .flat_map(|(_, text)| tools(text));
    let words = said.iter().rev().flat_map(|entry| identifiers(&entry.text));

    let mut seen = HashSet::new();
    manifests
        .chain(names.map(str::to_owned))
        .chain(tools)
        .chain(words)
        .filter(|word| usable(word) && seen.insert(word.clone()))
        .take(MAX_HOTWORDS)
        .collect()
}

fn name_of(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// §5: no symbol the model would spray. A leading `_` or bracket sprays as
/// badly as a dash, so a word starts with a letter or a digit.
fn usable(word: &str) -> bool {
    word.starts_with(|c: char| c.is_ascii_alphanumeric())
        && word.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The crate's own name, then every dependency it names, sorted by `toml`.
fn crates(text: &str) -> Vec<String> {
    let Ok(manifest) = text.parse::<toml::Table>() else {
        return Vec::new();
    };
    let mut names = Vec::new();
    if let Some(name) = manifest
        .get("package")
        .and_then(|package| package.get("name"))
        .and_then(|name| name.as_str())
    {
        names.push(name.to_owned());
    }
    let workspace = manifest
        .get("workspace")
        .and_then(|workspace| workspace.as_table());
    for table in [Some(&manifest), workspace].into_iter().flatten() {
        for key in ["dependencies", "dev-dependencies", "build-dependencies"] {
            if let Some(deps) = table.get(key).and_then(|deps| deps.as_table()) {
                names.extend(deps.keys().cloned());
            }
        }
    }
    names
}

fn packages(text: &str) -> Vec<String> {
    let Ok(manifest) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let mut names: Vec<String> = manifest
        .get("name")
        .and_then(|name| name.as_str())
        .map(str::to_owned)
        .into_iter()
        .collect();
    for key in ["dependencies", "devDependencies"] {
        if let Some(deps) = manifest.get(key).and_then(|deps| deps.as_object()) {
            names.extend(deps.keys().cloned());
        }
    }
    names
}

/// Words that start no program, so they are passed over.
const KEYWORDS: &[&str] = &[
    "if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "case", "esac",
];

/// Builtins whose arguments are text, not tools, so they end the command.
const BUILTINS: &[&str] = &[
    "[", "test", "set", "cd", "echo", "printf", "export", "local", "exit", "return", "shift",
];

/// The program and its subcommand at the start of each command, and every
/// flag without its dashes: `cargo nextest run --no-tests=pass` gives
/// `cargo`, `nextest` and `no-tests`, which [`usable`] then drops.
fn tools(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        for command in line.split(['|', ';', '&', '(', ')', '`']) {
            let mut leading = 0;
            for word in command.split_whitespace() {
                let word = word.trim_start_matches('@');
                if KEYWORDS.contains(&word) || (leading == 0 && word.contains('=')) {
                    continue;
                }
                if BUILTINS.contains(&word) {
                    break;
                }
                if let Some(flag) = word.strip_prefix('-') {
                    let flag = flag.trim_start_matches('-');
                    found.push(flag.split('=').next().unwrap_or(flag).to_owned());
                    continue;
                }
                if leading < 2 && word.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    found.push(word.to_owned());
                }
                leading += 1;
            }
        }
    }
    found
}

/// Words that look like code: inside backticks, or with an underscore or a
/// capital after the first letter. The ADR's English word list is not in the
/// tree, and the backticks are where a person writes code.
fn identifiers(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    for (at, span) in text.split('`').enumerate() {
        let quoted = at % 2 == 1;
        for word in span.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')) {
            let Some(first) = word.chars().next() else {
                continue;
            };
            if first.is_ascii_digit() || word.len() < 2 {
                continue;
            }
            let code = word.contains('_') || word.chars().skip(1).any(|c| c.is_ascii_uppercase());
            if quoted || code {
                found.push(word.to_owned());
            }
        }
    }
    found
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use crate::logs::Who;
    use crate::ssh;

    fn entry(text: &str) -> Entry {
        Entry {
            who: Who::User,
            at: None,
            text: text.to_owned(),
            tools: Vec::new(),
        }
    }

    fn listing(files: &[&str], read: &[(&str, &str)]) -> Listing {
        Listing {
            files: files.iter().map(|&file| file.to_owned()).collect(),
            read: read
                .iter()
                .map(|&(path, text)| (path.to_owned(), text.to_owned()))
                .collect(),
        }
    }

    #[test]
    fn the_sources_come_in_the_adrs_order() {
        let found = hotwords(
            &listing(
                &["crates/yantrad/src/main.rs", "justfile"],
                &[
                    ("justfile", "test:\n    cargo nextest run --workspace\n"),
                    (
                        "crates/yantrad/Cargo.toml",
                        "[package]\nname = \"yantrad\"\n[dependencies]\ntokio = \"1\"\naxum = \"0.8\"\n",
                    ),
                    (
                        "web/package.json",
                        r#"{"name":"web","dependencies":{"react":"19"}}"#,
                    ),
                ],
            ),
            &[
                entry("call `spawn_blocking` here"),
                entry("ControlPersist is on"),
            ],
        );
        assert_eq!(
            found,
            [
                "yantrad",
                "axum",
                "tokio",
                "web",
                "react",
                "crates",
                "src",
                "justfile",
                "cargo",
                "nextest",
                "workspace",
                "ControlPersist",
                "spawn_blocking",
            ]
        );
    }

    #[test]
    fn a_dash_a_slash_or_a_dot_is_never_a_hotword() {
        let found = hotwords(
            &listing(
                &["Cargo.toml", "src/chat.rs", "portable-pty"],
                &[
                    (
                        "Cargo.toml",
                        "[package]\nname = \"yantra-core\"\n[dependencies]\nportable-pty = \"0.9\"\n",
                    ),
                    ("ci.sh", "cargo nextest run --no-fail-fast -p yantrad\n"),
                ],
            ),
            &[entry(
                "see `crates/yantra-core/src/stt.rs` and `--no-fail-fast`",
            )],
        );
        for word in &found {
            assert!(!word.contains(['-', '/', '.']), "{word} in {found:?}");
        }
        assert!(found.contains(&"src".to_owned()), "{found:?}");
        assert!(
            found.contains(&"p".to_owned()),
            "a flag loses its dashes: {found:?}"
        );
        assert!(found.contains(&"stt".to_owned()), "{found:?}");
    }

    #[test]
    fn a_word_that_starts_with_a_symbol_is_never_a_hotword() {
        let found = hotwords(
            &listing(
                &[
                    "web/e2e/__screenshots__/a.png",
                    "src/routes/[slug]/(group)/page.tsx",
                    "_private",
                ],
                &[],
            ),
            &[entry("`__init__` and `spawn_blocking` `a__b` `foo_`")],
        );
        for word in [
            "__screenshots__",
            "[slug]",
            "(group)",
            "_private",
            "__init__",
        ] {
            assert!(!found.contains(&word.to_owned()), "{word} in {found:?}");
        }
        for word in &found {
            assert!(
                word.starts_with(|c: char| c.is_ascii_alphanumeric())
                    && word.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'),
                "{word} in {found:?}"
            );
        }
        for word in ["spawn_blocking", "a__b", "foo_", "web", "e2e"] {
            assert!(
                found.contains(&word.to_owned()),
                "{word} missing from {found:?}"
            );
        }
        for word in ["$HOME", "#x", "@x", "{a}", "a\0b", "a b", "é"] {
            assert!(!usable(word), "{word}");
        }
    }

    #[test]
    fn the_case_is_kept_and_a_duplicate_keeps_its_first_place() {
        let found = hotwords(
            &listing(&["Makefile", "tmux", "docs/tmux"], &[]),
            &[entry("`Tmux` and `tmux` and ControlMaster")],
        );
        assert_eq!(found, ["Makefile", "tmux", "docs", "Tmux", "ControlMaster"]);
    }

    #[test]
    fn the_list_stops_at_the_cap() {
        let files: Vec<String> = (0..MAX_HOTWORDS + 50).map(|n| format!("f{n}")).collect();
        let files: Vec<&str> = files.iter().map(String::as_str).collect();
        let found = hotwords(&listing(&files, &[]), &[entry("`late`")]);
        assert_eq!(found.len(), MAX_HOTWORDS);
        assert_eq!(found[0], "f0");
        assert!(!found.contains(&"late".to_owned()));
    }

    #[test]
    fn prose_gives_no_identifier_and_shell_words_give_no_tool() {
        assert!(identifiers("The quick brown fox. I said OK 42 times").contains(&"OK".to_owned()));
        assert_eq!(
            identifiers("The quick brown fox, said I."),
            Vec::<String>::new()
        );
        assert_eq!(
            tools("# cargo build\nif [ -f x ]; then echo hi; fi\nFOO=1 just lint\n"),
            ["just", "lint"]
        );
    }

    #[test]
    fn a_broken_manifest_gives_no_name() {
        assert!(crates("[package\nname = ").is_empty());
        assert!(packages("{").is_empty());
    }

    #[test]
    fn the_answer_is_split_at_the_first_nul() {
        let parsed =
            parse(b"a\nb/c\n\0justfile\0lint:\n\0Cargo.toml\0[package]\0").expect("a listing");
        assert_eq!(parsed.files, ["a", "b/c"]);
        assert_eq!(
            parsed.read,
            [
                ("justfile".to_owned(), "lint:\n".to_owned()),
                ("Cargo.toml".to_owned(), "[package]".to_owned()),
            ]
        );
        assert!(parse(b"no separator").is_none());
    }

    #[test]
    fn the_directory_is_quoted() {
        assert!(command("/srv/it's").starts_with("d='/srv/it'\\''s'\n"));
        assert!(command("~/repo").starts_with("d=\"$HOME\"/'repo'\n"));
    }

    struct Answer(ssh::Output);

    impl Exec for Answer {
        async fn exec(&self, _command: &str) -> Result<ssh::Output, ssh::Error> {
            Ok(self.0.clone())
        }
    }

    #[tokio::test]
    async fn a_directory_outside_a_repository_and_a_failed_script_are_typed() {
        let answer = |status, stderr: &str| {
            Answer(ssh::Output {
                status,
                stdout: Vec::new(),
                stderr: stderr.as_bytes().to_vec(),
            })
        };
        assert!(matches!(
            super::listing(&answer(NOT_A_REPO, ""), "/tmp").await,
            Err(Error::NotARepo { dir }) if dir == "/tmp"
        ));
        assert!(matches!(
            super::listing(&answer(2, "boom\n"), "/r").await,
            Err(Error::Unreadable { said }) if said == "boom"
        ));
    }
}
