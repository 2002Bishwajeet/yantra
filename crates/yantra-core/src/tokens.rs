//! What a session spent, in tokens.
//!
//! Every figure is one Claude Code recorded in the transcript [`crate::logs`]
//! reads. Nothing is computed from a rate, and nothing could be: the file
//! carries no cost field anywhere.
//!
//! Two measurements shape the module, both taken over every transcript on the
//! machine that wrote it (2026-08-10, Claude Code 2.1.220–2.1.223).
//!
//! **One API response is written as several records.** Claude Code writes a
//! record per content block and gives each the same `message.usage` and the
//! same `requestId`. One 133-record session is 66 responses, and summing per
//! record reported 13,968,868 cache-read tokens against a true 7,492,711. So
//! `requestId` is what collapses them — it is read for that and nothing else,
//! and never reaches a caller.
//!
//! **A record names the four counts twice**: once as the response's own total
//! and again inside `iterations`, the per-call breakdown. The first occurrence
//! is the total, checked against all 11,447 usage-bearing records here, where
//! it equalled the parsed JSON every time.
//!
//! What crosses the wire is therefore numbers rather than records — a `grep -o`
//! for the five field names, with `-n` grouping them by the record they came
//! from. That also keeps the conversation on the far side, and safely: an
//! unescaped `"input_tokens":` cannot occur inside a JSON string, so a
//! byte-level filter can match nothing but the fields it names.

use crate::logs::{self, Error, NO_TRANSCRIPT};
use crate::ssh::{self, Exec, Ssh};
use crate::workspace;
use std::collections::HashSet;

/// The four counts a session's transcript records, summed.
///
/// Deliberately no total: cache reads and output tokens are not the same unit
/// of anything, and adding them would invent a figure the file does not hold.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Spend {
    pub path: String,
    /// API responses, not records — see the module header.
    pub responses: usize,
    pub input: u64,
    pub output: u64,
    pub cache_write: u64,
    pub cache_read: u64,
}

/// What the agent working in workspace `name` has spent.
pub async fn tokens(name: &str) -> Result<Spend, Error> {
    let workspace = workspace::load(name)?;
    let machine = ssh::machine_at(&workspace.machine).ok_or(Error::NoStateDir)?;
    let ssh = Ssh::new(machine)?;
    let session = logs::session_of(&ssh, &workspace.name).await;
    spent(&ssh, &workspace.repo.to_string_lossy(), session.as_deref()).await
}

/// The testable half, once a machine can be reached.
///
/// It reports [`logs::Error`] rather than an error type of its own: this asks
/// the same file for the same session by the same script, so every way it can
/// fail is one `logs` already names, down to the wording of *no transcript*.
pub async fn spent<E: Exec>(exec: &E, repo: &str, session: Option<&str>) -> Result<Spend, Error> {
    let out = exec.exec(&probe(repo, session)).await?;
    if out.status == NO_TRANSCRIPT {
        return Err(match session {
            Some(session) => Error::NoTurnYet {
                repo: repo.to_owned(),
                session: session.to_owned(),
            },
            None => Error::NoTranscript {
                repo: repo.to_owned(),
            },
        });
    }
    if !out.success() {
        return Err(Error::Probe {
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_owned(),
        });
    }

    let text = String::from_utf8_lossy(&out.stdout);
    let (path, counts) = text.split_once('\n').ok_or(Error::Unreadable)?;
    Ok(tally(path, counts))
}

/// The path, then one `<record>:"<field>":<value>` line per field found.
///
/// `|| :` because a session that has spent nothing is an answer and not a
/// failure — `grep` exits 1 when it matches nothing, and it is the last command.
fn probe(repo: &str, session: Option<&str>) -> String {
    format!(
        "{locate}\
         printf '%s\\n' \"$f\"\n\
         grep '\"type\":\"assistant\"' \"$f\" \
         | grep -n -o -E '\"(requestId|input_tokens|output_tokens\
         |cache_creation_input_tokens|cache_read_input_tokens)\":(\"[^\"]*\"|[0-9]+)' || :\n",
        locate = logs::locate(repo, session),
    )
}

