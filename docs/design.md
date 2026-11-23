# Design spec

The look is a workshop ledger: paper, ink, hairlines and aligned figures. It is a tool a
reseller keeps open beside a product page all day, so it is dense, quiet and exact.

This is the Chrome extension's system. The desktop app is a native Mac app with its own system on
the system's colours and font: see **Desktop app** below. Principle 3 ("Ink does the work") and the Tokens, Type, Behaviour
and Do not sections describe the extension; the product rules (estimates labelled, sources linked,
prices on paid controls, no emoji, the Words) hold for both.

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
  grade, and Verify when the grade is "Title match"; a lookup whose titles only name the model on
  accessories reads one product page itself, and a page whose part number is the model is an ordinary
  Verified match, with no extra button; under each part its prices, highest first, each
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
- **Ask AI on every Review question.** The per-question button reads "Ask AI · about $0.10" for a
  split question (research) and "Ask AI · about $0.02" for a match question that has a listing to
  choose. A match question with no listing still gets the button, reading "Ask AI" with no price:
  pressing it makes no model call and says so. The button is on Review, on This page (once the
  question is saved), on Detail's open split question, and on a part in Detail whose match question
  is still open. It is absent when no Anthropic key is saved. Ask AI about all still asks only where
  a call would be made, so it does not queue an empty match. eBay yes/no questions have no Ask AI.
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
- **Your data** also has **Delete all data**. It deletes every deal, match, answer, confirmed price
  and saved search, and asks once. Keys, settings and the searches already counted stay. It waits
  while a scan, a Look up, a Verify, Ask AI or a kit-page read is running.

### Read a kit page

A kit whose own Home Depot page is not stored is named in the estimate band: "PCL1600K2's contents
are not known yet: its Home Depot page has not been read." Under that sentence, Detail and This
page offer **Read PCL1600K2 page**. It reads that one page in the browser, the same page a scan
would read, and it spends no search. The button is disabled while a scan, a Look up, a Verify or
Ask AI is running, and the line says when it can be pressed.

A kit with no Home Depot item id yet has no button. The line says the next scan has to find the
kit on Home Depot before its page can be read.

The button is not a price. An unread kit does not offer Confirm sell price: the tools inside it
are not known, and a price on the kit would count the whole box as one part. After the page is
stored, the kit splits into the parts its Includes list names. A part that was looked up and still
has no Amazon New price keeps Confirm sell price. Nothing is copied off a pasted link.

### Confirm a sell price

A part with no counted Amazon New price, and that has already been looked up, offers a form inside
the part: **Price** and **Listing link**, then **Save price** (a bordered secondary button, the same
control as packaging's Yes / No). The form sits under the part's prices, separated by a hairline.
The heading is "Confirm sell price". The help says the part counts at $0 until a price is entered,
that the price is the one he saw, and that an eBay or Facebook link is enough. The link is not read.
**Change price** and **Remove price** are text buttons once a price is saved. While a scan runs,
Save price is disabled and the line reads "A scan is running. Save the price when it has finished."
When several of these forms sit in one list, that line is said once above them.

A part still in Review does not show the form. The match question is on that part, in Detail and
on This page, with Ask AI. The part does not also say "Needs your answer in Review": the question
is the instruction. Approving a listing is what sets the Amazon price.

When the part's Amazon listing is not for sale, the tag says "Listing inactive". Its last price is
under Reference, labelled "Last Amazon price". It is not the big price, and it has no "nets" line.
The form does not repeat that the listing is not for sale. It says a price he confirms counts until
the listing is for sale again. It then stays in the list as "Confirmed by you" under Reference.

Stored eBay listings that have their own price are buttons under the heading ("Count $22.00", and
Open listing). Counting one saves that price. Those prices are not also links in the reference
line: the line keeps the range ("eBay · New · $22.00–$30.00 · 2 listings, 4 sold"). Under the
buttons, "Or enter a price and a link" is the other path, with its own Save price. A range with no
per-listing price offers no button, and its listing links stay in the reference line, reading
"Listing 1". The same links stay when the form is not shown (an active Amazon price, a part still
in Review). The median stays under Reference. A Facebook link is enough.

A charger or bag the page names without a model number uses the same form. The help says it has no
model number, so it is not looked up, and it counts at $0 until he enters the price he saw and a
link. No model number is invented. On Detail, one that is in the estimate on screen is listed
under **NO MODEL NUMBER**. One that is only in another way to sell is priced on that way, under its
profit, and the form is there once even when two ways include it. On This page, which has no ways
list, every such item is under **NO MODEL NUMBER**. One that is not in the estimate above says which
way it counts in, and once a price is stored, that way's estimated profit.

The bundle stays in Missing listing or Inactive listing: a confirmed price is not an Amazon listing.
A part not looked up yet has no form. The AI does not invent a dollar amount.

## Desktop app (step 14: native)

The desktop app is a Mac app, not a web page in a window. It follows macOS conventions, not this
spec's ledger system: **the Chrome extension keeps its own system** (paper, ink, Barlow, JetBrains
Mono, everything above this section), and nothing below applies to it. The product rules carry over
unchanged: every estimate is labelled as one, every price, match and question links to its source, a
paid action shows its price on the control, no emoji, a real minus on a loss, sentence case, the
fixed vocabulary in Words. Built in `desktop-ui/src/` (components in `components/`, screens in
`screens/`); there is no mockup, so this section is the reference.

