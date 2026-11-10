"""Split a retailer bundle into the model numbers of the things inside it.

Three independent signals are used and then reconciled:
  1. the bundle's own model number (retailers encode the parts in it),
  2. component item ids found on the bundle page (Home Depot shows reviews
     that were written for the component products),
  3. the kit-contents table for manufacturer combo kits.

Anything that cannot be resolved to exactly one answer is returned as
"needs_review". The code never guesses.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass(frozen=True)
class CatalogModel:
    model: str
    brand: str
    kinds: tuple[str, ...] = ()  # words a retailer title uses for this product
    is_kit: bool = False


@dataclass
class Decomposition:
    components: list[str] = field(default_factory=list)
    status: str = "resolved"  # or "needs_review"
    notes: list[str] = field(default_factory=list)


def _norm(model: str) -> str:
    return model.upper().replace("-", "").replace(" ", "")


# ---------------------------------------------------------------- RYOBI

_RYOBI_MODEL = re.compile(r"^[A-Z]{1,6}\d{2,5}[A-Z0-9]*$")
_RYOBI_SB = re.compile(r"^([A-Z]{2,6})(\d{2})(\d{2})SB$")


def decompose_ryobi(bundle_model: str, catalog: dict[str, CatalogModel]) -> Decomposition:
    model = bundle_model.upper().strip()

    # Form 1: "PBLRC01B-PBLRC25B" -> the parts are spelled out.
    if "-" in model:
        parts = model.split("-")
        if all(_RYOBI_MODEL.match(p) for p in parts) and all(p in catalog for p in parts):
            return Decomposition(parts, "resolved", ["hyphen-joined model numbers"])
        return Decomposition(parts, "needs_review", ["hyphen split, but a part is not in the catalog"])

    # Form 2: "PBLRC2501SB" -> shared prefix + two 2-digit numbers + SB.
    m = _RYOBI_SB.match(model)
    if m:
        prefix, a, b = m.groups()
        parts = [f"{prefix}{a}B", f"{prefix}{b}B"]
        if all(p in catalog for p in parts):
            return Decomposition(parts, "resolved", ["special-buy model number expanded"])
        return Decomposition([], "needs_review", ["special-buy pattern, parts not in catalog"])

    if model in catalog and catalog[model].is_kit:
        return Decomposition([model], "resolved", ["manufacturer kit, expand with kit contents"])
    return Decomposition([], "needs_review", ["no known RYOBI bundle pattern"])


# ---------------------------------------------------------------- DEWALT

# Home Depot writes DEWALT bundles as <kit model>W<short code for the bonus item>,
# e.g. DCK940D2WCF891B = kit DCK940D2 "with" DCF891B.
_DEWALT_BUNDLE = re.compile(r"^(DCK[A-Z]{0,2}\d{3,4}(?:[A-Z]\d){0,2})W(.+)$")


def _suffix_candidates(suffix: str, title: str, catalog: dict[str, CatalogModel]) -> list[str]:
    hits = [
        m.model
        for m in catalog.values()
        if m.brand == "DEWALT"
        and not m.is_kit
        and (_norm(m.model).endswith(suffix) or _norm(m.model).endswith(suffix + "B"))
    ]
    if len(hits) <= 1:
        return hits
    low = title.lower()
    by_title = [h for h in hits if any(k in low for k in catalog[h].kinds)]
    return by_title or hits


def _resolve_suffix(suffix: str, title: str, catalog: dict[str, CatalogModel]) -> tuple[list[str], str]:
    """Return (models, problem). problem is "" when the answer is unique."""
    whole = _suffix_candidates(suffix, title, catalog)
    if len(whole) == 1:
        return whole, ""
    if len(whole) > 1:
        return [], f"'{suffix}' fits {sorted(whole)}"

    # Two bonus items can be glued together: "354606" = DCS354B + DCB606.
    splits = []
    for cut in range(2, len(suffix) - 1):
        left = _suffix_candidates(suffix[:cut], title, catalog)
        right = _suffix_candidates(suffix[cut:], title, catalog)
        if len(left) == 1 and len(right) == 1:
            splits.append(left + right)
    if len(splits) == 1:
        return splits[0], ""
    if len(splits) > 1:
        return [], f"'{suffix}' can be split more than one way"
    return [], f"'{suffix}' matches nothing in the catalog"


def decompose_dewalt(bundle_model: str, title: str, catalog: dict[str, CatalogModel]) -> Decomposition:
    model = _norm(bundle_model)
    m = _DEWALT_BUNDLE.match(model)
    if not m:
        if bundle_model.upper() in catalog and catalog[bundle_model.upper()].is_kit:
            return Decomposition([bundle_model.upper()], "resolved", ["manufacturer kit"])
        return Decomposition([], "needs_review", ["no known DEWALT bundle pattern"])

    base, suffix = m.groups()
    bonus, problem = _resolve_suffix(suffix, title, catalog)
    if problem:
        return Decomposition([base], "needs_review", [problem])
    notes = ["kit + bonus item"]
    if base not in catalog:
        notes.append(f"kit {base} is new: contents not on file yet")
    return Decomposition([base] + bonus, "resolved", notes)


# ---------------------------------------------------------------- kits and reconciliation


def expand_kits(
    components: list[str],
    kit_contents: dict[str, list[tuple[str, int]]],
) -> tuple[dict[str, int], list[str]]:
    """Replace each manufacturer kit with what is inside its box.

    Returns (model -> quantity, kits whose contents are not on file).
    """
    out: dict[str, int] = {}
    unknown: list[str] = []
    for model in components:
        if model in kit_contents:
            for part, qty in kit_contents[model]:
                out[part] = out.get(part, 0) + qty
        else:
            if model.upper().startswith("DCK") or model.upper().endswith(("K", "K1", "K2")):
                unknown.append(model)
            out[model] = out.get(model, 0) + 1
    return out, unknown


def reconcile(model_number_parts: list[str], page_component_models: list[str]) -> tuple[str, str]:
    """Compare what the model number says with what the page says.

    Returns (confidence, reason). Two independent signals agreeing is "high".
    """
    a, b = set(model_number_parts), set(page_component_models)
    if a and b and a == b:
        return "high", "model number and page component ids agree"
    if a and b and a != b:
        return "conflict", f"model number says {sorted(a)}, page says {sorted(b)}"
    if a or b:
        return "medium", "only one signal available"
    return "none", "no signal"
