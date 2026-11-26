// Copies this version's packaged extension zip into desktop/dist for the Tauri resource bundle.
// desktop/dist is bundled whole (tauri.conf.json resources: desktop/dist/*-chrome.zip) and the app takes the one zip it
// finds, so a zip of another version left there after a version change is removed: the app must ship exactly its own helper.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const out = join(root, 'output');
const dist = join(root, 'desktop', 'dist');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const zip = `bundle-split-finder-${version}-chrome.zip`;
if (!existsSync(join(out, zip))) throw new Error(`Expected ${zip} in output/ (run npm run package first)`);
mkdirSync(dist, { recursive: true });
for (const old of readdirSync(dist).filter((f) => f.endsWith('-chrome.zip') && f !== zip)) {
  unlinkSync(join(dist, old));
  console.log(`Removed ${old} from the desktop bundle (another version)`);
}
copyFileSync(join(out, zip), join(dist, zip));
console.log(`Staged ${zip} for desktop bundle`);
