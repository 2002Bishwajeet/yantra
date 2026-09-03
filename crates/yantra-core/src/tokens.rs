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
//! for the field names below, with `-n` grouping them by the record they came
//! from. That also keeps the conversation on the far side, and safely: an
//! unescaped `"input_tokens":` cannot occur inside a JSON string, so a
//! byte-level filter can match nothing but the fields it names.
//!
//! Three of those names are here for [`crate::price`] rather than for the
//! counts, and each was checked over all 35,713 assistant records on this
//! machine on 2026-08-11.
//!
//! - **`model`**, because models do not share a rate. It is read first on the
//!   record, ahead of any tool call carrying a `model` argument of its own, on
//!   every record here.
//! - **`ephemeral_1h_input_tokens`**, because an hour-long cache write is
//!   billed at twice base input against 1.25x for a five-minute one. The split
//!   was present on every record and summed to `cache_creation_input_tokens`
//!   every time.
//! - **`speed`**, which is not priced but refuses to be: fast mode costs twice
//!   base input and twice output, and no record here carries anything but
//!   `standard`.

use crate::logs::{self, Error, NO_TRANSCRIPT};
use crate::ssh::{self, Exec, Ssh};
use crate::workspace;
use std::collections::{BTreeMap, HashSet};

/// The model named by a record that did not carry one.
pub const UNKNOWN_MODEL: &str = "unknown";

/// The counts a session's transcript records, summed.
///
/// Deliberately no total: cache reads and output tokens are not the same unit
/// of anything, and adding them would invent a figure the file does not hold.
/// Money is the one figure that does add them, and it is [`crate::price`]'s.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Counts {
    /// API responses, not records — see the module header.
    pub responses: usize,
    pub input: u64,
    pub output: u64,
    /// Every cache write, whichever lifetime it was bought for.
    pub cache_write: u64,
    /// The part of `cache_write` bought for an hour rather than five minutes,
    /// which costs 2x base input against 1.25x.
    pub cache_write_1h: u64,
    pub cache_read: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Spend {
    pub path: String,
    /// Per model, because they do not share a rate. Keyed by the name the
    /// transcript wrote, so a caller prices what was billed rather than what a
    /// workspace asked for.
    pub by_model: BTreeMap<String, Counts>,
    /// Responses Claude Code recorded as fast mode, which is billed at a
    /// premium [`crate::price`] does not carry. A caller that sees a number
    /// here reports tokens and withholds the money.
    pub fast: usize,
}

impl Counts {
    fn add(&mut self, other: &Self) {
        self.responses = self.responses.saturating_add(other.responses);
        self.input = self.input.saturating_add(other.input);
        self.output = self.output.saturating_add(other.output);
        self.cache_write = self.cache_write.saturating_add(other.cache_write);
        self.cache_write_1h = self.cache_write_1h.saturating_add(other.cache_write_1h);
        self.cache_read = self.cache_read.saturating_add(other.cache_read);
    }
}

impl Spend {
    /// Every model's counts added together. Tokens add across models even
    /// though dollars do not — a rate is per model, a token is a token.
    pub fn total(&self) -> Counts {
        let mut total = Counts::default();
        for counts in self.by_model.values() {
            total.add(counts);
        }
        total
    }
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
         | grep -n -o -E '\"(model|speed|requestId|input_tokens|output_tokens\
         |cache_creation_input_tokens|cache_read_input_tokens\
         |ephemeral_1h_input_tokens)\":(\"[^\"]*\"|[0-9]+)' || :\n",
        locate = logs::locate(repo, session),
    )
}

/// One record's fields, in the order `grep` found them.
#[derive(Default)]
struct Reply {
    request: Option<String>,
    model: Option<String>,
    speed: Option<String>,
    input: Option<u64>,
    output: Option<u64>,
    cache_write: Option<u64>,
    cache_write_1h: Option<u64>,
    cache_read: Option<u64>,
}