### Window

- Created in code (`src-tauri/src/shell.rs`, `native_chrome`): `TitleBarStyle::Overlay`, title
  hidden, traffic lights at (20, 26) so they sit centred in the 52px toolbar band, full-size
  content, minimum 1000×680. `transparent(true)` plus the **Sidebar** window effect following the
  window's active state (needs `macOSPrivateApi`); the page leaves its sidebar clear so the material
  shows through, and paints the content column solid (`--content-bg`).
- The init script tells the page `__SPLIT_FINDER_SHELL__.chrome = 'unified'`; the page sets
  `data-chrome="unified"` on `<html>`. In a browser (`npm run ui:mock`) the sidebar gets a flat
  stand-in colour instead; vibrancy only exists in the app.
- Drag regions: the toolbar (`data-tauri-drag-region="deep"`: anywhere but a control), the sidebar's
  52px title band and its empty space. Double-click zooms. The remote dashboard may call only
  `start_dragging` and `internal_toggle_maximize` (capabilities/agent-ui.json).
- Close hides to the menu bar; the menus carry the shortcuts (below).

### Menu bar popover

A left click on the menu bar icon toggles a small borderless window under it (`src-tauri/src/popover.rs`;
the page is the same dashboard at `#/popover`, `screens/PopoverApp.tsx`); a right click keeps the tray
menu. 340x420, the Popover material with 10pt corners, floating above other windows and on every Space,
no title bar, no Dock or Cmd+Tab entry of its own. It hides when it loses focus, on Esc, and when a row
or a menu item opens something else.

- **Header**: the name, and the agent's state at the right: Idle, Scanning (a spinner), Asking AI,
  Paused, Chrome closed and Agent offline (both in the attention colour). While a scan runs a quiet line
  says "Step N of M" with the agent's own stage, over a 3px bar.
- **Needs you · N**: the agent's open count, then the first three questions as the Today screen orders
  them (AI-verified first, then oldest). A row opens the main window at that question. "N more
  questions in Review" when there are more; "Nothing needs you" at zero.
- **Best deal**: the highest estimated profit among bundles with an estimate and no open question, with
  its profit and ROI, and the line "Profit and ROI are estimates from your fee settings." A row opens it.
  The deal rows carry no "first seen" date, so this is the best of what the last scan holds, not only of
  what it found new.
- **Actions**: Scan now with its price (Stop while one runs), Pause (Resume while paused). Under a hairline,
  the menu rows: Open Split Finder, Preferences... (Cmd+,), Quit Split Finder (Cmd+Q); the row under the
  pointer takes the selection colour, as in a menu.
