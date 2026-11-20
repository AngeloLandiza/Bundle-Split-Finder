# Design spec

The look is a workshop ledger: paper, ink, hairlines and aligned figures. It is a tool a
reseller keeps open beside a product page all day, so it is dense, quiet and exact.

The mockups in `docs/design/mockups/` are the reference. They are plain HTML with inline
styles; open one to read exact sizes, colors and spacing. Build to them, then keep to the
rules below for anything the mockups do not show.

| Mockup | Shows |
| --- | --- |
| `Main.dc.html` | Side panel, Deals list |
| `Detail.dc.html` | Side panel, one bundle |
| `FirstRun.dc.html` | Side panel before a key is set |
| `Limit.dc.html` | Side panel after a scan stopped at its search limit |
| `InPage.dc.html` | Chip on a retailer page, with the This page tab |
| `Settings.dc.html` | Settings page |

## Principles

1. **Numbers are the interface.** Profit, price and ROI are set in the mono face, right
   aligned, with tabular figures, so a column of them can be compared at a glance.
2. **One level of surface.** Rows separated by hairlines on a white band. No cards inside
   cards, no shadows in the panel. The only shadow is under the in-page chip, because it
   sits on someone else's page.
3. **Ink does the work.** Primary buttons are ink, not a brand color. Blue is only for links.
   Amber is only for "needs you". Rust is only for a loss.
4. **Every paid action shows its price.** A control that will spend searches says how many,
   on the control, before the click.
5. **Say what is known.** "Title match" is not "Verified". An estimate is called an estimate.
   Unknown packaging is shown as a question, not hidden.

## Tokens

    --paper:        #FAFAF7   page ground
    --surface:      #FFFFFF   bands, inputs, header, footer
    --sunken:       #F1F0EA   notices, disabled fills
    --ink:          #1A1C1E   text, primary buttons, checkmarks
    --ink-2:        #54585D   secondary text
    --ink-3:        #676B70   disabled text
    --line:         #E2E0D8   hairlines between rows and bands
    --line-strong:  #8B887F   borders of inputs and secondary buttons
    --link:         #1D4ED8   links and ASINs
    --attention:    #744600 on #FFF3D1   "Title match", "Needs your answer", limit notice
    --loss:         #A33A12   negative profit and destructive actions

    radius: 4px controls · 6px notices and the chip · 3px tags
    spacing: 4px base; panel gutter 16px; row padding 11px 16px; section gap 14px

All text pairs meet 4.5:1. Do not introduce new colors; ask first.

## Type

- **Barlow** 400, 500, 600 for all words. **JetBrains Mono** 400, 500, 600 for every figure,
  model number and ASIN. Both are open-license: bundle the woff2 files in the extension and
  load them locally. Do not link Google Fonts from extension pages.
- Side panel: 14/20 body, 13/18 secondary, 12/16 mono figures and section labels,
  15 semibold app title, 17/23 semibold bundle title, 30/36 mono semibold for the headline
  profit.
- Settings page: 15/22 body, 14/20 help text, 17/24 semibold section headings.
- Section labels ("PARTS · 2") are 12px, weight 600, letter-spacing 0.06em, uppercase, ink-2.
- `font-variant-numeric: tabular-nums` on every figure.
- Sentence case everywhere. No exclamation marks. No emoji.

## Surfaces

### Side panel (Chrome side panel, 360 to 480px wide)

- **Header**: mark, name, **Scan now** (ink), settings icon button. While a scan runs,
  Scan now becomes **Stop** and a one-line progress row appears under the tabs:
  "Scanning · page 3 of 4 · 12 searches used".
- **Tabs**: Deals, This page, Review. A count sits beside the label; Review's count is an
  amber tag when above zero.
- **Deals row** (a link to the detail): title, then brand and model, then price, discount
  and match state; profit and ROI right aligned. Loss rows use the loss color with a real
  minus sign (−). Bundles that need an answer show an amber tag instead of numbers and sort last.
  Under the ROI, a line of the range of the part prices, "ROI −6% to +12%", only when its two ends read
  differently; the headline stays the Amazon New figure.
