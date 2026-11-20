# Agent Note: Verified Chinese title initials search

Status: implemented

## Problem

Sending `LBXX` directly to the metadata search did not find 蜡笔小新 on a fresh install. A cache-only matcher also missed films the user had never opened. The primary search intermittently returned 403; public suggestions sometimes returned an empty HTTP 200 response. On TV, cancelling a suggestion could cancel a newer search that joined its in-flight request, leaving the screen in its loading state.

## Decision

The [shared matcher](../../../../src/shared/title-search.ts) and [native TV equivalent](../../../../tv/app/src/main/java/app/panda/tv/data/TitleSearchIndex.kt) read a bundled title vocabulary and first-letter dictionary. The [release sync script](../../../../scripts/sync-search-titles.ts) collects complete ordinary-film categories from the configured catalogue pool, generates the dictionary with MIT-licensed pinyin-pro, and refuses a partial/small replacement. The [first export](../../../../docs/evidence/search-title-index.json) contains 42,437 titles from 360zy. Index loading is lazy and never blocks home startup.

One letter matches one Chinese character's syllable; full-width input, case, spaces, traditional characters and polyphonic alternatives are normalized. Contiguous matches rank complete titles before prefixes and interior matches. Polyphones occupy one position each rather than expanding into a Cartesian product. Local suggestions are query terms, not film metadata. Film IDs, classification, rating and episodes still come from verified upstream metadata; results merge by canonical ID and reject unrelated raw ASCII matches when Chinese candidates exist. Literal English searches with no Chinese candidates retain upstream results.

The normal metadata search remains first. A failed endpoint enters a 60-second fallback interval. Public movie suggestions, then public global search cards, supply only identities with matching HTTPS `movie.douban.com/subject/<id>` links; each identity is resolved through canonical metadata. Successful pages and canonical lookups survive failures in their siblings. Fallback requests have their own two-request gate, one-request-per-second pace and bounded cache; validated empty lists expire after one second.

TV HTTP followers restart a flight whose suggestion owner was cancelled only after checking that their own coroutine is active. Caller cancellation still propagates. Input activation reopens the in-app keypad; Back restores prior results and input focus. The first keypad row handles Up explicitly across the ScrollView boundary, and changing input removes stale suggestions immediately.

Golden vectors, [title tests](../../../../tests/title-search.test.ts), [search recovery tests](../../../../tests/search-recovery.test.ts), [TV flight cancellation regression](../../../../tv/app/src/test/java/app/panda/tv/MetadataFlightTest.kt) and [installed-APK replay](../../../../scripts/verify-tv-title-search.py) preserve these rules. The cancelled-flight test failed before the fix and passed afterwards; keypad return failed 3/3 before and passed 3/3 after. Final release evidence is owned by the [delivery report](../../../../docs/delivery-report.md).

## Alternatives considered

**Only search cached metadata.** It cannot serve a new installation or an unseen title.

**Send initials unchanged.** The live `LBXX` response missed the requested film and included unrelated titles. Filtering metadata alone cannot discover an unseen Chinese query.

**Display catalogue records as verified metadata.** Catalogue season suffixes and media classifications differ from canonical subjects. The index supplies query text instead of invented film cards or episode counts.

**Enumerate every polyphonic spelling.** The number of combinations grows exponentially. Position-based alternatives keep a bounded scan of the vocabulary.

**Use credentials or a TVBox plugin runtime for search.** The anonymous metadata fallback was verified. Adding account requirements or executing unverified JAR/plugin code would add installation and maintenance burdens.

## Consequences

Each package gains a 1,253,287-byte title index and a compact dictionary. Vocabulary refresh is a release operation; existing metadata caches also contribute matching titles. The anonymous endpoints have no availability promise, and fallback searches may be slower than a healthy primary endpoint. Missing verified metadata remains an error or empty result instead of fabricated content.
