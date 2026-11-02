//! What a token costs, and the day that was true.
//!
//! The table below is written down rather than fetched. Anthropic publishes no
//! price API, and a daemon that reached the public internet to answer *what did
//! this session cost* would spend the one property this project is built on.
//!
//! **A written-down table reports wrong money the day a price changes, and says
//! nothing while it does.** The owner took that trade on 2026-08-10 and chose
//! the mitigation with it: [`AS_OF`] is printed beside every figure derived
//! from here, so the staleness is on the screen rather than in the code. Two
//! things follow for whoever edits this file. Move [`AS_OF`] in the same edit,
//! and read the prices off the page rather than from memory.
//!
//! Read from <https://platform.claude.com/docs/en/about-claude/pricing> on
//! 2026-11-02.

use crate::tokens::Counts;

/// The day [`TABLE`] was read off Anthropic's published prices.
pub const AS_OF: &str = "2026-11-02";

/// The [`TABLE`] key for Haiku 5.5's higher card. The space keeps it from
/// colliding with a name a transcript writes.
const LONG_HAIKU: &str = "claude-haiku-5-5 over 100k";

/// Dollars per million tokens, for the three prices Anthropic quotes per model.
///
/// Cache writes are multipliers of base input on every row of the pricing
/// page: 1.25x for a five-minute write, 2x for an hour. Cache reads are quoted
/// per model, because the 5.x models broke the 0.1x that older rows obey.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rate {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
}

/// Every model Anthropic prices, keyed by the prefix a transcript writes.
///
/// Retired models are here too: a transcript outlives the model that wrote it,
/// and pricing an old session at nothing is worse than pricing it at the rate
/// it was actually billed. Mythos 5 and 5.1 are left out — they are limited
/// availability and no `claude` CLI reaches them.
const TABLE: &[(&str, Rate)] = &[
    ("claude-fable-5-1", Rate::new(10.0, 50.0, 0.25)),
    ("claude-fable-5", Rate::new(10.0, 50.0, 1.0)),
    ("claude-opus-5-5", Rate::new(4.0, 20.0, 0.20)),
    ("claude-opus-5", Rate::new(5.0, 25.0, 0.50)),
    ("claude-opus-4-8", Rate::new(5.0, 25.0, 0.50)),
    ("claude-opus-4-7", Rate::new(5.0, 25.0, 0.50)),
    ("claude-opus-4-6", Rate::new(5.0, 25.0, 0.50)),
    ("claude-opus-4-5", Rate::new(5.0, 25.0, 0.50)),
    ("claude-opus-4-1", Rate::new(15.0, 75.0, 1.50)),
    ("claude-sonnet-5-5", Rate::new(2.0, 10.0, 0.10)),
    ("claude-sonnet-5", Rate::new(2.0, 10.0, 0.20)),
    ("claude-sonnet-4-6", Rate::new(3.0, 15.0, 0.30)),
    ("claude-sonnet-4-5", Rate::new(3.0, 15.0, 0.30)),
    ("claude-sonnet-4", Rate::new(3.0, 15.0, 0.30)),
    ("claude-haiku-5-5", Rate::new(0.10, 0.50, 0.01)),
    (LONG_HAIKU, Rate::new(0.50, 2.50, 0.05)),
    ("claude-haiku-4-5", Rate::new(1.0, 5.0, 0.10)),
    ("claude-haiku-3-5", Rate::new(0.80, 4.0, 0.08)),
];

impl Rate {
    const fn new(input: f64, output: f64, cache_read: f64) -> Self {
        Self {
            input,
            output,
            cache_read,
        }
    }

    /// Dollars for one model's counts, at this rate.
    pub fn charge(&self, counts: &Counts) -> f64 {
        let five_minute = counts.cache_write.saturating_sub(counts.cache_write_1h);
        per_million(counts.input, self.input)
            + per_million(counts.output, self.output)
            + per_million(five_minute, self.input * 1.25)
            + per_million(counts.cache_write_1h, self.input * 2.0)
            + per_million(counts.cache_read, self.cache_read)
    }
}