/// One record's fields, in the order `grep` found them.
#[derive(Default)]
struct Reply {
    request: Option<String>,
    input: Option<u64>,
    output: Option<u64>,
    cache_write: Option<u64>,
    cache_read: Option<u64>,
}

impl Reply {
    /// First occurrence wins: what follows on the same record is `iterations`
    /// repeating the same names for the calls the response was made of.
    fn take(&mut self, field: &str) {
        let Some((key, value)) = field.split_once("\":") else {
            return;
        };
        let slot = match key.trim_start_matches('"') {
            "input_tokens" => &mut self.input,
            "output_tokens" => &mut self.output,
            "cache_creation_input_tokens" => &mut self.cache_write,
            "cache_read_input_tokens" => &mut self.cache_read,
            "requestId" => {
                self.request
                    .get_or_insert_with(|| value.trim_matches('"').to_owned());
                return;
            }
            _ => return,
        };
        if slot.is_none() {
            *slot = value.parse().ok();
        }
    }

    fn counted(&self) -> bool {
        self.input.is_some()
            || self.output.is_some()
            || self.cache_write.is_some()
            || self.cache_read.is_some()
    }
}

fn tally(path: &str, counts: &str) -> Spend {
    let mut spend = Spend {
        path: path.to_owned(),
        ..Spend::default()
    };
    let mut seen = HashSet::new();
    let mut record = None;
    let mut reply = Reply::default();

    for line in counts.lines() {
        let Some((at, field)) = line.split_once(':') else {
            continue;
        };
        if record != Some(at) {
            add(&mut spend, &mut seen, std::mem::take(&mut reply));
            record = Some(at);
        }
        reply.take(field);
    }
    add(&mut spend, &mut seen, reply);
    spend
}

/// A record whose response has already been counted adds nothing, because the
/// two carry the same usage and one of them is the same API call written twice.
fn add(spend: &mut Spend, seen: &mut HashSet<String>, reply: Reply) {
    if !reply.counted() {
        return;
    }
    if let Some(request) = reply.request
        && !seen.insert(request)
    {
        return;
    }
    spend.responses = spend.responses.saturating_add(1);
    spend.input = spend.input.saturating_add(reply.input.unwrap_or(0));
    spend.output = spend.output.saturating_add(reply.output.unwrap_or(0));
    spend.cache_write = spend
        .cache_write
        .saturating_add(reply.cache_write.unwrap_or(0));
    spend.cache_read = spend
        .cache_read
        .saturating_add(reply.cache_read.unwrap_or(0));
}