- It reads the agent only while it is on screen: when it opens it loads the state, the questions and the
  deals once, then follows the event stream (a review or deals event reloads that list once after 400ms
  of quiet). Hidden, it holds no stream and makes no request.
- **Dock badge**: the open-question count on the Dock icon, clear at 0, and none while the Dock icon is
  hidden (Preferences > General). With the Dock icon hidden the menu bar icon carries the count as text
  instead; with it shown the menu bar icon is the plain icon.

### Tokens (`desktop-ui/src/base.css`)

Every colour is a `light-dark()` literal first, then WebKit's semantic system colour where one
exists (`@supports (color: -apple-system-label)`), so inside the app the window reads the real system
colours, including Increase Contrast; another browser reads close copies.

    --label, --label-2, --label-3, --label-4   -apple-system-label / secondary / tertiary / quaternary
    --placeholder                             -apple-system-placeholder-text
    --separator, --grid                       -apple-system-separator / -grid
    --content-bg, --control-bg, --text-bg     -apple-system-control-background / text-background
    --grouped-bg, --group-bg                  the grouped ground and its boxes (System Settings)
    --sidebar-bg                              stand-in for the sidebar material outside the app
    --accent                                  -apple-system-control-accent, or a chosen accent
    --selection, --selection-quiet            -apple-system-selected-content-background / unemphasized
    --profit, --loss, --attention             system green / red / orange, darkened in light mode
                                              for 13px text; tinted backgrounds for badges
    --fill, --fill-2, --hover                 quiet fills for tracks, wells and hover

- **Appearance**: `color-scheme: light dark` follows the system; `data-appearance="light|dark"` on
  `<html>` forces one. **Accent**: the system's, or `data-accent` = blue, purple, pink, red, orange,
  yellow, green, graphite (the macOS accent colours). **Density**: `data-density="compact"` tightens
  rows (`--row` 28→24, `--row-2` 44→36) and the gutter. The look lives in the browser storage of this
  Mac (`lib/appearance.ts`), set from View options now and from Preferences (D2) later.
- Profit is green and a loss red, from the system palette; "needs you" is orange. Nothing else carries
  a colour except the accent.
- Radius: 5px controls, 6px toolbar items and selection, 10px group boxes, 12px a sheet's corners.

### Type