/// The rate for a model a transcript named, or `None` for one this table does
/// not carry — a model newer than [`AS_OF`], or Claude Code's `<synthetic>`,
/// which is a placeholder rather than a model and is never billed.
///
/// Matching is by longest prefix, because a transcript writes a dated name
/// (`claude-haiku-4-5-20251001`) where the price list writes a family, and
/// because `claude-sonnet-4` is a prefix of `claude-sonnet-4-5`.
pub fn rate(model: &str) -> Option<Rate> {
    TABLE
        .iter()
        .filter(|(prefix, _)| model.starts_with(prefix))
        .max_by_key(|(prefix, _)| prefix.len())
        .map(|(_, rate)| *rate)
}

/// The [`TABLE`] key one response was billed under, given its prompt length:
/// input plus cache writes plus cache reads.
///
/// Haiku 5.5 moves a whole request to a higher card past 100,000 tokens, and
/// counts are summed per model, so the card has to be chosen per response.
pub fn billed_as(model: &str, prompt: u64) -> &str {
    if model.starts_with("claude-haiku-5-5") && prompt > 100_000 {
        LONG_HAIKU
    } else {
        model
    }
}

fn per_million(tokens: u64, dollars_per_million: f64) -> f64 {
    #[allow(clippy::cast_precision_loss)]
    let tokens = tokens as f64;
    tokens * dollars_per_million / 1_000_000.0
}

