"""Real data captured on 2026-11-09. Each block says where it came from.

Nothing here was fetched by this code: the sandbox has no access to retailer
sites. The values were read from the live pages and typed in as fixtures.
"""

from bsf.decompose import CatalogModel
from bsf.match import Candidate

# --- Home Depot bundle page, read in a real browser (JSON-LD + embedded page state).
# https://www.homedepot.com/p/.../328814689
HD_BUNDLE = {
    "productID": "328814689",
    "model": "PBLRC2501SB",
    "sku": "1010927962",
    "gtin13": "0033287232581",
    "upc": "033287232581",
    "brand": "RYOBI",
    "price": 189.00,
    "strikethrough_price": 338.00,
    "productType": "MERCHANDISE",
    "bundleFlag": None,
    "title": "RYOBI ONE+ HP 18V Brushless Cordless 1/4 in. and 3/8 in. Extended Reach Ratchets (Tools Only)",
    # Item ids attached to the reviews shown on the bundle page.
    "review_product_ids": ["316631066", "316631068", "328814689"],
}

# Home Depot item id -> model. 316631066 is printed on Home Depot's own page for
# PBLRC01B. 316631068 is inferred: it is the only other component id on the bundle
# page, and a Q&A entry there is attributed to PBLRC25B.
HD_ITEM_MODEL = {"316631066": "PBLRC01B", "316631068": "PBLRC25B"}

# An older Home Depot listing of the same pair, model number spelled out.
HD_OLD_BUNDLE_MODEL = "PBLRC01B-PBLRC25B"

# --- Amazon listings, as shown on Amazon's own pages (via search-engine copies).
ASIN_3_8 = Candidate(
    asin="B0B3JWF5ZV",
    title="RYOBI ONE+ HP 18V Brushless Cordless 3/8 in. Extended Reach Ratchet (Tool Only) - PBLRC25B",
    brand="RYOBI",
    part_number="PBLRC25B",
    package_qty=1,
)
ASIN_1_4 = Candidate(
    asin="B0B6Z2ZGVK",
    title="RYOBI ONE+ HP 18V Brushless Cordless 1/4 in. Extended Reach Ratchet (Tool Only) - PBLRC01B",
    brand="RYOBI",
    part_number="PBLRC01B",
    upcs=("033287193714",),
    package_qty=1,
)
# Titles below are real Amazon titles seen next to the two listings above; their
# ASINs were not captured, so the ids are placeholders.
DECOY_RENEWED = Candidate("DECOY-RENEWED", "RYOBI 18V ONE+ HP Brushless 3/8'' Extended Reach Ratchet Green (Renewed)", "RYOBI")
DECOY_OTHER_MODEL = Candidate("DECOY-PCL280B", "RYOBI ONE+ 18V Cordless Multi Size Ratchet (Tool Only) PCL280B", "RYOBI", "PCL280B")
# Invented decoys, to exercise each rejection rule.
DECOY_KIT = Candidate("DECOY-KIT", "RYOBI PBLRC25B 3/8 in. Ratchet Kit with Battery and Charger", "RYOBI")
DECOY_2PACK = Candidate("DECOY-2PACK", "RYOBI 3/8 in. Extended Reach Ratchet PBLRC25B (2-Pack)", "RYOBI", "PBLRC25B")
DECOY_BRAND = Candidate("DECOY-BRAND", "Replacement for RYOBI PBLRC25B ratchet", "Generic", "PBLRC25B")
DECOY_TITLE_ONLY = Candidate("DECOY-TITLE", "RYOBI Extended Reach Ratchet PBLRC25B", "RYOBI")
DECOY_BULK = Candidate(
    "DECOY-BULK",
    "RYOBI 3/8 in. Extended Reach Ratchet PBLRC25B (Bulk Packaged, Non-Retail Packaging)",
    "RYOBI",
    "PBLRC25B",
)

RYOBI_CATALOG = {
    m.model: m
    for m in [
        CatalogModel("PBLRC01B", "RYOBI", ("ratchet",)),
        CatalogModel("PBLRC25B", "RYOBI", ("ratchet",)),
        CatalogModel("PCL280B", "RYOBI", ("ratchet",)),
    ]
}

