// Step 16: who a brief's check is for (owner, Nov 23: "if I'm told to do this… why can't an AI pipeline do it for me").
// The card's "Check" line is only for what needs a person. Decided by code from the check's own words, never by a model:
// a check that is a page read, an Includes-list read, a model-number lookup or a listing lookup is the app's (its tools
// read Home Depot pages and searches in the owner's Chrome, and the catalog and Amazon's catalog records); anything else
// is the owner's. An eBay question's check is the owner's: the app has no tool that reads an eBay listing for him.
//
// A check the app owns is never shown as an instruction (view.ts cardCheck): the card says what the app is doing or did,
// and the question's follow-up loop (research/followUp.ts, agent/followUp.ts) does the reading, its tasks derived from the
// verifier's structured refusals and the ask's record, never from this sentence.

/** Words that make a check a read or a lookup the app's tools do. */
const APP_WORDS = [
  /\bincludes?\b/i, /\bin the box\b/i, /\bhome depot\b/i, /\bpages?\b/i, /\bmodel(?:s| numbers?)?\b/i, /\bpart numbers?\b/i,
  /\blistings?\b/i, /\bamazon\b/i, /\bcatalog\b/i, /\basin\b/i, /\blook(?:s|ing)? ?up\b/i, /\bsearch(?:es|ing)?\b/i, /\btitles?\b/i,
];
/** A model number in the sentence ("A21701", "PCL406424SB"): looking it up is the app's. */
const MODEL_TOKEN = /\b[A-Z]{1,5}\d[A-Z0-9-]*\b/;

export function checkWho(text: string, kind: 'split' | 'match' | 'ebay'): 'app' | 'owner' {
  if (kind === 'ebay') return 'owner';
  return APP_WORDS.some((re) => re.test(text)) || MODEL_TOKEN.test(text) ? 'app' : 'owner';
}
