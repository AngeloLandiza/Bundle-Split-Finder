// Words for the Market block of the inspector (screens/DealMarket.tsx), from the agent's market (core/src/tracking/market.ts).

import type { OptionMarket } from '../api/types';

/** The fold's aside: what needs a look first, else how many listings it covers. */
export function marketAside(m: OptionMarket): string {
  const unusual = m.parts.filter((p) => p.unusual).length;
  const hazards = m.parts.filter((p) => p.hazmat).length;
  const bits: string[] = [];
  if (unusual > 0) bits.push(`${unusual} unusual ${unusual === 1 ? 'price' : 'prices'}`);
  if (hazards > 0) bits.push(`${hazards} hazard ${hazards === 1 ? 'note' : 'notes'}`);
  return bits.length > 0 ? bits.join(', ') : `${m.parts.length} ${m.parts.length === 1 ? 'listing' : 'listings'}`;
}

/** The deal's own lines: the hazard parts, named once for the deal (each part's own note says the rest). */
export function marketDealNotes(m: OptionMarket): string[] {
  const lithium = m.parts.filter((p) => p.hazmat?.lithium).map((p) => `${p.model} (${p.hazmat!.unId})`);
  if (lithium.length === 0) return [];
  const list = lithium.length <= 2 ? lithium.join(' and ') : `${lithium.slice(0, -1).join(', ')} and ${lithium.at(-1)}`;
  return [`This deal holds a lithium battery: ${list}. Amazon treats it as dangerous goods; check it is approved in your FBA account before buying.`];
}
