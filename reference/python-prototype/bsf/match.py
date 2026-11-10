"""Grade Amazon catalog candidates for one component.

Amazon's own docs say a barcode can map to several ASINs, so a lookup returns
candidates, not an answer. Each candidate is graded:

  exact   barcode matches, single unit, same brand          -> use automatically
  strong  manufacturer part number matches exactly           -> use automatically
  review  looks related but something is off                 -> human checks once
  reject  renewed, wrong brand, multipack, or a kit variant  -> never used
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .identifiers import to_upc12

_RENEWED = re.compile(r"\b(renewed|refurbished|reconditioned|used|pre-owned|open box)\b", re.I)
_BULK = re.compile(r"(bulk packaged|non-retail packag|no retail packag)", re.I)
_MULTI = re.compile(r"\b(\d+)\s*-?\s*pack\b|\bpack of (\d+)\b|\bset of (\d+)\b", re.I)
_KIT_WORDS = re.compile(r"\b(kit|combo|bundle|with battery|with charger|w/ battery|and charger)\b", re.I)


@dataclass(frozen=True)
class Candidate:
    asin: str
    title: str
    brand: str
    part_number: str | None = None
    upcs: tuple[str, ...] = ()
    package_qty: int | None = None


@dataclass
class Graded:
    asin: str
    grade: str
    packaging: str  # "retail" or "bulk" (the listing itself says non-retail packaging)
    reasons: list[str] = field(default_factory=list)


def _clean(model: str) -> str:
    return re.sub(r"[^A-Z0-9-]", "", model.upper())


def _has_model_token(text: str, model: str) -> bool:
    # Token match: PBLRC25B must not match inside PBLRC2501SB or PBLRC25.
    return re.search(rf"(?<![A-Z0-9]){re.escape(model.upper())}(?![A-Z0-9])", text.upper()) is not None


def grade(
    brand: str,
    model: str,
    upc: str | None,
    cand: Candidate,
    component_is_kit: bool = False,
    component_pack_qty: int = 1,
) -> Graded:
    packaging = "bulk" if _BULK.search(cand.title) else "retail"
    reasons: list[str] = []

    if cand.brand.strip().upper() != brand.strip().upper():
        return Graded(cand.asin, "reject", packaging, ["different brand"])
    if _RENEWED.search(cand.title):
        return Graded(cand.asin, "reject", packaging, ["renewed or used listing"])

    qty = cand.package_qty
    multi = _MULTI.search(cand.title)
    if multi:
        qty = int(next(g for g in multi.groups() if g))
    if qty and qty != component_pack_qty:
        return Graded(cand.asin, "reject", packaging, [f"pack of {qty}, component is a pack of {component_pack_qty}"])

    part_ok = cand.part_number is not None and _clean(cand.part_number) == _clean(model)
    title_ok = _has_model_token(cand.title, model)
    want = to_upc12(upc) if upc else None
    upc_ok = want is not None and want in {to_upc12(u) for u in cand.upcs}

    if not component_is_kit and _KIT_WORDS.search(cand.title) and not part_ok:
        return Graded(cand.asin, "reject", packaging, ["listing is a kit, component is a single item"])

    if upc_ok:
        reasons.append("barcode match")
        if part_ok or title_ok:
            reasons.append("model number match")
        return Graded(cand.asin, "exact", packaging, reasons)
    if part_ok:
        return Graded(cand.asin, "strong", packaging, ["manufacturer part number match"])
    if title_ok:
        return Graded(cand.asin, "review", packaging, ["model number only appears in the title"])
    return Graded(cand.asin, "reject", packaging, ["no identifier matches"])


def pick(graded: list[Graded]) -> tuple[list[Graded], list[Graded]]:
    """Return (auto-accepted, needs human review)."""
    auto = [g for g in graded if g.grade in ("exact", "strong")]
    review = [g for g in graded if g.grade == "review"]
    return auto, review
