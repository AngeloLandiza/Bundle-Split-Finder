# Step 8c: the audit loop — catch matching failures on real scans and lock the fixes in

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** The owner (or the controller) can turn any real scan into a scored audit: the extension exports what it matched, a blind checker labels the right listings, a script scores the tool against the labels, and every labelled pair joins a corpus that `npm test` runs through the matcher forever.

**Owner, Nov 18:** "this scraper should be perfect and should have a way to catch and safely and accurately fix failures. maybe llm solution?" → controller's recommendation (an LLM checks, it never decides in the product) → "okay do the audit loop then".

**Spec:** CLAUDE.md (never guess; the key never leaves the extension; no network in default tests), docs/decisions.md (Matching), the validation harness (scripts/validate-cli.ts: `scoreCriterion6`, the labels format).

## Contract: the audit export (Task 1 produces, Task 2 consumes)
`split-finder-audit-<YYYY-MM-DD>.json`:
```
{ "kind": "split-finder-audit", "version": 1, "exportedAt": <ms>,
  "bundles": [ { "key", "itemId", "brand", "model", "title", "section", "split": string[] | null,
                 "parts": [ { "brand", "model", "qty", "asin": string | null, "grade": string | null, "source": string | null } ] } ],
  "listings": [ ListingRecord as stored (asin, title, brand, model?, price, …) ],
  "matches":  [ MatchRecord as stored ],
  "answers":  [ answered ReviewItem as stored ] }
```
Never the key, never settings. Parts are the report's rows (primary way to sell).

## Task 1 (Sonnet): the export
Worker message `exportAudit` → the JSON above; Settings → Your data gains **Export for audit** (downloads it, same pattern as the existing exports); tests (worker shape on the recorded replay store; no key in the output; the button).

## Task 2 (Opus): the audit CLI, the corpus and its test
- `npm run audit -- prepare <export.json>` writes `audit/<date>/blind.json` (bundles, parts, and per part the candidate listings: every saved listing whose title names the part's model as a whole token, its RYOBI B twin allowed, plus the chosen listing — with no grade, no chosen ASIN, no source) and `audit/<date>/tool.json` (the tool's choices). `audit/` is gitignored except what `score` promotes.
- `npm run audit -- score <dir>` reads `labels.json` (the validation labels format) and writes `failures.md`: wrong matches (chosen ASIN not in `correct`), missed listings (a correct listing among the candidates, tool none/review), and appends every labelled (part, listing, correct?) pair to `fixtures/audit/corpus.json` (deduped by part+ASIN; each with its source audit and note).
- `core/test/match-corpus.test.ts`: for every corpus pair, the matcher's grade of that listing for that part: a pair labelled not-the-part must never grade probable or better; a pair labelled the part must grade at least review (never silently none). Seed the corpus from the validation labels and responses (150 parts). Failing pairs at the time of seeding are listed in the report and marked `known` with a reason, so the test passes and the list shows what is left to fix (the four misses are being fixed on this branch in parallel).
- `docs/audit.md`: how to run an audit end to end, and `docs/audit-checker.md`: the blind checker's instructions (the rules used on Nov 18: same brand; model as a whole token, RYOBI B twin allowed; new and alone; a kit part is the kit; uncertain kept separate), written so a Claude Code subagent or any LLM can be given it verbatim.

## Rules
No searches; no network in tests; never read .env. Typecheck, npm test, e2e pass.
