import itertools
import random

import pytest

from bsf.decompose import decompose_dewalt, decompose_ryobi, expand_kits, reconcile
from bsf.identifiers import is_valid_gtin, to_upc12
from bsf.match import _has_model_token, grade, pick
from bsf.money import LOOSE, RETAIL_BOXED, UNKNOWN, amazon_net, bundle_profit, route
from bsf.optimize import Listing, all_plans, best_plan

from . import fixtures as fx

# ---------------------------------------------------------------- barcodes


def test_real_barcodes_validate_and_normalise():
    assert is_valid_gtin(fx.HD_BUNDLE["gtin13"])
    assert to_upc12(fx.HD_BUNDLE["gtin13"]) == fx.HD_BUNDLE["upc"]  # 13 digits -> 12
    assert to_upc12("33287193714") == "033287193714"  # leading zero dropped by a price site
    assert to_upc12("033287193714") == "033287193714"


def test_bad_barcodes_are_refused():
    assert to_upc12("033287193715") is None  # wrong check digit
    assert to_upc12("4892210138033") is None  # a true EAN-13, not a US UPC
    assert to_upc12("") is None


# ---------------------------------------------------------------- splitting bundles


def test_ryobi_both_model_number_forms_give_the_same_parts():
    new_form = decompose_ryobi(fx.HD_BUNDLE["model"], fx.RYOBI_CATALOG)
    old_form = decompose_ryobi(fx.HD_OLD_BUNDLE_MODEL, fx.RYOBI_CATALOG)
    assert new_form.status == old_form.status == "resolved"
    assert set(new_form.components) == set(old_form.components) == {"PBLRC01B", "PBLRC25B"}


def test_ryobi_unknown_parts_go_to_review_not_a_guess():
    d = decompose_ryobi("PBLXX9988SB", fx.RYOBI_CATALOG)
    assert d.status == "needs_review" and d.components == []


@pytest.mark.parametrize("model,title,expected", fx.HD_DEWALT_BUNDLES)
def test_dewalt_home_depot_bundles(model, title, expected):
    d = decompose_dewalt(model, title, fx.DEWALT_CATALOG)
    assert d.status == "resolved", d.notes
    assert d.components == expected


def test_dewalt_ambiguous_short_code_is_flagged():
    model, title = fx.HD_DEWALT_AMBIGUOUS
    d = decompose_dewalt(model, title, fx.DEWALT_CATALOG)
    assert d.status == "needs_review"
    assert "DCF891B" in d.notes[0] and "DCF921B" in d.notes[0]


def test_kit_is_expanded_to_its_contents():
    parts, unknown = expand_kits(["DCK500P2", "DCF891B"], fx.KIT_CONTENTS)
    assert parts["DCB205"] == 2 and parts["DCS356B"] == 1 and parts["DCF891B"] == 1
    assert unknown == []
    _, unknown = expand_kits(["DCK940D2"], fx.KIT_CONTENTS)
    assert unknown == ["DCK940D2"]  # contents not on file -> flagged


def test_two_signals_agree_on_the_real_page():
    from_model = decompose_ryobi(fx.HD_BUNDLE["model"], fx.RYOBI_CATALOG).components
    from_page = [
        fx.HD_ITEM_MODEL[i]
        for i in fx.HD_BUNDLE["review_product_ids"]
        if i != fx.HD_BUNDLE["productID"]
    ]
    assert reconcile(from_model, from_page)[0] == "high"
    assert reconcile(["PBLRC01B"], ["PBLRC25B"])[0] == "conflict"


# ---------------------------------------------------------------- matching ASINs


def test_token_match_does_not_fire_inside_longer_model_numbers():
    assert _has_model_token("RYOBI ratchet PBLRC25B tool only", "PBLRC25B")
    assert not _has_model_token("RYOBI PBLRC2501SB two ratchets", "PBLRC25B")
    assert not _has_model_token("RYOBI PBLRC25BK kit", "PBLRC25B")


