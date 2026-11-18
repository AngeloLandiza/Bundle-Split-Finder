# Instructions for the blind checker

You label Amazon listings for a tool that splits Home Depot bundles into their parts and matches each
part to its Amazon listing. You decide, for each part, which listings **are** that part. You never see
what the tool chose, and you must not try to find out. Give these instructions, unchanged, to whoever
labels: a Claude Code subagent, another model, or a person.

## What you get, and what you must not open

- Read only `blind.json` in the audit folder you were given (for example `audit/2026-11-20/blind.json`).
- Do not open `tool.json`, `failures.md`, `fixtures/audit/corpus.json`, any `results-*.json`, or the
  extension's data. Do not run `npm test`, `npm run audit` or `npm run validate`: their output shows the
  tool's choices.
- Do not open Amazon or Home Depot pages, and do not search the web. Label from the titles, brand fields
  and model numbers in `blind.json` only. The links are there so a person can check your labels later.

`blind.json` holds the audited bundles. Each has its Home Depot `itemId`, `model`, `title` and `link`, the
`split` (its parts), and per part its `model`, `qty` and `candidates`: listings with `asin`, `title`,
`brand` (Amazon's brand field, `null` when not known), `price`, `reviews` and `link`. Candidates are in
ASIN order; the order means nothing.

## The rules

A listing **is the part** only when all of these hold:

1. **Same brand.** The brand field is the part's brand (DEWALT or RYOBI), or, when the brand field is
   empty, the title begins with the brand ("Ryobi PCL265 …"; "TTI Ryobi …" counts, TTI makes RYOBI). A
   different brand field (TTI, a reseller, a third-party maker) is never certain: put it under
   `uncertain` at most.
2. **The model as a whole token in the title.** `PCL430B` must appear in the title on its own, not
   inside a longer code. RYOBI's tool-only B is allowed both ways: `PCL430` and `PCL430B` are the same
   tool. Nothing else is: `DCB205-2` (a 2-pack) is not `DCB205`, `PSK014` is not `PSK0114`, `DCK421D2` is
   not `DCK420D2`, and a kit `PCL265K1` is not the tool `PCL265B`. A model only in the URL, or a kit
   described word for word but with no model in the title, is `uncertain`, never correct.
3. **New, and the part alone.** Never the part: Renewed, refurbished, used or open-box listings;
   accessories and spare parts (an "OEM" part number with a part name such as chute, pad or knob);
   "for Ryobi", "fits", "compatible with" and "replacement for" listings, even when they quote the exact
   model; the part bundled with something else (a kit "with Circular Saw", a drill "with 40-piece bit
   set"). The pack size must be the part's: a part that is a 2-pack (`DCB203-2`, `PBP2003`) is the
   2-pack listing; a single battery is not a 2-pack listing.
4. **A kit part is the kit.** When the part is itself a kit (DEWALT `DCK…`, RYOBI `PCL1600K2`), the
   listing is the kit sold whole. When the part is a tool from a kit, the listing is that tool sold alone.
5. **Uncertain is kept separate.** When a listing might be the part but its title does not settle it,
   put it under `uncertain`, not `correct`. Never guess. A candidate whose `title` is `null` can only be
   `uncertain`.

Label a part the same way in every bundle that holds it, and a RYOBI part and its B twin the same way.
You may use a listing that appears under another part of `blind.json` if it is this part (Amazon often
lists a part in another part's results).

## What you write

Write `labels.json` next to `blind.json`, in exactly this form:

```json
{
  "about": "Blind labels for audit <date>, from blind.json only, by <who>.",
  "labels": {
    "<bundle model>": {
      "<part model>": {
        "correct": ["<ASIN>", "..."],
        "uncertain": ["<ASIN>"],
        "note": "One line: why, quoting the title that decides it."
      }
    }
  }
}
```

- `correct`: every ASIN that is the part (more than one when Amazon lists it twice), or the string
  `"none"` when no candidate could be it.
- `correct: []` with `uncertain`: only uncertain listings.
- `uncertain` is optional; leave it out when there is none.
- Every part of every bundle gets a label, keyed by the bundle's `model` and the part's `model` exactly as
  `blind.json` writes them.
- Every candidate you do not list under `correct` or `uncertain` counts as **not the part**. That is a
  label too, and it is tested forever, so list under `uncertain` anything you are not sure is wrong.

Finish with a short report to whoever asked: counts (parts with a listing, `none`, uncertain only), the
hardest calls and why, and anything in the candidates that looked wrong (duplicate rows, missing prices).
