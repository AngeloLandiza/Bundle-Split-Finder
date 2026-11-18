// npm run validate. All logic is in validate-cli.ts.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseHomeDepotSearch } from '../core/src/serpapi/parsers';
import { openDevClient } from './dev-client';
import { FileCache, ROOT, stateRoot } from './node-store';
import { runValidateCli } from './validate-cli';

/** Home Depot rows in the disk cache, read only: item id hints for the kit pages a dry run asks for. */
function hdRows(): { itemId: string; brand: string; model: string }[] {
  const dir = join(stateRoot(), 'cache', 'home_depot');
  if (!existsSync(dir)) return [];
  const rows: { itemId: string; brand: string; model: string }[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const { data } = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { data: unknown };
    for (const r of parseHomeDepotSearch(data).listings) if (r.brand && r.model) rows.push({ itemId: r.itemId, brand: r.brand, model: r.model });
  }
  return rows;
}

process.exitCode = await runValidateCli(process.argv.slice(2), {
  log: console.log,
  dir: join(ROOT, 'fixtures', 'validation'),
  cache: new FileCache(),
  openClient: openDevClient,
  hdRows,
});
