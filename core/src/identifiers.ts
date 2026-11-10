// Barcode handling. Retailers and Amazon print the same barcode in different
// lengths (11, 12, 13 or 14 digits), so every code is normalised before it is
// used as a join key.

export function gtinCheckDigit(body: string): number {
  let total = 0;
  const digits = body.split('').reverse();
  digits.forEach((ch, i) => {
    total += Number(ch) * (i % 2 === 0 ? 3 : 1);
  });
  return (10 - (total % 10)) % 10;
}

export function isValidGtin(code: string): boolean {
  const c = code.trim();
  if (!/^\d+$/.test(c) || ![8, 12, 13, 14].includes(c.length)) return false;
  return gtinCheckDigit(c.slice(0, -1)) === Number(c.slice(-1));
}

/**
 * Normalise any printed form of a US barcode to a 12-digit UPC-A.
 * Returns null when the code cannot be a valid UPC-A, so a bad value is never
 * used as a join key.
 */
export function toUpc12(code: string | null | undefined): string | null {
  if (!code) return null;
  let digits = code.replace(/\D/g, '');
  if (!digits) return null;
  // Some sites drop leading zeros (033287193714 shown as 33287193714).
  if (digits.length < 12) digits = digits.padStart(12, '0');
  if (digits.length > 12) {
    const extra = digits.length - 12;
    if (!/^0+$/.test(digits.slice(0, extra))) return null; // a real EAN-13, not a zero-padded UPC
    digits = digits.slice(extra);
  }
  return isValidGtin(digits) ? digits : null;
}