impl Reply {
    /// First occurrence wins: what follows on the same record is `iterations`
    /// repeating the same names for the calls the response was made of. It is
    /// also what keeps `model` the response's own rather than the `model`
    /// argument of a tool call further along the same line.
    fn take(&mut self, field: &str) {
        let Some((key, value)) = field.split_once("\":") else {
            return;
        };
        let slot = match key.trim_start_matches('"') {
            "input_tokens" => &mut self.input,
            "output_tokens" => &mut self.output,
            "cache_creation_input_tokens" => &mut self.cache_write,
            "ephemeral_1h_input_tokens" => &mut self.cache_write_1h,
            "cache_read_input_tokens" => &mut self.cache_read,
            "requestId" => return text(&mut self.request, value),
            "model" => return text(&mut self.model, value),
            "speed" => return text(&mut self.speed, value),
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

    /// A response Claude Code did not mark is a standard one — `speed` was
    /// absent from a third of the records here, all of them written by a
    /// `claude` that predates the flag.
    fn fast(&self) -> bool {
        self.speed
            .as_deref()
            .is_some_and(|speed| speed != "standard")
    }

    fn counts(&self) -> Counts {
        Counts {
            responses: 1,
            input: self.input.unwrap_or(0),
            output: self.output.unwrap_or(0),
            cache_write: self.cache_write.unwrap_or(0),
            cache_write_1h: self.cache_write_1h.unwrap_or(0),
            cache_read: self.cache_read.unwrap_or(0),
        }
    }
}

fn text(slot: &mut Option<String>, value: &str) {
    slot.get_or_insert_with(|| value.trim_matches('"').to_owned());
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
fn add(spend: &mut Spend, seen: &mut HashSet<String>, mut reply: Reply) {
    if !reply.counted() {
        return;
    }
    if let Some(request) = reply.request.take()
        && !seen.insert(request)
    {
        return;
    }
    if reply.fast() {
        spend.fast = spend.fast.saturating_add(1);
    }
    let model = reply
        .model
        .take()
        .unwrap_or_else(|| UNKNOWN_MODEL.to_owned());
    spend
        .by_model
        .entry(model)
        .or_default()
        .add(&reply.counts());
}

#[cfg(test)]
// `expect` in a test is a deliberate abort with a message; the workspace lint
// targets code that ships, where the same call would take the process down.
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    /// Two records of one API response, byte for byte as the probe printed them
    /// against a real transcript on 2026-08-11. Each names the counts twice —
    /// the response's own totals, then the single `iterations` entry — and both
    /// carry the same `requestId`. The write is an hour-long one, which is the
    /// case a five-minute rate under-reports by 1.6x.
    const ONE_RESPONSE: &str = "\
1:\"model\":\"claude-opus-5\"
1:\"input_tokens\":2
1:\"cache_creation_input_tokens\":34463
1:\"cache_read_input_tokens\":0
1:\"output_tokens\":282
1:\"ephemeral_1h_input_tokens\":34463
1:\"input_tokens\":2
1:\"output_tokens\":282
1:\"cache_read_input_tokens\":0
1:\"cache_creation_input_tokens\":34463
1:\"ephemeral_1h_input_tokens\":34463
1:\"speed\":\"standard\"
1:\"requestId\":\"req_011CdUvE3X82CddC2zpdjXMx\"
2:\"model\":\"claude-opus-5\"
2:\"input_tokens\":2
2:\"cache_creation_input_tokens\":34463
2:\"cache_read_input_tokens\":0
2:\"output_tokens\":282
2:\"ephemeral_1h_input_tokens\":34463
2:\"input_tokens\":2
2:\"output_tokens\":282
2:\"cache_read_input_tokens\":0
2:\"cache_creation_input_tokens\":34463
2:\"ephemeral_1h_input_tokens\":34463
2:\"speed\":\"standard\"
2:\"requestId\":\"req_011CdUvE3X82CddC2zpdjXMx\"
";

    fn of<'a>(spend: &'a Spend, model: &str) -> &'a Counts {
        spend.by_model.get(model).expect("model was counted")
    }

    /// The measurement the module exists to get right: 26 lines, two records,
    /// **one** response, and the totals are that response's — not twice them,
    /// and not four times them once `iterations` is counted too.
    #[test]
    fn one_response_written_twice_is_counted_once() {
        let spend = tally("/h/.claude/projects/-srv-repo/s.jsonl", ONE_RESPONSE);
        let counts = of(&spend, "claude-opus-5");
        assert_eq!(counts.responses, 1);
        assert_eq!(counts.input, 2);
        assert_eq!(counts.output, 282);
        assert_eq!(counts.cache_write, 34_463);
        assert_eq!(counts.cache_write_1h, 34_463);
        assert_eq!(counts.cache_read, 0);
        assert_eq!(spend.fast, 0);
        assert_eq!(spend.path, "/h/.claude/projects/-srv-repo/s.jsonl");
    }