#[cfg(test)]
// `expect` in a test is a deliberate abort with a message; the workspace lint
// targets code that ships, where the same call would take the process down.
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    /// Two records of one API response, byte for byte as the probe printed them
    /// against a real transcript on 2026-08-10. Each names the four counts
    /// twice — the response's own totals, then the single `iterations` entry —
    /// and both carry the same `requestId`.
    const ONE_RESPONSE: &str = "\
1:\"input_tokens\":2
1:\"cache_creation_input_tokens\":40353
1:\"cache_read_input_tokens\":0
1:\"output_tokens\":200
1:\"input_tokens\":2
1:\"output_tokens\":200
1:\"cache_read_input_tokens\":0
1:\"cache_creation_input_tokens\":40353
1:\"requestId\":\"req_011Cdjz3sxeFdmZwvK8L4Gs7\"
2:\"input_tokens\":2
2:\"cache_creation_input_tokens\":40353
2:\"cache_read_input_tokens\":0
2:\"output_tokens\":200
2:\"input_tokens\":2
2:\"output_tokens\":200
2:\"cache_read_input_tokens\":0
2:\"cache_creation_input_tokens\":40353
2:\"requestId\":\"req_011Cdjz3sxeFdmZwvK8L4Gs7\"
";

    /// The measurement the module exists to get right: 18 lines, two records,
    /// **one** response, and the totals are that response's — not twice them,
    /// and not four times them once `iterations` is counted too.
    #[test]
    fn one_response_written_twice_is_counted_once() {
        let spend = tally("/h/.claude/projects/-srv-repo/s.jsonl", ONE_RESPONSE);
        assert_eq!(spend.responses, 1);
        assert_eq!(spend.input, 2);
        assert_eq!(spend.output, 200);
        assert_eq!(spend.cache_write, 40_353);
        assert_eq!(spend.cache_read, 0);
        assert_eq!(spend.path, "/h/.claude/projects/-srv-repo/s.jsonl");
    }

    /// Different requests are different spend, however alike the numbers look.
    #[test]
    fn separate_responses_are_added_up() {
        let counts = "\
1:\"input_tokens\":2\n\
1:\"cache_creation_input_tokens\":465\n\
1:\"cache_read_input_tokens\":40353\n\
1:\"output_tokens\":75\n\
1:\"requestId\":\"req_A\"\n\
2:\"input_tokens\":2\n\
2:\"cache_creation_input_tokens\":465\n\
2:\"cache_read_input_tokens\":40353\n\
2:\"output_tokens\":75\n\
2:\"requestId\":\"req_B\"\n";
        let spend = tally("/x", counts);
        assert_eq!(spend.responses, 2);
        assert_eq!(spend.input, 4);
        assert_eq!(spend.output, 150);
        assert_eq!(spend.cache_write, 930);
        assert_eq!(spend.cache_read, 80_706);
    }

    /// The six records here with no `requestId` are Claude Code's "No response
    /// requested." replies, and they carry four zeroes. Nothing joins them, so
    /// each is its own response rather than one that swallows the others.
    #[test]
    fn a_record_with_no_request_id_still_counts_for_itself() {
        let counts = "\
1:\"input_tokens\":0\n\
1:\"output_tokens\":0\n\
1:\"cache_creation_input_tokens\":0\n\
1:\"cache_read_input_tokens\":0\n\
2:\"input_tokens\":0\n\
2:\"output_tokens\":0\n\
2:\"cache_creation_input_tokens\":0\n\
2:\"cache_read_input_tokens\":0\n";
        let spend = tally("/x", counts);
        assert_eq!(spend.responses, 2);
        assert_eq!(spend.input, 0);
    }

    /// A session that has said nothing yet has spent nothing, which is a number
    /// rather than a failure — `grep` finding no match is the ordinary case.
    #[test]
    fn a_transcript_with_no_assistant_record_spends_nothing() {
        let spend = tally("/x", "");
        assert_eq!(
            spend,
            Spend {
                path: "/x".to_owned(),
                ..Spend::default()
            }
        );
    }

    /// Someone else's format: a field this version does not act on is skipped
    /// rather than parsed, and a line that is not a count is not a record.
    #[test]
    fn unknown_fields_and_junk_lines_are_ignored() {
        let counts = "\
1:\"service_tier\":\"standard\"\n\
1:\"input_tokens\":7\n\
grep: /h/x.jsonl: Permission denied\n\
2:\"web_search_requests\":3\n";
        let spend = tally("/x", counts);
        assert_eq!(spend.responses, 1);
        assert_eq!(spend.input, 7);
    }

    /// The script has to find the same file `logs` finds, and by the same rules
    /// — including the quoting that keeps a hostile session id off the shell.
    #[test]
    fn the_probe_asks_for_the_named_session_and_ships_no_conversation() {
        let probe = probe("/srv/repo", Some("x'; touch /tmp/pwned; '"));
        assert!(
            probe.contains(&format!(
                "f=$d/{}.jsonl\n",
                r"'x'\''; touch /tmp/pwned; '\'''"
            )),
            "{probe}"
        );
        assert!(probe.contains("grep -n -o -E"), "{probe}");
        assert!(
            !probe.contains("tail -n"),
            "shipping records rather than counts would carry the conversation with them: {probe}"
        );
    }
}