# --- DEWALT. Model numbers are real; "kinds" are the words Home Depot titles use.
DEWALT_CATALOG = {
    m.model: m
    for m in [
        CatalogModel("DCF891B", "DEWALT", ("impact wrench",)),
        CatalogModel("DCF921B", "DEWALT", ("impact wrench",)),
        CatalogModel("DCS356B", "DEWALT", ("oscillating",)),
        CatalogModel("DCS354B", "DEWALT", ("oscillating",)),
        CatalogModel("DCB205", "DEWALT", ("battery", "batteries")),
        CatalogModel("DCB205-2", "DEWALT", ("battery", "batteries")),
        CatalogModel("DCB240", "DEWALT", ("battery", "batteries")),
        CatalogModel("DCB240-2", "DEWALT", ("battery", "batteries")),
        CatalogModel("DCB606", "DEWALT", ("battery", "batteries")),
        CatalogModel("DCD805B", "DEWALT", ("hammer drill",)),
        CatalogModel("DCS369B", "DEWALT", ("reciprocating saw",)),
        CatalogModel("DCS380B", "DEWALT", ("reciprocating saw",)),
        CatalogModel("DCV517B", "DEWALT", ("vac",)),
        CatalogModel("DCS334B", "DEWALT", ("jigsaw", "jig saw")),
        CatalogModel("DCS331B", "DEWALT", ("jigsaw", "jig saw")),
        CatalogModel("DCW600B", "DEWALT", ("router",)),
        CatalogModel("DCF513B", "DEWALT", ("ratchet",)),
        CatalogModel("DCS565B", "DEWALT", ("circular saw",)),
        CatalogModel("DCBL722B", "DEWALT", ("blower",)),
    ]
    + [
        CatalogModel(k, "DEWALT", (), True)
        for k in [
            "DCK940D2", "DCK420D2", "DCK283D2", "DCK226D2", "DCKTS681D1P1", "DCK2100",
            "DCK694P2", "DCK2050M2", "DCK661D1M1", "DCK2051D2", "DCK350T2", "DCK411Q2",
            "DCKTS650D1P1",
        ]
    ]
}

# (Home Depot model number, Home Depot title, expected parts). Model numbers and
# titles are from Home Depot search listings; expected parts are read from the title.
HD_DEWALT_BUNDLES = [
    ("DCK940D2WCF891B", "20V MAX Cordless 9 Tool Combo Kit and 20V MAX XR Cordless 1/2 in. Impact Wrench with (2) 20V 2.0Ah Batteries and Charger", ["DCK940D2", "DCF891B"]),
    ("DCK420D2W356", "20V MAX Cordless 4 Tool Combo Kit, Brushless Oscillating Tool, and (2) 20V 2.0Ah Batteries", ["DCK420D2", "DCS356B"]),
    ("DCK283D2W205", "20V MAX Cordless Brushless Drill/Impact 2 Tool Combo Kit and (2) 20V 2.0Ah and (1) 5.0Ah Batteries", ["DCK283D2", "DCB205"]),
    ("DCK283D2W517B", "20V MAX XR Cordless Brushless Drill/Impact 2 Tool Combo Kit, 20V MAX 1/2 Gal Wet/Dry Vac, and (2) 20V 2.0Ah Batteries", ["DCK283D2", "DCV517B"]),
    ("DCK226D2WCS369B", "20V MAX Lithium-Ion Cordless Combo Kit (2-Tool) and ATOMIC 20V MAX Cordless Brushless Compact Reciprocating Saw", ["DCK226D2", "DCS369B"]),
    ("DCKTS681D1P1W34", "20V MAX ToughSystem Lithium-Ion 6-Tool Cordless Combo Kit and 20V MAX XR Cordless Brushless Jigsaw", ["DCKTS681D1P1", "DCS334B"]),
    ("DCKTS681D1P1W05", "20V MAX ToughSystem Lithium-Ion 6-Tool Cordless Combo Kit with 20V MAX Premium Lithium-Ion 5.0 Ah Battery-Pack", ["DCKTS681D1P1", "DCB205"]),
    ("DCK2100W354606", "20V Cordless Brushless Hammer Drill/Driver Combo Kit, 20V Oscillating Tool, and (1) FLEXVOLT 6.0Ah Battery", ["DCK2100", "DCS354B", "DCB606"]),
    ("DCK694P2W2052", "20V MAX Lithium-Ion Brushless Cordless 6-Tool Combo Kit with (4) 20V Premium 5.0Ah Batteries and Charger", ["DCK694P2", "DCB205-2"]),
    ("DCK283D2W380B", "20V MAX XR Cordless Brushless Drill/Impact 2 Tool Combo Kit, 20V MAX Reciprocating Saw, and (2) 20V 2.0Ah Batteries", ["DCK283D2", "DCS380B"]),
    ("DCK2050M2WCW600", "20V MAX XR Hammer Drill and ATOMIC Impact Driver Cordless Combo Kit (2-Tool) and Compact Router with (2) 4Ah Batteries", ["DCK2050M2", "DCW600B"]),
    ("DCK2050M2WCF513", "20V MAX XR Hammer Drill and ATOMIC Impact Driver Cordless Combo Kit (2-Tool) and 3/8 in. Ratchet w/(2) 4Ah Batteries", ["DCK2050M2", "DCF513B"]),
    ("DCK940D2W240-2", "20V MAX Cordless 9 Tool Combo Kit, (2) 20V 2.0Ah Batteries, (2) 20V MAX Compact Lithium-Ion 4.0Ah Batteries, Charger", ["DCK940D2", "DCB240-2"]),
    ("DCK661D1M1W331", "20V MAX Cordless 6 Tool Combo Kit, 20V MAX Cordless Jig Saw, and (1) 20V 4.0Ah and (1) 20V 2.0Ah Batteries", ["DCK661D1M1", "DCS331B"]),
    ("DCK2051D2WS356B", "20-Volt MAX Drill/Driver & ATOMIC Impact Driver Combo Kit (2-Tool) with (2) 2.0 Ah Batteries, Charger and Bag", ["DCK2051D2", "DCS356B"]),
    ("DCK350T2WCS565B", "20V MAX Lithium-Ion Cordless 3-Tool Combo Kit and 6-1/2 in. Circular Saw with (2) Flexvolt 6.0 Ah Batteries and Charger", ["DCK350T2", "DCS565B"]),
    ("DCK411Q2WBL722B", "20V Max Lithium-Ion Cordless 4-Tool Combo Kit and Brushless Cordless Handheld Blower with (2) 4 Ah Batteries and Charger", ["DCK411Q2", "DCBL722B"]),
]

