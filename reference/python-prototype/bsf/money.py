"""Profit math and the packaging rule.

Fee numbers are inputs, never constants: production reads them per ASIN from
Amazon's Product Fees API, because they depend on category, size and date.
"""

from __future__ import annotations

from dataclasses import dataclass


def amazon_net(price: float, referral_rate: float, fulfillment_fee: float, min_referral: float = 0.30) -> float:
    referral = max(price * referral_rate, min_referral)
    return round(price - referral - fulfillment_fee, 2)


@dataclass
class BundleResult:
    cost: float
    net_revenue: float
    profit: float
    roi: float


def bundle_profit(bundle_price: float, net_revenue: float, sales_tax_rate: float = 0.0, inbound_cost: float = 0.0) -> BundleResult:
    cost = round(bundle_price * (1 + sales_tax_rate) + inbound_cost, 2)
    profit = round(net_revenue - cost, 2)
    return BundleResult(cost, round(net_revenue, 2), profit, round(profit / cost, 4) if cost else 0.0)


# ---------------------------------------------------------------- packaging rule

RETAIL_BOXED = "retail_boxed"  # arrives in its own sealed retail box with its own barcode
LOOSE = "loose"  # pulled out of a combo-kit box, no box of its own
UNKNOWN = "unknown"  # not confirmed yet


@dataclass
class Route:
    channel: str
    condition: str
    note: str


def route(packaging: str, may_list_new: bool, bulk_asin_exists: bool = False) -> Route:
    """Where a component may be sold, and in what condition.

    Amazon's "New" means factory packaging, so only RETAIL_BOXED items go to a
    normal Amazon listing as New. Everything else is routed elsewhere, and
    UNKNOWN is treated like LOOSE until the founder confirms the packaging once.
    """
    if packaging == RETAIL_BOXED:
        if may_list_new:
            return Route("amazon", "new", "own retail box; list on the retail ASIN")
        return Route("ebay", "new", "boxed, but this account cannot list the ASIN as New")
    if packaging == LOOSE and bulk_asin_exists:
        return Route(
            "ebay",
            "new_other",
            "a 'bulk packaged' Amazon listing exists; founder decides whether to use it",
        )
    if packaging == LOOSE:
        return Route("ebay", "new_other", "no retail box; eBay 'New (other)' fits unused items without packaging")
    return Route("ebay", "new_other", "packaging not confirmed; treated as loose until checked once")
