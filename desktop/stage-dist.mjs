// Copies packaged extension zip into desktop/dist for the Tauri resource bundle.
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const out = join(root, 'output');
const dist = join(root, 'desktop', 'dist');
const zips = readdirSync(out).filter((f) => f.endsWith('-chrome.zip'));
if (zips.length !== 1) throw new Error(`Expected one chrome zip in output/, found ${zips.length}`);
mkdirSync(dist, { recursive: true });
copyFileSync(join(out, zips[0]), join(dist, zips[0]));
console.log(`Staged ${zips[0]} for desktop bundle`);