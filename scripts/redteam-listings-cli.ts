// npm run redteam:listings -- <data folder or desktop audit export> [--model <id>] [--max-cost <usd>] [--spend]
//
// A second opinion on the app's confirmed listings, for a person to read. Per confirmed listing (a part whose counted
// listing a catalog rung confirmed), it asks a model "is this the part?" from what the app recorded: the part's brand and
// model and the listing's stored title and brand. The model's answer goes through the listing judge's own code check
// (core/src/listingJudge judgeListingWith). It lists the disagreements (the model says different, or cannot tell) with
// their links. It never decides: nothing is written to the app's data, and a disagreement changes no match.
//
// Costs money: without --spend it reads no key and calls nothing, and prints how many listings and the estimated cost.
// With --spend it prints the estimate first, then reads ANTHROPIC_API_KEY (never printed; never from .env), one call per
// listing, one after another, no retries, and stops before the next call once --max-cost is reached. The main session
// decides whether to run it (CLAUDE.md, docs/audit.md "Checking the app's own work").

import { ClaudeProvider } from '../core/src/ai/claude';
import type { ModelProvider } from '../core/src/ai/types';
import { isKitModel } from '../core/src/audit/sanity';
import { costOf, PRICE_TABLE } from '../core/src/judge/eval';
import type { TokenUsage } from '../core/src/judge/types';
import type { ListingIdentity } from '../core/src/keepa/verify';
import { judgeListingWith, LISTING_JUDGE_PROMPT, partKind, renderListingJudgeInput, type ListingJudgePart } from '../core/src/listingJudge';
import type { Wanted } from '../core/src/match';
import type { BundleRow } from '../core/src/scan/types';
import { loadSanityData } from './sanity-cli';

export const REDTEAM_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'] as const;
export const REDTEAM_DEFAULT_MODEL = 'claude-haiku-5-5';
export const ASSUMED_OUTPUT_TOKENS = 350;
const CHARS_PER_TOKEN = 4;
const CONFIRMED = new Set(['keepa_catalog', 'serpapi_product', 'listing_fields']);

export interface RedteamRow {
  bundleId: string;
  link: string | null;
  want: Wanted;
  part: ListingJudgePart;
  listing: ListingIdentity;
}

/** Each confirmed (part, listing) of the deals once, in deal order, with the fields the app stored for the listing. */
export function confirmedListings(bundles: readonly BundleRow[]): RedteamRow[] {
  const out = new Map<string, RedteamRow>();
  for (const b of bundles) for (const o of b.options) for (const p of o.parts) {
    if (p.status !== 'matched' || !p.asin || !CONFIRMED.has(p.verifiedBy ?? '')) continue;
    const key = `${b.brand}:${p.model}|${p.asin}`.toUpperCase();
    if (out.has(key)) continue;
    const want: Wanted = { brand: b.brand, model: p.model, ...(isKitModel(b.brand, p.model) ? { isKit: true } : {}) };
    out.set(key, {
      bundleId: b.key, link: b.link, want,
      part: { brand: b.brand, model: p.model, kind: partKind(want), packQty: /-([0-9]{1,2})$/.test(p.model) ? Number(/-([0-9]{1,2})$/.exec(p.model)![1]) : 1 },
      listing: {
        asin: p.asin, title: p.title, brand: b.brand, manufacturer: null, partNumber: null, model: null, numberOfItems: null, packageQuantity: null,
        source: 'keepa_catalog',
      },
    });
  }
  return [...out.values()];
}

/** The calls' estimated tokens and dollars before any is made: prompt characters / 4 in, 350 tokens out a listing. */
export function estimate(rows: readonly RedteamRow[], model: string): { inputTokens: number; outputTokens: number; usd: number } {
  const chars = rows.reduce((n, r) => n + LISTING_JUDGE_PROMPT.length + renderListingJudgeInput(r.part, r.listing).length, 0);
  const inputTokens = Math.ceil(chars / CHARS_PER_TOKEN);
  const outputTokens = rows.length * ASSUMED_OUTPUT_TOKENS;
  return { inputTokens, outputTokens, usd: costOf({ inputTokens, outputTokens }, PRICE_TABLE[model]!) };
}

