# Step 12: AI research for Review questions, Ask AI about all, Approve all verified

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Owner (Nov 20):** "add some search pipeline for the AI … fully automatic with human gated approval … an ask all AI button … and also an accept all still … principal UI/UX" · "your pick, do whats recommend, and still follows what my PO wants. go!" Picks: research on Home Depot + the brand's own site only; "Ask AI after each scan" off by default; "Approve all verified" visible, secondary, with an inline confirmation. PO brief (memory): Home Depot's Includes list is the source of parts; no leftover tools.

**Spec:** docs/design.md "AI research and bulk approval (step 12)" plus step 11's Ask AI section. CLAUDE.md rules apply; rule 1: research never spends SerpApi searches; Amazon is never browsed.

## Design
- Split questions get a research agent: a manual tool-use loop (provider-neutral; Claude adapter first, `callClaudeMessages`) with client tools run by the extension and one server tool:
  - `read_homedepot_page({itemId|url})` → the full product page as text sections: title, model, bullets, description, specifications (name: value, incl. "Included"/"What's in the box"). Free, in the owner's browser (doorway tab), homedepot.com only.
  - `search_homedepot({query})` → up to 10 results {title, brand, model, itemId, url}. Free, in the browser.
  - `catalog_lookup({model|query})` → known catalog entries {brand, model, title, kind}. Local.
  - Anthropic `web_search` (server tool) with `allowed_domains` ["ryobitools.com", "dewalt.com"], at most 2 a question.
  - Limits a question: ≤ 8 tool calls, ≤ 2 web searches, 60 s, max_tokens 4000. Every tool result is kept in an evidence ledger (id, source label, url, text).
- Final answer (schema): `{decision: 'parts'|'choose'|'none'|'cannot_tell', parts?: [{model, qty, quotes:[{quote, sourceId}]}], choiceIndex?, reason}`.
- Code verification (only lowers): each quote verbatim in its ledger source; each part model is a real model (catalog, or the model of a Home Depot page/search result it read, or the brand site); every part named by a quote; coverage against the bundle title/Includes ("2-Tool", "(Tools Only)" → no batteries/charger; a counted Includes list must be fully accounted — no leftovers); 'none' never verified. Verified parts become the question's answer only on Approve (typed parts answer, existing path).
- Match questions keep step 11's Ask AI (no research tools; Amazon is never browsed).

## Tasks
- **R1 (Opus) core:** `core/src/research/` — tool contracts (types only for client tools), the loop with limits and typed not-judged results, the ledger, prompt, schema, `verifyResearch`, eval scoring; tests with a fake model and fake tools on real questions (validation Review items; PCL500525SB from a recorded page). `npm run research:eval` (fake tools from recorded files; `--run` uses the real model with recorded tool results only).
- **R2 (Sonnet) extension tools:** in extension/lib: `readHomeDepotPage` (full page text sections from the page's state JSON, extending core/src/hdPage.ts with specifications) and `searchHomeDepot(query)` (results list), both through the doorway tab with the existing caps/timeouts; `catalogLookup` over the store. Tests on recorded pages (record one with specifications if none exists: say so, do not invent).
- **R3 (Sonnet) panel and queue:** worker `askAiAll` queue (one at a time, Stop, progress row step "Asking AI", cost so far), `askAi` routes split questions to research; Settings toggle "Ask AI after each scan" (runs the queue after a scan); Review: "Ask AI about all N · about $X" beside Accept all, the "AI suggestions · N" section with compact rows and "Approve all N verified" with inline confirmation; per-question button hidden where no call would be made; Accept all unchanged for questions without a suggestion. E2E with fake model and fake HD routes; screenshots 360/480.
- **R4:** reviews (code, UI), QA, docs, merge.

## Review focus
1. A suggestion applied without the owner (Approve all must apply only verified ones shown, after the confirmation).
2. A part model invented by the AI (not seen in the catalog or a page it read) verified.
3. Leftovers: a verified answer that leaves part of the Includes list unaccounted.
4. Research spending SerpApi or browsing Amazon; web search outside the two brand domains.
5. A long "ask all" blocking scans, or a scan blocking it; Stop leaving a half-written suggestion.

## Where this stands (2026-11-20)
Built, reviewed (whole-step code review with a critical finding fixed; UI review with fixes), measured and QA'd:
- **Research agent** for split questions: Home Depot page (with the specification table) and Home Depot search in the owner's browser, the catalog, and the brand sites (web search + web fetch, ryobitools.com / dewalt.com, 2 each a question). No SerpApi, never Amazon. Prompt caching. Limits a question: 8 tool calls, 60 s.
- **Verification only lowers:** quotes verbatim in a source read; models real; counts ("2-Tool", batteries, charger) and "(Tools Only)" agree; no leftovers on the Includes list; a bundle the splitter would split (e.g. PSK1212SB) is not a part; a combo the catalog does not know as a kit is not a part; a word-only item ("18V Jig Saw") needs a tie to the bundle (the bundle page names the model, or a listing of the same bundle names it — e.g. Home Depot's sibling PCL500B-PCL525B).
- **Measured** on the 19 validation split questions, recorded tools (Opus 5.5): run 1 1 right / 0 wrong ($3.09); run 2 4 / 1 wrong (starter kit) ($1.83); run 3 10 / 0 ($0.60, caching); run 4 with the tie rule 6 / 0 ($0.69). About 3–4¢ a question.
- **Panel:** "Ask AI about all N · about $X" (queue with Stop, 3-failure stop, 2× spending cap, progress row), "AI suggestions · N" (verified only, compact rows) with "Approve all N verified" + inline confirmation over a snapshot, Accept all unchanged, "Ask AI after each scan" (off by default).
Next: the owner's real Review questions (live Home Depot search) will show the true rate; recording more Home Depot searches would make the eval fair; page highlights need a compound-item rule before they can be read; PSBCK102K2-style kits the catalog does not mark are a splitter-catalog gap.
