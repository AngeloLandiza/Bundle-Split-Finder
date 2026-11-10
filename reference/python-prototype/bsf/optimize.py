"""Find the best way to sell a bundle's parts.

A bundle is a bag of components. A listing sells one or more of them (a single
tool, a 2-pack of batteries, a battery + charger starter kit). The question the
founder asked, "all the possible combinations of listings", is: every way to
cover the bag with listings, and which way pays the most.

Parts no listing covers are sold at a liquidation value (eBay / local).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache


@dataclass(frozen=True)
class Listing:
    listing_id: str  # ASIN, or an eBay comp id
    covers: tuple[tuple[str, int], ...]  # (component model, quantity)
    net: float  # what is left after marketplace fees
    channel: str = "amazon"


@dataclass
class Plan:
    total_net: float
    listings: list[str] = field(default_factory=list)
    liquidated: list[str] = field(default_factory=list)


def best_plan(
    components: dict[str, int],
    listings: list[Listing],
    liquidation: dict[str, float] | None = None,
) -> Plan:
    liquidation = liquidation or {}
    names = sorted(components)
    index = {n: i for i, n in enumerate(names)}
    start = tuple(components[n] for n in names)

    usable = []
    for lst in listings:
        if all(model in index for model, _ in lst.covers):
            need = [0] * len(names)
            for model, qty in lst.covers:
                need[index[model]] += qty
            usable.append((lst, tuple(need)))

    @lru_cache(maxsize=None)
    def solve(state: tuple[int, ...]) -> tuple[float, tuple[str, ...]]:
        i = next((k for k, v in enumerate(state) if v), None)
        if i is None:
            return 0.0, ()
        # Option A: sell one unit of component i on its own, outside a listing.
        rest = state[:i] + (state[i] - 1,) + state[i + 1 :]
        value, path = solve(rest)
        best = (value + liquidation.get(names[i], 0.0), path + (f"liquidate:{names[i]}",))
        # Option B: any listing that uses component i and fits what is left.
        for lst, need in usable:
            if need[i] and all(s >= n for s, n in zip(state, need)):
                nxt = tuple(s - n for s, n in zip(state, need))
                value, path = solve(nxt)
                if value + lst.net > best[0] + 1e-9:
                    best = (value + lst.net, path + (lst.listing_id,))
        return best

    total, path = solve(start)
    return Plan(
        total_net=round(total, 2),
        listings=sorted(p for p in path if not p.startswith("liquidate:")),
        liquidated=sorted(p.split(":", 1)[1] for p in path if p.startswith("liquidate:")),
    )


def all_plans(
    components: dict[str, int],
    listings: list[Listing],
    liquidation: dict[str, float] | None = None,
    limit: int = 500,
) -> list[Plan]:
    """Every distinct way to cover the bundle, best first (capped at `limit`)."""
    liquidation = liquidation or {}
    names = sorted(components)
    index = {n: i for i, n in enumerate(names)}
    usable = []
    for pos, lst in enumerate(listings):
        if all(model in index for model, _ in lst.covers):
            need = [0] * len(names)
            for model, qty in lst.covers:
                need[index[model]] += qty
            usable.append((pos, lst, tuple(need)))

    found: dict[tuple, Plan] = {}

    def walk(state: tuple[int, ...], min_pos: int, used: list[Listing]) -> None:
        if len(found) >= limit:
            return
        # Close this plan: whatever is left is liquidated.
        left = [n for n, c in zip(names, state) for _ in range(c)]
        net = sum(x.net for x in used) + sum(liquidation.get(n, 0.0) for n in left)
        key = (tuple(sorted(x.listing_id for x in used)), tuple(left))
        found.setdefault(key, Plan(round(net, 2), list(key[0]), left))
        # Or add one more listing (non-decreasing order avoids duplicates).
        for pos, lst, need in usable:
            if pos >= min_pos and all(s >= n for s, n in zip(state, need)):
                walk(tuple(s - n for s, n in zip(state, need)), pos, used + [lst])

    walk(tuple(components[n] for n in names), 0, [])
    return sorted(found.values(), key=lambda p: -p.total_net)