#[cfg(test)]
// `expect` in a test is a deliberate abort with a message; the workspace lint
// targets code that ships, where the same call would take the process down.
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    /// The worked example on Anthropic's own pricing page, without its $0.08
    /// session runtime line: 10,000 uncached input and 40,000 cache-read tokens
    /// plus 15,000 output on Opus 5.5 is $0.04 + $0.008 + $0.30.
    #[test]
    fn the_published_worked_example_comes_out_at_the_published_figure() {
        let rate = rate("claude-opus-5-5").expect("opus 5.5 is priced");
        let charge = rate.charge(&Counts {
            input: 10_000,
            output: 15_000,
            cache_read: 40_000,
            ..Counts::default()
        });
        assert!((charge - 0.348).abs() < 1e-9, "{charge}");
    }

    /// The measurement this module exists to get right. An hour-long cache
    /// write is billed at twice base input and a five-minute one at 1.25x, so a
    /// figure that does not separate them is wrong by 1.6x on the line that
    /// dominates every transcript here.
    #[test]
    fn an_hour_long_cache_write_costs_more_than_a_five_minute_one() {
        let rate = rate("claude-opus-5").expect("opus 5 is priced");
        let hour = rate.charge(&Counts {
            cache_write: 1_000_000,
            cache_write_1h: 1_000_000,
            ..Counts::default()
        });
        let short = rate.charge(&Counts {
            cache_write: 1_000_000,
            ..Counts::default()
        });
        assert!((hour - 10.0).abs() < 1e-9, "{hour}");
        assert!((short - 6.25).abs() < 1e-9, "{short}");
    }

    /// A transcript writes a dated name where the price list writes a family,
    /// and one family name is a prefix of another.
    #[test]
    fn a_dated_model_name_finds_its_family_and_the_longer_prefix_wins() {
        assert_eq!(
            rate("claude-haiku-4-5-20251001"),
            Some(Rate::new(1.0, 5.0, 0.10)),
            "a dated name is the same model"
        );
        assert_eq!(
            rate("claude-sonnet-4-5"),
            Some(Rate::new(3.0, 15.0, 0.30)),
            "not claude-sonnet-4, which is also a prefix"
        );
    }

    /// A model this table does not carry is reported as unpriced rather than as
    /// free — the difference between *we do not know* and *it cost nothing*.
    #[test]
    fn an_unknown_model_has_no_rate_rather_than_a_zero_one() {
        assert_eq!(rate("<synthetic>"), None);
        assert_eq!(rate("claude-opus-9"), None);
        assert_eq!(rate(""), None);
    }

    /// The longest-prefix match gave each of these an older model's rate until
    /// the table named them. Sonnet 5.5 differs from Sonnet 5 in `cache_read`
    /// alone, so a table missing that row would still bill input and output right.
    #[test]
    fn no_new_model_takes_an_older_rate_by_prefix() {
        for (model, published, older) in [
            (
                "claude-opus-5-5",
                Rate::new(4.0, 20.0, 0.20),
                "claude-opus-5",
            ),
            (
                "claude-opus-5-5-20261101",
                Rate::new(4.0, 20.0, 0.20),
                "claude-opus-5",
            ),
            (
                "claude-fable-5-1",
                Rate::new(10.0, 50.0, 0.25),
                "claude-fable-5",
            ),
            (
                "claude-sonnet-5-5",
                Rate::new(2.0, 10.0, 0.10),
                "claude-sonnet-5",
            ),
        ] {
            assert_eq!(rate(model), Some(published), "{model}");
            assert_ne!(rate(model), rate(older), "{model}");
        }
        assert_eq!(rate("claude-haiku-5-5"), Some(Rate::new(0.10, 0.50, 0.01)));

        let sonnet = rate("claude-sonnet-5").expect("sonnet 5 is priced");
        let newer = rate("claude-sonnet-5-5").expect("sonnet 5.5 is priced");
        assert_eq!((newer.input, newer.output), (sonnet.input, sonnet.output));
        assert!((newer.cache_read - sonnet.cache_read).abs() > 1e-9);
    }

    #[test]
    fn a_cache_read_is_charged_at_the_figure_quoted_for_the_model() {
        for (model, dollars) in [
            ("claude-fable-5-1", 0.25),
            ("claude-opus-5-5", 0.20),
            ("claude-sonnet-5-5", 0.10),
            ("claude-haiku-5-5", 0.01),
        ] {
            let charge = rate(model).expect("model is priced").charge(&Counts {
                cache_read: 1_000_000,
                ..Counts::default()
            });
            assert!((charge - dollars).abs() < 1e-9, "{model} {charge}");
        }
    }

    /// Exactly 100,000 is the lower card: the page says *over*.
    #[test]
    fn haiku_5_5_moves_to_the_higher_card_past_100_000_tokens() {
        assert_eq!(billed_as("claude-haiku-5-5", 100_000), "claude-haiku-5-5");
        assert_eq!(billed_as("claude-haiku-5-5", 100_001), LONG_HAIKU);
        assert_eq!(billed_as("claude-haiku-5-5-20261101", 100_001), LONG_HAIKU);
        assert_eq!(
            billed_as("claude-haiku-5-5-20261101", 100_000),
            "claude-haiku-5-5-20261101"
        );
        assert_eq!(billed_as("claude-haiku-4-5", 100_001), "claude-haiku-4-5");
        assert_eq!(
            rate(LONG_HAIKU),
            Some(Rate::new(0.50, 2.50, 0.05)),
            "the key must find its own row, not the shorter prefix"
        );
    }

    /// Writes are derived and reads are quoted, and this checks both against
    /// the figures the page prints.
    #[test]
    fn the_cache_rates_match_the_published_ones() {
        for (model, write_5m, write_1h, read) in [
            ("claude-fable-5-1", 12.50, 20.0, 0.25),
            ("claude-fable-5", 12.50, 20.0, 1.0),
            ("claude-opus-5-5", 5.0, 8.0, 0.20),
            ("claude-opus-5", 6.25, 10.0, 0.50),
            ("claude-sonnet-5-5", 2.50, 4.0, 0.10),
            ("claude-sonnet-5", 2.50, 4.0, 0.20),
            ("claude-haiku-5-5", 0.125, 0.20, 0.01),
            (LONG_HAIKU, 0.625, 1.0, 0.05),
            ("claude-haiku-4-5", 1.25, 2.0, 0.10),
        ] {
            let rate = rate(model).expect("model is priced");
            assert!((rate.input * 1.25 - write_5m).abs() < 1e-9, "{model} 5m");
            assert!((rate.input * 2.0 - write_1h).abs() < 1e-9, "{model} 1h");
            assert!((rate.cache_read - read).abs() < 1e-9, "{model} read");
        }
    }
}