    /// Different requests are different spend, however alike the numbers look.
    #[test]
    fn separate_responses_are_added_up() {
        let counts = "\
1:\"model\":\"claude-opus-5\"\n\
1:\"input_tokens\":2\n\
1:\"cache_creation_input_tokens\":465\n\
1:\"cache_read_input_tokens\":40353\n\
1:\"output_tokens\":75\n\
1:\"requestId\":\"req_A\"\n\
2:\"model\":\"claude-opus-5\"\n\
2:\"input_tokens\":2\n\
2:\"cache_creation_input_tokens\":465\n\
2:\"cache_read_input_tokens\":40353\n\
2:\"output_tokens\":75\n\
2:\"requestId\":\"req_B\"\n";
        let spend = tally("/x", counts);
        let counts = of(&spend, "claude-opus-5");
        assert_eq!(counts.responses, 2);
        assert_eq!(counts.input, 4);
        assert_eq!(counts.output, 150);
        assert_eq!(counts.cache_write, 930);
        assert_eq!(counts.cache_write_1h, 0);
        assert_eq!(counts.cache_read, 80_706);
    }

    /// Two models in one transcript are two rates, so they are kept apart —
    /// what a subagent spent on Sonnet is not what the session spent on Opus.
    /// Tokens still add across them, which is what [`Spend::total`] is for.
    #[test]
    fn two_models_are_counted_apart_and_added_together() {
        let counts = "\
1:\"model\":\"claude-opus-5\"\n\
1:\"input_tokens\":10\n\
1:\"output_tokens\":100\n\
1:\"requestId\":\"req_A\"\n\
2:\"model\":\"claude-haiku-4-5-20251001\"\n\
2:\"input_tokens\":7\n\
2:\"output_tokens\":3\n\
2:\"requestId\":\"req_B\"\n";
        let spend = tally("/x", counts);
        assert_eq!(spend.by_model.len(), 2);
        assert_eq!(of(&spend, "claude-opus-5").output, 100);
        assert_eq!(of(&spend, "claude-haiku-4-5-20251001").output, 3);

        let total = spend.total();
        assert_eq!(total.responses, 2);
        assert_eq!(total.input, 17);
        assert_eq!(total.output, 103);
    }

    /// Fast mode is billed at twice base input and twice output, which no rate
    /// in [`crate::price`] carries. Counting the responses is what lets a
    /// caller withhold a figure rather than print a wrong one.
    #[test]
    fn a_fast_mode_response_is_counted_as_one() {
        let counts = "\
1:\"model\":\"claude-opus-5\"\n\
1:\"input_tokens\":10\n\
1:\"speed\":\"fast\"\n\
1:\"requestId\":\"req_A\"\n\
2:\"model\":\"claude-opus-5\"\n\
2:\"input_tokens\":10\n\
2:\"speed\":\"standard\"\n\
2:\"requestId\":\"req_B\"\n";
        let spend = tally("/x", counts);
        assert_eq!(spend.fast, 1);
        assert_eq!(of(&spend, "claude-opus-5").responses, 2);
    }

    /// The six records here with no `requestId` are Claude Code's "No response
    /// requested." replies, and they carry four zeroes under `<synthetic>` —
    /// a placeholder rather than a model, which is why nothing prices it.
    /// Nothing joins them, so each is its own response.
    #[test]
    fn a_record_with_no_request_id_still_counts_for_itself() {
        let counts = "\
1:\"model\":\"<synthetic>\"\n\
1:\"input_tokens\":0\n\
1:\"output_tokens\":0\n\
1:\"cache_creation_input_tokens\":0\n\
1:\"cache_read_input_tokens\":0\n\
2:\"model\":\"<synthetic>\"\n\
2:\"input_tokens\":0\n\
2:\"output_tokens\":0\n\
2:\"cache_creation_input_tokens\":0\n\
2:\"cache_read_input_tokens\":0\n";
        let spend = tally("/x", counts);
        assert_eq!(of(&spend, "<synthetic>").responses, 2);
        assert_eq!(spend.total().input, 0);
    }

    /// A tool call carrying a `model` argument of its own sits further along
    /// the same record, and first-occurrence-wins is what keeps the response's
    /// model the one that is priced. Checked over all 35,713 assistant records
    /// on this machine: none named a bare alias first.
    #[test]
    fn a_tool_argument_does_not_become_the_model_that_is_priced() {
        let counts = "\
1:\"model\":\"claude-opus-5\"\n\
1:\"input_tokens\":10\n\
1:\"model\":\"sonnet\"\n\
1:\"requestId\":\"req_A\"\n";
        let spend = tally("/x", counts);
        assert_eq!(spend.by_model.len(), 1);
        assert_eq!(of(&spend, "claude-opus-5").input, 10);
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
        assert_eq!(of(&spend, UNKNOWN_MODEL).responses, 1);
        assert_eq!(of(&spend, UNKNOWN_MODEL).input, 7);
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
        for field in ["model", "speed", "ephemeral_1h_input_tokens"] {
            assert!(probe.contains(field), "{field} is not asked for: {probe}");
        }
        assert!(
            !probe.contains("tail -n"),
            "shipping records rather than counts would carry the conversation with them: {probe}"
        );
    }
}