The system font: `-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui`.

    13/16           body, table rows, controls (AppKit's regular size)
    11/14           small labels, secondary lines, status bars, table heads, sidebar section heads
    15/20 semibold  headline: the toolbar title, a bundle or question in the inspector
    20/24 semibold  page title (the welcome sheet)
    26/32 semibold  large figures: Today's four figures, the inspector's estimated profit

Money, ROI and counts take tabular numerals (`.fig`). SF Mono (`ui-monospace`, `.code`) is only for
model numbers and ASINs (and keys typed into a field); a number field is tabular, not mono.

### Layout

- **Sidebar** (`components/Sidebar.tsx`), 220px: a 52px band for the traffic lights, then a source
  list. Today; **Deals** with its saved views, each with its count: **Worth buying now** (first, its count
  in the accent: the last scan's own verdict, `buyNow`), All deals, Confirmed, Needs an answer, Waiting
  for a lookup, Losing money, **Watchlist** (`lib/views.ts`; a view is a question about the row's own
  fields, and a bundle with no estimate is never "losing"); **Agent**: Review with its badge (the
  accent when above zero), Activity, Settings. Section heads are 11px semibold tertiary with a
  disclosure on hover; a collapsed section is remembered. Rows are 28px, 6px radius; the selected one
  is a grey rounded rectangle with its glyph in the accent. At the foot: "Finish setup · N of 3" while
  setup is open, then the agent's state (a spinner and a bar while it runs), the next scan, searches
  left with a level meter, and Chrome's state.
- **Glyphs** (`components/Glyph.tsx`): 16px, monochrome, drawn in the manner of SF Symbols, only where
  a Mac source list, toolbar or field carries one. Never decorative.
- **Toolbar** (`components/Toolbar.tsx`), 52px, in the title bar: the screen's title (15 semibold) and
  one 11px line under it; then the screen's own items (Download CSV, Ask AI about all), **Scan now ·
  N searches** (while a scan runs: a progress ring, "Scanning 34%", and Stop; Resume while paused), the
  search field, **View options** (a popover: the screen's own options, then Appearance, Accent colour,
  Density) and, on Deals and Review, the inspector toggle.
- **Banners** under the toolbar for the whole app (agent offline, Chrome closed or not connected, no
  key, at the reserve, a pairing request): one line, a warning glyph when it needs him, its one fix.
- **Inspector** (`InspectorSplit` in `components/Layout.tsx`): on Deals and Review, at the right,
  380px by default, 300–640 by dragging the divider (or arrow keys on it), remembered; Cmd+Option+I or
  View > Show or hide inspector. With nothing selected it says "No bundle selected" in the middle.
  Opening a row shows it again if it was hidden. Esc deselects and focus returns to the row.
- **Grouped screens** (Today, Activity, Settings): the grouped ground, sections as a 13px semibold
  title with its count and action, over one rounded group box; rows inside separated by inset
  hairlines. One level: no box in a box.

### Screens

- **Today**: four large figures (Open questions, Best estimated profit with its model, Bundles found,
  Searches left), then Needs you (rows with a badge and a chevron, AI-verified first), **Worth buying now**
  when any bundle has that verdict (the same rows; the link opens that view), otherwise Best deals (bundle,
  price, est. profit, ROI with its range; the estimate note under the box; an estimate below zero is never
  listed), and the Agent card
  at 320px (state and stages, Pause, then label / value rows: last scan, next scan, searches left with
  its meter, Keepa, AI this month, Chrome). One column under 1180px.
- **Deals**: the table fills the content; the title is the sidebar's view. Columns drop by the table's
  own width (container queries): Off and Updated under 900px, Match under 720px (its badge moves into
  the profit cell), Price under 560px. A first narrow column holds the **watch star**, a real toggle button
  (hollow, or filled in the accent; `aria-pressed`; Tab and Space): the one glyph in a row, allowed because it acts.
  The title cell carries a green **Buy now** tag (text only) when the last scan found it worth buying and a
  neutral **BOGO** tag when a promotion was entered. The Section filter is in View options. A status bar at the foot
  says how many show and that profit and ROI are estimates.
- **Deal inspector**: brand, title, model · price · off, "Open on Home Depot" with when the price was
  seen; one box with the estimated profit at 26/32, ROI, and the three figures (Bundle costs, Parts sell
  for, After fees), the fee basis with Change; a banner if it needs an answer; Ways to sell and Parts as
  group boxes (each part with its grade badge, ASIN link, prices and their sources); Copy ASINs at the
  foot. A watched bundle adds, in this order: **Watch / Unwatch** under the title; **Signals** (the verdict
  as a headline and one sentence, then Margin against the last scan and the 7-day average with the figures,
  Sales as "Sells about N a month (Keepa)" or "No sales data — Keepa leaves it out for slow sellers", and
  Review cleared or Confirmed when the scan said so; labelled as estimates); a **FBA estimate (Keepa)** line
  inside the estimate box, beside the main figure and never replacing it; **BOGO** when a promotion exists
  ("BOGO: choose your free tool", Choose or Change in a sheet, the estimate with the free tool's parts and
  "+ free tool not counted yet" until they are priced, Remove); and **History**, inline SVG
  (`components/HistoryChart.tsx`): a segmented Prices (what you pay at Home Depot dashed, Amazon New counted
  parts in the accent), Profit (green above zero, red below), Sold a month and, only when a scan stored one,
  Sales rank. Thin lines, separator gridlines, secondary-label axes, a hover or arrow-key crosshair with a
  value tooltip, a gap where a scan had no figure; under two scans: "History starts after two scans."
- **Review**: the questions in the content, grouped AI verified (with Approve all N, confirmed in
  place) then Needs you; a status bar with the keys. The inspector (at least 440px) holds the question:
  the kind, the question at 15 semibold, the bundle and its links, Why it is asked with its quotes, the
  AI block in a group box (green edge when the code verified it), the choices as one box of radio rows
  with their number keys, and Approve or Save answer at the foot.
- **Activity**: Needs attention, Autopilot with Undo, Runs as a plain table in a group box.
- **Settings**: not a screen. The sidebar's Settings item, Cmd+5, Cmd+, (app menu and tray) and any
  `#/settings/<section>` link open the Preferences window (below) and leave the screen that was open as
  it was.

### Controls

- **Push button** (`Button`): 22px (20 small, 28 large); `secondary` is the raised key, `primary` the
  default button filled with the accent (one per view), `quiet` borderless, `danger` red words,
  `toolbar` a borderless 28px toolbar item with a glyph. A busy button shows a small spinner and its
  busy words. A paid action keeps its price after a middot.
- **Pop-up button** (`Select`): a push button with the double chevron in an accent well.
- **Switch**: NSSwitch, the words at the start, the switch at the end. **Checkbox, radio**: the
  system's, in the accent. **Segmented control**: a sunken track, the chosen segment raised.
- **Search field**: a rounded well, the magnifier, a clear button once typed; Esc clears it; Cmd+F
  focuses it.
- **Text field**: a hairline inset, the focus ring in the accent (3px at half strength).
- **Table**: a header with column lines and a sort chevron, no zebra, a hover tint, the selection in
  the accent with white text while the window is key and grey when it is not, the focus ring inset.
- **Badges** (`Tag`): 18px, 4px radius: attention (orange), verified (green, with a check), neutral.
- **Progress**: a determinate 4px bar in the accent; an eight-spoke spinner for work of unknown
  length (a first load, a busy button). Loading is a spinner and the word, centred.
- **Empty views**: centred, grey, a 15px title, one line that says why, one action. Never invented data.
- **Tooltips**: the native ones (`title`), with the shortcut where there is one.
- **Popover**: from a toolbar item; a light panel with the system's shadow; Esc or a click outside
  closes it.

### Sheet and first run

The welcome **sheet** (`components/Sheet.tsx`, `screens/Welcome.tsx`) slides down from under the
title bar over the live window, which dims and goes inert behind it. Header: the app's mark in an
icon tile, "Welcome to Split Finder" and one paragraph. A three-step indicator (Chrome, SerpApi key,
First scan; a check on each done), then the step as a short form: Install the Chrome helper and allow
the pairing code; the SerpApi key field; Scan now with its price and the scan's progress. Footer:
**Skip for now** at the start, Back and **Continue** (Done on the last step) at the end. Esc skips;
Tab stays inside. It opens by itself once on a first run; the sidebar's "Finish setup · N of 3" and
Help > Finish setup open it again at the first step still open. **Setup never blocks the app.**

### Keyboard

    Cmd+1-4            Today, Deals, Review, Activity
    Cmd+, or Cmd+5     Settings: the Preferences window
    Cmd+F              the screen's search field (also the shell's Edit > Find)
    Cmd+Option+I       show or hide the inspector (also View > Show or hide inspector)
    Cmd+R              Scan now (Agent menu)
    J / K, ↓ / ↑       next / previous row or question
    Return             open the row; in Review, save or approve
    1-9                Review: pick that choice
    A                  Review: Ask AI on this question
    Esc                close a popover or the sheet, clear the search, deselect

Letters and digits never act while he types in a field, and Return never takes a press from a
focused button. The focus ring is the accent at half strength, 3px.

### Notifications

Native notifications and the Telegram digest use the same words, short, with no keys and no
links that carry one. Title, then one line:

- "3 new deals" / "PCL1600K2: est. +$124.34, ROI 62%. Open Today to see all three."
- "2 questions need you" / "Autopilot answered 4. The other 2 wait in Review."
- "Autopilot applied 4 answers" / "Each can be undone in Activity."
- "Scan stopped at the limit" / "20 searches left, all in reserve. Scans start again on Dec 1."
- "Chrome is closed" / "4 Home Depot pages wait. They are read when Chrome opens."

Profit in a message is an estimate and says "est.". No exclamation marks, no emoji.

### Preferences window

A second Tauri window (`src-tauri/src/prefs.rs`), one instance (opening it again focuses it and switches
the tab), 720pt wide and as tall as its pane: the page reports the pane's height (`set_preferences_height`)
and the window follows, top edge fixed; the width cannot change. Close hides it, as the main window does.
It loads the same UI bundle at `#/preferences/<tab>` (`screens/preferences/`) with the same token, in a
unified title bar with no sidebar material. Traffic lights sit in a 28pt band that holds the pane's name
and, at the right, a quiet **Saved** (a check and the word, for two seconds after each save); the toolbar
of tabs is under it, each an icon over its label (22px glyph, 11px label), the chosen one on a grey
rounded rectangle with its glyph in the accent. Left and Right move between tabs.

The panes are the macOS preference layout, not group boxes: a 190px column of right-aligned labels, then
the control, with 11px help under it, hairlines between groups. Every change saves as it is made (typing
waits 600ms, so it is one save). A field checks its value first (`lib/prefs.ts`, the agent's own limits)
and says why under itself instead of saving; a refusal by the agent shows as one line at the top of the
pane and the pane re-reads what the agent holds.

- **General**: Appearance (System, Light, Dark, each a small window preview; System is both halves),
  Accent colour (swatches and its name), Density; Open at login; Show menu bar icon and Show Dock icon
  (the last one that is on is disabled and says why: with both off there is no way back in); Sounds.
- **Scanning**: schedule (Off, Every N hours, Daily at a time), searches per scan, reserve, the month's
  forecast, brands, the five fees with a line that they are estimates, Keepa tokens per scan and reserve.
- **Keys**: one row each for SerpApi, Keepa, Anthropic, OpenAI-compatible, eBay and Telegram: Saved or
  Not set, Replace, Remove (with a confirmation line), a "Get a key" link. Fields are always empty; a key
  is never read back.
- **AI**: Autopilot (off by default, with what it may apply and that Undo exists), the monthly cap with this
  month's spend, then per pipeline (Listing check, Ask AI, Research) provider, model, base URL for an
  OpenAI-compatible provider, and Trusted for Autopilot (the agent resets it when the model changes; the
  window shows the agent's answer).
- **Notifications**: a switch per kind, the figures for "worth buying now" (ROI, profit, sold a month,
  profit floor and its digest switch), digest, quiet hours, Telegram status, a test notification to this Mac.
- **Chrome**: status, Install the Chrome helper, requests waiting with their code and Allow or Deny,
  paired Chromes with Revoke.
- **Data**: Export deals as CSV, the data folder and Show in Finder.
- **Advanced**: the agent's state and address, the app's version, the data folder, where logs are.

Not in the window because the agent has no endpoint for it: a Telegram test message, Reset scan data,
Export audit file, Restart agent, and the agent's own version and Node version.

### What D2, D3 and D4 build on

- **D2 Preferences window**: a second Tauri window created in `shell.rs` the same way
  (`native_chrome` gives the unified title bar; a preferences window wants no sidebar effect, so pass
  a plain background). Reuse `Switch`, `Select`, `Segmented`, `TextField`, `Section` group boxes and
  `lib/appearance.ts` (`readLook`, `saveLook`, `applyLook`) so General > Appearance writes the same look.
- **D3**: the command palette and context menus are popovers (`components/Popover.tsx` styling, the
  `--popover-bg` material); shortcuts go through `lib/keys.ts` `globalKey`; rows already carry their
  route (`hashOf`).
- **D4**: the menu bar popover is its own small window; it reads the same tokens (`base.css`) and
  `agentWords` / `ProgressBar` / `Spinner` for the agent's state.

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
- Dark mode is not in the extension's v1. Do not half-build it. (The desktop app has light, dark and
  follow the system; see Desktop app > Tokens.)

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