- **Sort**: Profit, ROI, Lowest ROI, Highest ROI, Discount. ROI is the Amazon New figure; the two others
  are the ends of the range. A real `<select>` or menu button; remember the choice.
- **Detail**: headline profit, then cost, sells-for, after-fees; the estimate line with a
  link to fee settings; one block per part with model, short name, price, net, ASIN link,
  grade, and Verify when the grade is "Title match"; under each part its prices, highest first, each
  labelled with where it comes from ("Amazon · New" in weight, the Buy Box with its seller, reference prices
  such as Amazon's list price and Home Depot's own price marked "not counted"); a part's eBay line last in that
  group ("eBay · New · $38.50–$54.99 · 3 listings, 41 sold", with up to three numbered links to its listings), and
  no eBay line at all, never $0, when no checked listing has sold; the packaging question until answered;
  **Copy ASINs** as the primary action.
- **Review**: one question at a time with real choices, for example "Which impact wrench
  comes with this kit?" with DCF891B and DCF921B as radio options. Answering saves and moves on. An eBay listing the
  check was unsure of is a question in the same list: "Is this eBay listing exactly DCF921B, New, with the same
  contents?", with the listing's title, price, units sold, why the check was not certain, a link to it, and Yes or No.
- **eBay notice**: when a scan skipped or cut short its eBay step (a key missing, refused or limited), one plain
  sentence in the quiet line under the Deals bar. It is not an error: the Amazon and Home Depot figures are unaffected.
- **Footer status bar**: next scan time on the left; searches left with a small meter on
  the right.
- **States to build**: no key (FirstRun), scanning, stopped at a limit (Limit, with the
  reason), nothing found, offline or SerpApi error (plain sentence and a Retry that shows
  its cost), stale data ("Prices seen 4 days ago").

### Scan progress (step 11)

The scan's progress lives in the one row under the tabs; it never becomes a panel of its own.
- **Collapsed, the default.** Line 1: the current step in plain words and its own count
  ("Checking eBay listings · 23 of 60"), and on the right the estimate in the figure face
  ("about 4 min"). Line 2: a 2px determinate bar the full width of the row, ink on line color,
  no rounded ends, no stripes, no animation beyond the width easing (none under
  prefers-reduced-motion). Nothing else: searches used and cost move to the expanded view.
