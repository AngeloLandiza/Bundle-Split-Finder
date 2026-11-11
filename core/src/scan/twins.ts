// A RYOBI part's twins (Ruling 70): its other written forms, PCL515 for PCL515B or the reverse, which
// name the same product. Each form keeps its own match record under its own part key. The rules below
// keep the two from saying different things about one listing (fix round 1 of Q1a).

import { modelForms } from '../match';
import { type MatchRecord, partKey, type ScanStore } from './types';

/** The part keys of a part's twins; none for DEWALT. */
export const twinKeys = (brand: string, model: string): string[] => {
  const own = partKey(brand, model);
  return modelForms(brand, model).map((f) => partKey(brand, f)).filter((k) => k !== own);
};

/** The twins of the part a part key names (`BRAND:MODEL`). */
export const twinKeysOf = (key: string): string[] => {
  const at = key.indexOf(':');
  return at < 0 ? [] : twinKeys(key.slice(0, at), key.slice(at + 1));
};

/**
 * Writes `record`'s outcome to each stored twin record that `replace` accepts, under the twin's own
 * key, brand and model. A twin with no record is left to take it when it is next judged (sharedMatch).
 */
export async function writeTwins(store: ScanStore, record: MatchRecord, replace: (twin: MatchRecord) => boolean): Promise<void> {
  for (const key of twinKeys(record.brand, record.model)) {
    const twin = await store.getMatch(key);
    if (twin && replace(twin)) await store.putMatch({ ...record, key: twin.key, brand: twin.brand, model: twin.model });
  }
}
