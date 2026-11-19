# Agent Notes

Each durable decision has one home. Paths are `notes/{proposed,implemented,rejected,archived}/{architecture,process,testing,misc}/yyyy-mm-dd-topic.md`. Use relative links and preserve uncommitted unique records.

## Triggers

| Event | Action |
| --- | --- |
| Architecture/library/protocol choice | Record decision, alternatives and consequences |
| Major change before implementation | Record proposed problem, proposal, alternatives, acceptance criteria and risks |
| Rejected proposal | Move to rejected, update status and links |
| Repeated pitfall | Add 1–3 imperative guide lines with a note link |
| Workflow successfully repeated twice | Consider project skill only if repeatable steps and a clear trigger exist |
| Paths/defaults/behavior change | Update owning note |
| Old decision contradicted | Record reversal and cross-link both |
| Historical-only note | Archive, update status and links |

After each commit or substantial task, inspect changed files against this table. Mechanical changes need no standalone note. Omitted notes are added to the workspace without automatic amend/commit. Repeated review does not create duplicate notes.

## Required note format

Implemented notes contain `Status: implemented`, then `Problem`, `Decision`, `Alternatives considered`, and `Consequences`. Record actual facts, not future wishes. Proposed notes use `Status: proposed` and `Problem`, `Proposal`, `Alternatives considered`, `Acceptance criteria`, and `Risks`. Changes to lifecycle update incoming and outgoing links.

## Current work

Version 1.0.0 was delivered on 2026-11-16; the [delivery report](../../docs/delivery-report.md) owns the state, limits and evidence, the [implementation plan](../../docs/implementation-plan.md) the scope and selected stack. Decisions in `implemented/architecture/`:

| Note | Owns |
| --- | --- |
| [production-completion](implemented/architecture/2026-11-16-production-completion.md) | Overall data-source choices and rejected public proxies |
| [filter-vocabulary](implemented/architecture/2026-11-16-filter-vocabulary.md) | Channel filters, cold Douban listings |
| [source-identity](implemented/architecture/2026-11-16-source-identity.md) | Matching a Douban subject to source records, serial runs |
| [source-verdict](implemented/architecture/2026-11-16-source-verdict.md) | When "no source" may be reported |
| [source-contest](implemented/architecture/2026-11-17-source-contest.md) | Which source starts an episode: measured playback headroom, picture read from the segment, turns, set-back memory, early search answer |
| [playback-stability](implemented/architecture/2026-11-19-playback-stability.md) | Work-scoped source health, previous-episode winner ordering, and desktop/TV buffer policies |
| [ad-evidence](implemented/architecture/2026-11-16-ad-evidence.md) | Ad removal evidence classes, rule updates |
| [media-ports](implemented/architecture/2026-11-16-media-ports.md) | Ports the media proxy may contact |
| [safe-proxy-dns](implemented/architecture/2026-11-16-safe-proxy-dns.md) | Public-address checks under a local proxy's fake DNS |
| [desktop-confirmation](implemented/architecture/2026-11-16-desktop-confirmation.md) | Window controls while a dialog is open |
| [packaging](implemented/architecture/2026-11-16-packaging.md) | Installer contents and executable metadata |
| [startup](implemented/architecture/2026-11-17-startup.md) | What a start shows before the network answers: saved home feed, artwork on disk, connection deadlines |
| [people](implemented/architecture/2026-11-17-people.md) | Who a detail page lists (Douban's principal credits), their photos and framing, a person's works page |
| [android-tv](implemented/architecture/2026-11-18-android-tv.md) | Native Kotlin Android TV client (`tv/`, API 22+, ~1.0 MB APK), 10-foot layout & D-pad UX, golden parity with desktop |
| [tv-interaction](implemented/architecture/2026-11-18-tv-interaction.md) | Whole first-row return, preferred column, stale requests, admission checks, immediate episode transitions, actual control focus and late warm readers |

The repeatable device workflow is [tv-runtime-regression](../skills/tv-runtime-regression/SKILL.md). It runs production APK replays sequentially and checks restoration of temporary state and network rules.