export interface RedteamDeps {
  log: (line: string) => void;
  env: (name: string) => string | undefined;
  /** Builds the provider; tests pass a fake. */
  makeProvider?: (model: string, apiKey: string) => ModelProvider;
}

const usd = (n: number): string => `$${n.toFixed(n < 1 ? 4 : 2)}`;
const USAGE = `Usage: npm run redteam:listings -- <data folder or audit export .json> [--model <${REDTEAM_MODELS.join('|')}>] [--max-cost <usd>] [--spend]`;

/** Exit codes: 0 done (or not run without --spend), 1 a call problem stopped it, 2 bad arguments or input. */
export async function runRedteam(args: readonly string[], deps: RedteamDeps): Promise<number> {
  const { log } = deps;
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const model = flag('--model') ?? REDTEAM_DEFAULT_MODEL;
  const maxCostArg = flag('--max-cost');
  const maxCost = maxCostArg === undefined ? undefined : Number(maxCostArg);
  const spend = args.includes('--spend');
  const path = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--model' && args[i - 1] !== '--max-cost');
  if (!path || !(REDTEAM_MODELS as readonly string[]).includes(model) || (maxCost !== undefined && !(maxCost > 0))) {
    log(USAGE);
    return 2;
  }
  let bundles: BundleRow[];
  try {
    bundles = loadSanityData(path).bundles;
  } catch (err) {
    log(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const rows = confirmedListings(bundles);
  const est = estimate(rows, model);
  const rates = PRICE_TABLE[model]!;
  log(`Red team of confirmed listings: ${rows.length} confirmed listings in ${path}, one ${model} call each.`);
  log(`Estimated cost: ${usd(est.usd)} (${est.inputTokens} input tokens, characters / ${CHARS_PER_TOKEN}; ${est.outputTokens} output, ${ASSUMED_OUTPUT_TOKENS} a listing; $${rates.input} in / $${rates.output} out per million).`);
  if (!spend) {
    log('Not run: nothing was called and no key was read. Add --spend to ask the model (the main session decides).');
    return 0;
  }
  if (rows.length === 0) {
    log('No confirmed listing to ask about.');
    return 0;
  }
  const apiKey = deps.env('ANTHROPIC_API_KEY');
  if (!apiKey) {
    log('ANTHROPIC_API_KEY must be set. Nothing was called.');
    return 1;
  }
  const provider = deps.makeProvider ? deps.makeProvider(model, apiKey) : new ClaudeProvider({ apiKey, model });
  let spent = 0;
  let asked = 0;
  const disagree: string[] = [];
  const unsure: string[] = [];
  const failed: string[] = [];
  for (const r of rows) {
    if (maxCost !== undefined && spent >= maxCost) {
      log(`Stopped at --max-cost ${usd(maxCost)}: ${asked} of ${rows.length} asked.`);
      break;
    }
    const call = await judgeListingWith(provider, r.part, r.want, r.listing);
    asked += 1;
    if (call.usage) spent += costOf(call.usage as TokenUsage, rates);
    const where = `${r.want.model} on ${r.listing.asin} (${r.bundleId}): "${r.listing.title ?? ''}" · https://www.amazon.com/dp/${r.listing.asin}${r.link ? ` · ${r.link}` : ''}`;
    if (!call.ok) {
      failed.push(`${where} (${call.problem})`);
      if (/key|auth/i.test(call.problem) && asked === 1) {
        log('The first call failed on the key. Stopped.');
        return 1;
      }
      continue;
    }
    if (call.raw.verdict === 'different') disagree.push(`${where}: ${call.raw.reason}`);
    else if (call.raw.verdict === 'cannot_tell') unsure.push(`${where}: ${call.raw.reason}`);
  }
  log(`Asked ${asked}. Cost: ${usd(spent)}.`);
  log(`The model says not the part: ${disagree.length}. Cannot tell: ${unsure.length}. Not answered: ${failed.length}.`);
  for (const d of disagree) log(`  not the part? ${d}`);
  for (const u of unsure) log(`  cannot tell: ${u}`);
  for (const f of failed) log(`  not answered: ${f}`);
  log('For a person to look at: nothing in the app was changed.');
  return 0;
}
