# Bundle Split Finder: prototype

Core logic for the Bundle Split Finder spec. No network calls, no API keys.
It proves the three hard parts on real data before the full build.

    python3 -m pytest -q        # 43 tests

| File | What it does |
| --- | --- |
| `bsf/identifiers.py` | Validates barcodes and normalises them to 12-digit UPC |
| `bsf/hd_page.py` | Reads price, model, barcode and component ids from a Home Depot page |
| `bsf/decompose.py` | Splits a bundle model number into component model numbers |
| `bsf/match.py` | Grades Amazon listings for a component: exact, strong, review, reject |
| `bsf/optimize.py` | Finds every listing combination for a bundle and the best one |
| `bsf/money.py` | Fee math and the packaging rule (where each part may be sold) |
| `tests/fixtures.py` | Real data captured 2026-11-09, with the source of each block |

Not in the prototype: fetching retailer pages, Amazon SP-API calls, storage, UI.
Those are specified in the product spec.
