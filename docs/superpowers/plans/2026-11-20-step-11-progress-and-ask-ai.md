# Step 11: scan progress with an estimate, and Ask AI on Review questions

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Owner (Nov 20):** "a UI feature that shows what the pipeline is doing at a given point during the scan. And also a progress bar with EST" · Ask AI on "needs your answer" questions, "human reviews what the AI decided before approving so human gated approval" · "both at once" · "dont let the info clutter the page … professional … what a real principal UX dev would do". Choices taken with the owner's go: collapsed by default; live model cost shown in the expanded view.

**Spec:** docs/design.md, sections "Scan progress (step 11)" and "Ask AI on Review questions (step 11)". CLAUDE.md rules 1–6 apply (rule 4: a suggestion is never an answer until approved).

## Global constraints
- No SerpApi search is spent by either feature. Ask AI reads only evidence already stored by the scan (bundle and kit page content; match candidates' titles/details).
- Ask AI uses the owner's Anthropic key through the provider-neutral judge pattern (core/src/judge: fetch injected, typed not-judged results, quotes verified in code); the model is the Settings model. Keys as in step 10.
- Default tests: no network. Subagents never call a paid model.
- Two tracks run in parallel in separate worktrees: Track P (progress) owns `core/src/scan/pipeline.ts` and `extension/entrypoints/sidepanel/ProgressRow.tsx` (+ its CSS); Track A (Ask AI) owns `core/src/assist/` and the Review question components. Shared files (`core/src/scan/types.ts`, the worker, `db.ts`) get small additive changes only; the controller merges.

## Track P — scan progress
### P1 (Sonnet): the pipeline record and the estimate (core + runner)
- `ScanJob.pipeline: PipelineStep[]` — `{id: 'hdPages'|'bundlePages'|'kitPages'|'amazon'|'partPrices'|'ebay'|'judge'|'finish', state: 'next'|'now'|'done'|'skipped', unitsDone, unitsTotal: number|null, startedAt?, endedAt?, skippedReason?, costSoFar?}`, set by the runner as each stage starts, advances and ends (skipped stages with a ≤4-word reason). Survives worker evictions (it is on the job).
- Rates: per unit kind (serpapi search, HD page read, eBay call, judge call per model) a rolling median of measured seconds per unit, stored in the extension's settings store; seeded defaults used until measured.
- `estimate(job, rates, now): {kind: 'estimating'|'about'|'atLeast'|'underMinute', seconds}`: remaining units × rate per step; `atLeast` while part counts are unknown (before splitting finishes).
- `pipelineView(job, rates, now)`: the exact strings the spec lists (current-step line, step lines, estimate text, aria-valuetext, steps done of total). Pure, unit-tested on recorded jobs.
### P2 (Opus): the progress row
- Replace ProgressRow per the spec: collapsed two-line row, 2px bar, Details disclosure (remembered), expanded step list, live cost on the model step, reduced motion, live region throttled to 5 s. Component tests; e2e with the replay (a scan shows the steps advancing); screenshots 360/480 collapsed and expanded.

## Track A — Ask AI on Review questions
### A1 (Opus): the review assistant (core)
- `core/src/assist/`: `suggestAnswer(question, evidence, judgeCall): Suggestion` for `split` (choose one of `choices` or "cannot tell") and `match` (choose a candidate ASIN or "none fits"/"cannot tell"). Evidence: the bundle/kit page content stored by the scan (split) or the candidates' title and details (match). Prompt states the never-guess rule; seller/page text is data; verbatim quotes with their source; code verifies every quote against the evidence and that the proposed answer is one of the offered choices; a failed check → "unverified"; a failed call → not suggested. Provider-neutral (reuses the Claude adapter's transport). PROMPT_VERSION. Tests on recorded questions (fixtures/validation pages and Review items), fake fetch.
### A2 (Sonnet): Ask AI in the panel
- Worker message `askAi(questionId)` → loads evidence, calls A1 with the Settings model and key, stores the suggestion on the question (never as its answer), counts tokens and cost. Review question per the spec: "Ask AI · about $0.02", Asking…, the suggestion block, preselection, Approve; unverified and cannot-tell states; no button without a key. Approving saves the answer through the existing path and records `{source: 'ai', agreed: true|false}` in the audit export. E2E with the fake model endpoint; screenshots 360/480 of a suggestion, an unverified one and cannot-tell.

## Review focus
1. A suggestion saved as an answer without the owner pressing Approve (including Accept all).
2. A proposed answer that is not one of the question's choices or candidates.
3. A quote not found in the evidence shown as verified.
4. The progress estimate shown without its label, or counting down per second.
5. The expanded view or suggestion block crowding the panel at 360px.

## Where this stands (2026-11-20)
Built, reviewed (code and UI, with fix rounds) and QA'd, on main:
- **Scan progress:** the runner keeps a per-step pipeline record on the job (survives worker evictions) and learns seconds-per-unit from real scans (seeded, rolling median of 20). The row under the tabs shows the current step with its count, an always-labelled estimate and a 2px bar; "Details" lists every step with done / now / next / skipped and a reason; the model step shows its cost so far. Short labels so nothing is cut at 360px; the estimate drops to its own line below 424px.
- **Ask AI:** a Review question's "Ask AI · about $0.0x" asks the Settings model for a suggestion from evidence the scan already stored (no searches). Code verifies quotes and the choice; a split verifies only from Includes, specification or description lines; a "none" is never verified. Verified suggestions preselect and the button reads Approve only while that answer is selected. Nothing is saved without the owner; Accept all leaves out questions with a suggestion; the audit records whether the owner agreed.
- **Measured** on the 26 validation Review questions (pages trimmed to the lines the splitter reads, so many are "could not tell"): Opus 5.5 4 verified-correct, 0 wrong, $0.34; Haiku 5.5 2 correct, 0 wrong, $0.009 (prompt .3).
Next: the owner's real Review questions (full pages) will show the true rate; Ask AI on Detail/This page if wanted; a sort or page of eBay results by sales.
