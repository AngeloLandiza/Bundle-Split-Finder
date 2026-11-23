# Step 16: a Review card he can read, and fewer things in Review

**Owner (Nov 23), with a screenshot of the Review pane:** "there is too much information as a user here and I don't
know what I am supposed to be looking at. Take advantage of AI to summarize the information … have some schema to
show information that makes it easy for Alex to understand and any extra details should be in a drop down. Also I
don't know why there are still so many things in review … come up with more AI solutions to automate even further
while still maintaining highly accurate results with grounding. Take advantage of subagents … don't be stingy, just
be careful with model and effort choice."

## Where the ten real questions come from (fixtures/e2e-2026-11-23/after-scan3)
- 7 "What is inside?": the AI answered most of them, and the code refused to verify for want of one fact it can
  fetch free (is DCS334B a real model? — a Home Depot product page says), for a tool that failed (search on a cold
  tab, fixed), or on a technicality (a quote across two list lines, a bag no part holds).
- 3 "Which Amazon listing?": "brand not confirmed", "Replacement or OEM", "kit or not" — facts Amazon's own catalog
  record states (brand, part number), which Keepa returns for 1 token.

## The ladder: code first, AI second, the owner last
1. **Amazon's catalog record settles listing matches (code).** Brand and part number from Keepa confirm or
   contradict a title match; confirmed → verified, contradicted → removed, questions withdrawn. Measured on recorded
   products and the validation set; zero wrong or not adopted.
2. **More grounding for the AI's split answers (code).** A stored Home Depot part page for exactly the brand and
   model is proof the model exists; the agent queues the free reads an unverified answer needs and verifies again
   with no new model call. Refusal technicalities get narrower code rules, each measured.
3. **Ask again when the evidence changed (AI).** Once per new piece of evidence, inside the AI cap.
4. **A second model as a cross-check (AI, measured before any use).** It sees only code-verified quotes and derives
   the parts itself; agreement could raise "not verified" to "two models agree — check and approve". Harness first;
   the main session pays for the measurement; never wired into Autopilot.
5. **The owner, with a decision card.** Schema `ReviewBrief { ask, suggestion, state, reasons[≤3], check, writtenBy }`:
   the suggestion in plain words, three short reasons each resting on a quote the code found word for word, one thing
   to check with its link; everything else under one "Details" disclosure. Written by a small model (Haiku-class,
   provider-neutral) from verified quotes only; code drops any reason that cites nothing or names a model, price or
   count its quote does not hold; a rules-written brief when there is no AI.

Checked and ruled out (Nov 23, free page reads in Chrome): Home Depot's page data has a `bundleItems` field, but it
is null on all five bundle pages read (320243741, 324903619, 306554196, 337440459, 320243671), so the component list
cannot come from there.

## Work (parallel)
- **card (Sonnet):** the Review decision card and list, UI only.
- **brief (Sonnet):** the grounded brief pipeline and the rules brief.
- **kverify (Opus):** catalog verification of matches, in scans and the drip.
- **reverify (Opus):** levers 2–4.
- **helperv (Sonnet):** the helper names its build on every poll.
Then: paid measurements by the main session (brief eval, cross-check eval; costs reported), merge, both installers,
a look at the real app.