def test_real_listings_are_accepted():
    g38 = grade("RYOBI", "PBLRC25B", None, fx.ASIN_3_8)
    g14 = grade("RYOBI", "PBLRC01B", "33287193714", fx.ASIN_1_4)
    assert (g38.grade, g14.grade) == ("strong", "exact")
    assert g38.packaging == g14.packaging == "retail"


@pytest.mark.parametrize(
    "cand,expected",
    [
        (fx.DECOY_RENEWED, "reject"),
        (fx.DECOY_OTHER_MODEL, "reject"),
        (fx.DECOY_KIT, "reject"),
        (fx.DECOY_2PACK, "reject"),
        (fx.DECOY_BRAND, "reject"),
        (fx.DECOY_TITLE_ONLY, "review"),
        (fx.ASIN_1_4, "reject"),  # the 1/4 in. listing must not match the 3/8 in. tool
    ],
)
def test_decoys(cand, expected):
    assert grade("RYOBI", "PBLRC25B", None, cand).grade == expected


def test_bulk_packaged_listing_is_labelled():
    g = grade("RYOBI", "PBLRC25B", None, fx.DECOY_BULK)
    assert g.grade == "strong" and g.packaging == "bulk"


def test_a_two_pack_component_matches_a_two_pack_listing():
    from bsf.match import Candidate

    two = Candidate("X", "DEWALT 20V MAX 5.0Ah Battery (2-Pack) DCB205-2", "DEWALT", "DCB205-2")
    assert grade("DEWALT", "DCB205-2", None, two, component_pack_qty=2).grade == "strong"
    assert grade("DEWALT", "DCB205", None, two).grade == "reject"


# ---------------------------------------------------------------- best combination


def test_optimizer_prefers_the_listing_mix_that_pays_most():
    parts = {"TOOL": 1, "BATT": 2, "CHARGER": 1}
    listings = [
        Listing("A-TOOL", (("TOOL", 1),), 90.0),
        Listing("A-BATT", (("BATT", 1),), 40.0),
        Listing("A-BATT2", (("BATT", 2),), 95.0),
        Listing("A-STARTER", (("BATT", 1), ("CHARGER", 1)), 70.0),
    ]
    liq = {"CHARGER": 12.0, "BATT": 25.0}
    plan = best_plan(parts, listings, liq)
    # tool 90 + starter kit 70 + single battery 40 = 200 beats 2-pack 95 + charger 12 + tool 90 = 197
    assert plan.total_net == 200.0
    assert plan.listings == ["A-BATT", "A-STARTER", "A-TOOL"] and plan.liquidated == []

    listings[2] = Listing("A-BATT2", (("BATT", 2),), 110.0)
    plan = best_plan(parts, listings, liq)
    assert plan.total_net == 212.0 and plan.liquidated == ["CHARGER"]


def test_unlisted_parts_are_liquidated_not_dropped():
    plan = best_plan({"TOOL": 1, "BAG": 1}, [Listing("A", (("TOOL", 1),), 50.0)], {"BAG": 8.0})
    assert plan.total_net == 58.0 and plan.liquidated == ["BAG"]


