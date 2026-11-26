// Builds the production extension and writes one zip under output/. Spends no searches and reads no .env.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { runTool } from './spawn-tool';

const outDir = '.output-package';
// Its own folder, with the end-to-end and debug switches off, so .output/chrome-mv3 (loaded in Chrome) is untouched.
runTool('npx', ['wxt', 'zip'], {
  // NODE_ENV is forced: a parent run under vitest sets it to "test", and React then builds its development JSX (absolute paths).
  env: {
    ...process.env,
    NODE_ENV: 'production',
    SPLIT_FINDER_E2E: '',
    SPLIT_FINDER_DEBUG: '',
    SPLIT_FINDER_PROD_CHECK: '',
    SPLIT_FINDER_PACKAGE: '1',
    SPLIT_FINDER_HELPER: '1',
  },
  stdio: 'inherit',
});
// This version's zip, by name: after a version change the folder still holds the last version's zip, which is left alone.
const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
const zip = `bundle-split-finder-${version}-chrome.zip`;
if (!existsSync(join(outDir, zip))) throw new Error(`Expected ${zip} in ${outDir}; it holds ${readdirSync(outDir).filter((f) => f.endsWith('-chrome.zip')).join(', ') || 'no zip'}.`);
mkdirSync('output', { recursive: true });
copyFileSync(join(outDir, zip), join('output', zip));
console.log(`\nPackage: output/${zip}`);