- **Expanded,** by a quiet "Details" text button at the row's right (aria-expanded; the
  choice is remembered). One line a step, in run order: name on the left, a state word
  (done, now, next, skipped) in ink-2 except "now" in ink, and the step's own figure on the
  right ("15 read", "10 searches", "23 of 60", "est. $1.08"; the model step shows "$0.42 so
  far" while it runs). Skipped steps say why in four words or fewer ("no Anthropic key").
  No icons, no checkmarks, no colour coding: the words carry the state.
- **The estimate** is always labelled: "about 4 min", "under a minute", "at least 3 min"
  while the number of parts is not yet known, "estimating" before any step has a measured
  rate. It never counts down by the second; it updates when a step's units change.
- **Accessibility:** the bar is role=progressbar with aria-valuetext ("Step 6 of 8, checking
  eBay listings, about 4 minutes left"); the visible line updates at once; the bar's aria-valuetext is also
  spoken through a polite live region, at most every 5 seconds.
- When the scan ends, the row goes away as today; a stopped or failed scan keeps its existing
  sentences.

### Ask AI on Review questions (step 11)

The AI drafts; the owner decides. A suggestion is never an answer until the owner presses Approve.
- **Entry:** a secondary "Ask AI" text button in the question's action row, after the answer
  controls, with its cost in the figure face ("Ask AI · about $0.02"). Absent when there is no
  Anthropic key (no disabled teaser). One question at a time; no "ask AI for all".
- **While it works:** the button reads "Asking…" and the question stays usable; no spinner.
- **The suggestion** sits inside the question, above the answer controls, as plain text in a
  thin left rule (ink-2 rule, no fill, no card): a label "AI suggestion" in the small caps
  style of section labels, the proposed answer in ink (the reading's parts, or the listing's
  title and ASIN), then at most three quotes, each a short verbatim line in ink-2 with a link
  to its source ("Home Depot page", "Amazon listing"). The answer controls are preselected to
  the suggestion; the primary button reads "Approve" instead of "Save answer".
- **When it cannot tell,** the block says "AI could not tell from the page" with its one-line
  reason, preselects nothing, and the owner answers as before.
- **A suggestion whose quotes fail the code's check** is shown as "AI suggestion, unverified"
  and preselects nothing; the owner must choose.
- Approving records that the answer came from an approved AI suggestion (for the audit:
  agreement rate). Changing the selection before saving records a disagreement.

### AI research and bulk approval (step 12)

Extends "Ask AI". The AI may now research a split question (read the full Home Depot page, search
Home Depot, check the catalog, search the brand's own site) and propose parts even when the tool
offered no reading. Every rule of Ask AI holds: the AI drafts, the owner decides.
- **Ask AI only where it can help.** The per-question button reads "Ask AI · about $0.10" for a
  split question (research) and "Ask AI · about $0.02" for a match question. It is never shown where
  no call would be made.
- **Order of Review.** Suggestions first: the Ask AI row; then "AI suggestions · N" with its rows; then
  the Accept all block ("N bundles have one suggested answer"); then the remaining questions.
- **Ask AI about all.** The first row of Review, alone in its row, a bordered secondary button
  "Ask AI about all 26 · about $3": the words in the word face, a real space either side of the middot,
  only the price in the figure face. It runs the research for every open question in the background.
  Its progress uses the progress row under the tabs ("Asking AI · 7 of 26", estimate, "$0.41 so far" in
  Details) with Stop. The panel stays usable; nothing is preselected until a result arrives.
  The one sentence about how the last asking went ("Asked 26 questions: 18 verified, 8 left for you.
  Cost $0.52.", "Stopped after 4 of 11: 3 verified.") is the row's own, under the button, in ink-2; it
  goes away once the section shows the results, and stays only when the queue stopped on its own and
  the section cannot say why: three researches in a row that ran past their limits or failed, or what
  it cost passing twice the estimate its button showed ("Stopped: asking cost more than expected
  ($0.52). Nothing was applied."). What was suggested stays; nothing is ever applied by the queue.
- **Suggestions first.** The section "AI suggestions · 18" lists one compact row per question: the
  bundle's name (one line, cut with an ellipsis), the proposed parts in the figure face, and one key
  quote on its own line (one line, ellipsis) with its source link at the end of that line. The key
  quote is one that names the answer's models (the one naming the most of them, then the shortest);
  a Home Depot search row's own label ("RYOBI PCL525B (item 318898528): ") is left off the compact
  line, which would otherwise be spent before the quote says anything (the full quote is the hover text
  and shows whole when the row is opened). A row expands to the full suggestion and the question's
  controls, where each quote's source sits at the end of the quote's own line, not on a line of its own.
  Unverified and "could not tell" rows sit in the ordinary list below with their block, never in this
  section.
- **Approve all verified.** The section header carries it at its right, apart from Ask AI about all:
  a quiet text button in ink, semibold and underlined, "Approve all 18 verified" with the count in the
  figure face. Secondary (Accept all is the one ink fill), but it reads as the section's decision.
  It applies only verified suggestions shown in the section, is followed by an inline confirmation
  ("Approve 18 AI answers? Approve · Cancel") and each approval is recorded as an AI approval for the
  audit. The count is the same in the header, the button and the confirmation. The confirmation
  snapshots the rows when it opens: the press applies exactly those, and a row verified meanwhile is
  not included. Accept all stays for single-reading questions with no suggestion.
- **Research sources** are named on each quote ("Home Depot page", "Home Depot search",
  "ryobitools.com"); links are http/https only and open in a new tab.
- **Settings › Listing check** gains "Ask AI after each scan" (a checkbox, off by default; its label does
  not say so again) and shows the research estimate per question.
- No new colours, cards, icons or spinners; the existing AI suggestion block is reused.
- Refinements from the build: "Ask AI about all" is a bordered secondary button, hidden when fewer than
  2 questions can be asked; a suggestion asked for one question stays with that question until answered
  (it joins the section after a reload); during Approve all, a refusal about the moment (a scan or search
  running) stops the run, a refusal about one question is counted and said, and the run goes on; the
  progress row's Details for the queue is one line, "Asking AI · now · $0.41 so far".

### Chip on Home Depot product pages

- A single 40px control placed directly under the price: mark, "Splits into 2 parts",
  estimated profit, ROI, chevron. White, 1px ink border, 6px radius, light shadow.
- Variants: unknown parts ("Splits into 2 parts · Look up prices · 2 searches"),
  not a bundle (no chip at all), needs an answer ("Splits into 2 parts · needs your answer").
- Rendered in a shadow root so the page's styles cannot reach it and its styles cannot leak.
- Clicking opens the side panel on This page. It never covers page content or moves layout
  by more than its own height. If the anchor is not found, do not inject.
- A setting turns it off.

### Settings page (a full tab)

- One column, 880px max. Each section is a two-part row: a heading with one sentence of
  help on the left, controls on the right. It stacks on narrow windows.
- **SerpApi key**: password field, **Check key**, and a result line with plan, searches left
  and hourly limit. Errors are plain: "SerpApi did not accept this key."
- **Scanning**: the frequency radio group, searches per scan, reserve, and the forecast
  block. The forecast is live. When the schedule cannot fit the plan the block turns to
  the attention colors and says so with the fix: "This needs 1,200 searches a month and
  your plan has 150 to spend. Use 5 per scan, or scan less often."
- **eBay reference values** and **Listing check** (step 10, no mockup; same two-part row and fields as the SerpApi
  key): the eBay App ID and Cert ID (masked, **Check eBay keys**, saved only when eBay gives a token), the Anthropic
  key (masked, **Add key**, not checked: a check costs money), the model that reads each listing (a radio group), the
  most listings it may read in a scan, and the estimated cost of that, labelled an estimate. The help says the eBay
  figure is a reference and is not counted.
- **What to scan**, **Fees**, **Alerts**, **Your data** as in the mockup.
- Changes save on change. No Save button. Destructive actions ask once.

## Behaviour

- Keyboard: everything reachable by Tab in reading order; Enter opens a row; Escape goes back
  from Detail; visible focus ring (2px ink outline, 2px offset).
- Motion: none beyond 120ms opacity on view change. Respect `prefers-reduced-motion`.
- Loading: keep the last data on screen and show the progress row. No full-panel spinners,
  no skeleton shimmer.
- Numbers: currency with two decimals; a leading + on profit, a real minus on loss; ROI as a
  whole percent. Times in his locale, relative only when under an hour.
- Real elements only: `<button>`, `<a href>`, `<input>` with `<label>`, `<fieldset>` and
  `<legend>` for groups. No clickable `<div>`.
- Dark mode is not in v1. Do not half-build it.

## Words

- Buttons are verbs: Scan now, Stop, Verify, Look up, Copy ASINs, Check key.
- Errors say what happened and what to do, in one sentence.
- Vocabulary is fixed: bundle, part, listing, search, scan, estimate. Do not mix in
  "item", "component", "query" or "credit" in the UI.

## Do not

- No component library or CSS framework defaults. Write the CSS, using the tokens.
- No gradients, glows, glass, or drop shadows in the panel.
- No emoji, no decorative icons, no illustrations. The few icons are 1.5px stroke SVG.
- No colored left borders on boxes, no pill-shaped everything, no large rounded cards.
- No invented data in empty states. An empty list says why it is empty.
- No Home Depot or Amazon colors, logos or layouts anywhere in the extension.
