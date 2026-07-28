# ADR-0002 — Project is named Yantra (यन्त्र)

- **Date:** 2026-07-28
- **Status:** accepted

## Context

The project was drafted under the codename **NEXUS**. That name is generic, heavily used in
technology (Google Nexus, Nexus Repository, Nexus Mods, countless startups), and carries no meaning
specific to what this system does.

A Sanskrit name was wanted: meaningful, pronounceable, and tied to the project's identity as a
*physical appliance that orchestrates work*.

Candidates considered:

| Name | Meaning | Why not |
| --- | --- | --- |
| **Yantra** (यन्त्र) | machine, instrument, contrivance, apparatus | — chosen |
| Sutradhara (सूत्रधार) | "holder of the threads"; the stage-director of Sanskrit drama | Strongest fit for the *orchestration* half, but long, and weaker for the hardware identity |
| Kendra (केन्द्र) | centre, hub, nucleus | Collides with AWS Kendra; semantically flat |
| Prana (प्राण) | life force, vital breath | Matches "central nervous system", but reads as wellness/yoga in English |

## Decision

The project is **Yantra**, written **यन्त्र** in Devanagari.

- Repository / module namespace: `yantra`
- CLI binary: `yantra`
- Daemon: `yantrad`
- Config root: `~/.config/yantra/`

*Yantra* means machine, instrument, or apparatus — and in classical usage, a device that harnesses
and directs power. That is precisely the claim: a physical instrument that directs development work
across machines. It is short, ASCII-safe, unambiguous to type, and reads well as a command.

Prior art collisions are minor (the term appears in yoga/tantra literature and some art contexts) but
none exist in developer tooling, which is the space that matters.

## Consequences

- All documents referring to NEXUS are rewritten to Yantra; the original brainstorm and vision are
  archived with a header noting the rename rather than being rewritten wholesale.
- The name leans hardware-first. The software control plane is arguably better described by
  *Sutradhara*; if the project ever splits, `sutra` is reserved as the name for the orchestration
  daemon.
- Devanagari (यन्त्र) is used as a visual mark in the UI and on the physical enclosure, never in
  identifiers, paths, or code.
