// What Amazon's reason codes mean, in the owner's words. Paraphrased from the API models named in
// docs/sp-api-notes-2026-11-25.md; a code they do not list is shown as its code ("unknown: FBA_INB_0123"), never guessed.

/** FBA Inbound Eligibility reason codes (fbaInbound.json), each as one plain sentence. */
export const FBA_REASON_WORDS: Readonly<Record<string, string>> = {
  FBA_INB_0004: 'Amazon is missing its package dimensions',
  FBA_INB_0007: 'Needs more information for Amazon\'s dangerous goods review',
  FBA_INB_0008: 'Needs battery details',
  FBA_INB_0009: 'Needs a Safety Data Sheet',
  FBA_INB_0010: 'Needs more information for Amazon\'s dangerous goods review',
  FBA_INB_0011: 'Needs more information for Amazon\'s dangerous goods review',
  FBA_INB_0012: 'Needs more information for Amazon\'s dangerous goods review',
  FBA_INB_0013: 'Needs more information for Amazon\'s dangerous goods review',
  FBA_INB_0014: 'Amazon is reviewing it as dangerous goods: 4 to 7 business days',
  FBA_INB_0015: 'Cannot be sent to FBA: dangerous goods Amazon will not store (inventory would be disposed of)',
  FBA_INB_0016: 'Dangerous goods FBA can store: you may need to enrol in FBA Dangerous Goods',
  FBA_INB_0051: 'Cannot be sent to FBA: blocked',
  FBA_INB_0053: 'Cannot be sent to FBA: its size, weight or shipping option is not eligible',
  FBA_INB_0097: 'Cannot be sent to FBA: a fully regulated dangerous good',
  FBA_INB_0098: 'Your account is not set up for FBA in this marketplace',
  FBA_INB_0099: 'Your FBA account is not active',
  FBA_INB_0104: 'Barcode problem: Amazon needs a different product barcode',
  FBA_INB_0197: 'Needs safety and compliance documents',
  FBA_INB_0342: 'Barcode problem: the barcode is used by another product',
  FBA_INB_0465: 'Only the brand\'s representative can send it to FBA',
  UNKNOWN_INB_ERROR_CODE: 'Amazon gave no reason it can name',
};

/** Listings Restrictions reason codes the notes list. */
export const LISTING_REASON_CODES: readonly string[] = ['APPROVAL_REQUIRED', 'ASIN_NOT_FOUND', 'NOT_ELIGIBLE'];

/** One FBA reason in words; an unknown code as itself. */
export function fbaReasonWords(code: string): string {
  return FBA_REASON_WORDS[code] ?? `unknown: ${code}`;
}

/** The FBA codes that mean "not yet" (more information or a review) rather than "no". Unknown codes are not among them. */
export const FBA_PENDING_CODES: readonly string[] = ['FBA_INB_0004', 'FBA_INB_0007', 'FBA_INB_0008', 'FBA_INB_0009', 'FBA_INB_0010', 'FBA_INB_0011', 'FBA_INB_0012', 'FBA_INB_0013', 'FBA_INB_0014', 'FBA_INB_0016', 'FBA_INB_0197'];