# A real Home Depot bundle whose short code is too short to resolve safely.
HD_DEWALT_AMBIGUOUS = (
    "DCKTS650D1P1W1B",
    "20V Lithium-Ion Cordless 6-Tool Combo Kit and 1/2 in. Impact Wrench w/ 5 Ah & 2 Ah Batteries Charger & Rolling Toolbox",
)

# Kit contents as listed in deal posts for Lowe's (bare-tool model numbers).
KIT_CONTENTS = {
    "DCK500P2": [
        ("DCS356B", 1), ("DCW210B", 1), ("DCW200B", 1), ("DCS334B", 1), ("DCW600B", 1),
        ("DCB205", 2), ("DEWALT-CHARGER", 1), ("DEWALT-BAG", 1),
    ],
}

# The schema.org Product block from the same Home Depot page, as the browser returned it
# (fields not used by the parser are left out).
HD_JSONLD = {
    "@type": "Product",
    "name": "RYOBI ONE+ HP 18V Brushless Cordless 1/4 in. and 3/8 in. Extended Reach Ratchets (Tools Only) PBLRC2501SB",
    "sku": "1010927962",
    "gtin13": "0033287232581",
    "model": "PBLRC2501SB",
    "productID": "328814689",
    "brand": {"@type": "Brand", "name": "RYOBI"},
    "offers": {
        "@type": "Offer",
        "priceCurrency": "USD",
        "price": 189,
        "priceSpecification": {
            "@type": "UnitPriceSpecification",
            "priceType": "https://schema.org/StrikethroughPrice",
            "price": 338,
            "priceCurrency": "USD",
        },
    },
}
# Shape of the review data inside the page source (escaped JSON inside a script tag).
HD_REVIEW_SNIPPET = (
    r'{\"ProductId\":\"316631066\",\"SubmissionTime\":\"2023-09-30\"},'
    r'{\"ProductId\":\"316631068\",\"Title\":null},'
    r'{\"ProductId\":\"328814689\",\"Title\":null},'
    r'{\"ProductId\":\"316631066\",\"Title\":\"Surprisingly powerful, easy to use.\"}'
)
