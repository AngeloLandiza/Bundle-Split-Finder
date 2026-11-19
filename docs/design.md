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
