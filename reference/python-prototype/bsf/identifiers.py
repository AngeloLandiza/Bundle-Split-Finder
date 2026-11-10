"""Barcode handling. Retailers and Amazon print the same barcode in different
lengths (11, 12, 13 or 14 digits), so every code is normalised before it is
used as a join key."""

from __future__ import annotations


def gtin_check_digit(body: str) -> int:
    """Check digit for a GTIN body (the code without its last digit)."""
    total = 0
    for i, ch in enumerate(reversed(body)):
        total += int(ch) * (3 if i % 2 == 0 else 1)
    return (10 - total % 10) % 10


def is_valid_gtin(code: str) -> bool:
    code = code.strip()
    if not code.isdigit() or len(code) not in (8, 12, 13, 14):
        return False
    return gtin_check_digit(code[:-1]) == int(code[-1])


def to_upc12(code: str) -> str | None:
    """Normalise any printed form of a US barcode to a 12-digit UPC-A.

    Returns None when the code cannot be a valid UPC-A, so a bad scrape is
    never used as a join key.
    """
    digits = "".join(ch for ch in code if ch.isdigit())
    if not digits:
        return None
    if len(digits) < 12:
        # Some sites drop leading zeros (033287193714 shown as 33287193714).
        digits = digits.zfill(12)
    if len(digits) > 12:
        extra = len(digits) - 12
        if set(digits[:extra]) != {"0"}:
            return None  # a real EAN-13, not a zero-padded UPC
        digits = digits[extra:]
    return digits if is_valid_gtin(digits) else None