def _brute_force(parts, listings, liq):
    names = sorted(parts)
    best = -1.0
    ranges = []
    for lst in listings:
        cap = min(parts[m] // q for m, q in lst.covers)
        ranges.append(range(cap + 1))
    for counts in itertools.product(*ranges):
        left = dict(parts)
        ok, net = True, 0.0
        for lst, c in zip(listings, counts):
            for m, q in lst.covers:
                left[m] -= q * c
                if left[m] < 0:
                    ok = False
            net += lst.net * c
        if ok:
            net += sum(liq.get(n, 0.0) * left[n] for n in names)
            best = max(best, net)
    return round(best, 2)


def test_optimizer_matches_brute_force_on_500_random_bundles():
    rng = random.Random(7)
    for _ in range(500):
        names = [f"C{i}" for i in range(rng.randint(1, 5))]
        parts = {n: rng.randint(1, 3) for n in names}
        listings = []
        for k in range(rng.randint(0, 7)):
            cover = rng.sample(names, rng.randint(1, min(3, len(names))))
            listings.append(
                Listing(f"L{k}", tuple((m, rng.randint(1, 2)) for m in cover), round(rng.uniform(5, 200), 2))
            )
        liq = {n: round(rng.uniform(0, 40), 2) for n in names}
        expected = _brute_force(parts, listings, liq)
        assert best_plan(parts, listings, liq).total_net == pytest.approx(expected, abs=0.01)
        plans = all_plans(parts, listings, liq, limit=100000)
        assert plans[0].total_net == pytest.approx(expected, abs=0.01)


def test_all_plans_lists_every_distinct_combination():
    parts = {"BATT": 2}
    listings = [Listing("ONE", (("BATT", 1),), 40.0), Listing("TWO", (("BATT", 2),), 95.0)]
    plans = all_plans(parts, listings, {"BATT": 25.0})
    seen = {(tuple(p.listings), tuple(p.liquidated)) for p in plans}
    assert seen == {
        (("TWO",), ()),
        (("ONE", "ONE"), ()),
        (("ONE",), ("BATT",)),
        ((), ("BATT", "BATT")),
    }
    assert plans[0].listings == ["TWO"]


# ---------------------------------------------------------------- money and packaging


def test_fee_math():
    assert amazon_net(169.00, 0.15, 0.0) == 143.65
    assert amazon_net(1.00, 0.15, 0.0) == 0.70  # $0.30 minimum referral fee
    r = bundle_profit(189.00, 287.30)
    assert (r.cost, r.profit) == (189.00, 98.30) and r.roi == pytest.approx(0.5201, abs=1e-4)


def test_packaging_rule():
    assert route(RETAIL_BOXED, may_list_new=True).channel == "amazon"
    assert route(RETAIL_BOXED, may_list_new=False).channel == "ebay"
    assert route(LOOSE, may_list_new=True).condition == "new_other"
    assert route(UNKNOWN, may_list_new=True).channel == "ebay"  # unknown is never sent to Amazon as New


# ---------------------------------------------------------------- the founder's own example, end to end


def test_founder_example_end_to_end():
    b = fx.HD_BUNDLE
    assert to_upc12(b["gtin13"]) is not None

    parts = decompose_ryobi(b["model"], fx.RYOBI_CATALOG).components
    candidates = [
        fx.ASIN_3_8, fx.ASIN_1_4, fx.DECOY_RENEWED, fx.DECOY_OTHER_MODEL,
        fx.DECOY_KIT, fx.DECOY_2PACK, fx.DECOY_BRAND,
    ]
    upcs = {"PBLRC01B": "033287193714", "PBLRC25B": None}

    listings = []
    for model in parts:
        auto, review = pick([grade("RYOBI", model, upcs[model], c) for c in candidates])
        assert len(auto) == 1 and review == []
        # Illustrative price: half of Home Depot's $338 regular price for the pair.
        net = amazon_net(b["strikethrough_price"] / 2, 0.15, 0.0)
        listings.append(Listing(auto[0].asin, ((model, 1),), net))

    plan = best_plan({m: 1 for m in parts}, listings)
    # The two ASINs the founder gave by hand.
    assert plan.listings == ["B0B3JWF5ZV", "B0B6Z2ZGVK"]
    result = bundle_profit(b["price"], plan.total_net)
    assert result.profit == 98.30


# ---------------------------------------------------------------- Home Depot page parsing


def test_home_depot_product_block_is_parsed():
    from bsf.hd_page import component_item_ids, parse_product_jsonld

    p = parse_product_jsonld(fx.HD_JSONLD)
    assert p["model"] == "PBLRC2501SB" and p["brand"] == "RYOBI"
    assert p["upc"] == "033287232581"
    assert (p["price"], p["regular_price"]) == (189.0, 338.0)
    assert component_item_ids(fx.HD_REVIEW_SNIPPET, p["item_id"]) == ["316631066", "316631068"]
