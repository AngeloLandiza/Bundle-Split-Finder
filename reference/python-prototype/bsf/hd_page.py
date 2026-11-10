"""Read the fields we need from a Home Depot product page.

Checked against the live page for item 328814689 on 2026-11-09: the page carries
a schema.org Product block (JSON-LD) with price, model, store SKU and barcode,
and its review data names the item ids of the component products.

This module only parses text it is given. Fetching the page is the data
provider's job (see the spec, "Integrations").
"""

from __future__ import annotations

import re

from .identifiers import to_upc12

_REVIEW_PRODUCT_ID = re.compile(r'\\?"ProductId\\?":\\?"(\d{6,12})\\?"')


def parse_product_jsonld(product: dict) -> dict:
    offers = product.get("offers") or {}
    spec = offers.get("priceSpecification") or {}
    brand = product.get("brand")
    return {
        "retailer": "homedepot",
        "item_id": product.get("productID"),
        "store_sku": product.get("sku"),
        "model": product.get("model"),
        "brand": brand.get("name") if isinstance(brand, dict) else brand,
        "upc": to_upc12(product.get("gtin13") or product.get("gtin12") or ""),
        "price": float(offers["price"]) if "price" in offers else None,
        "regular_price": float(spec["price"]) if "price" in spec else None,
        "title": product.get("name"),
    }


def component_item_ids(page_html: str, own_item_id: str) -> list[str]:
    """Item ids of other products whose reviews are shown on this page."""
    ids = {m for m in _REVIEW_PRODUCT_ID.findall(page_html)}
    ids.discard(own_item_id)
    return sorted(ids)
