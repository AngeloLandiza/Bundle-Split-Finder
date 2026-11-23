// Builds output/split-finder-vm-kit.zip: unpacked extension + Windows launchers + guides.
// Does not spend SerpApi or Keepa. Run npm run package first (this script invokes it).
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const stage = join(root, '.vm-kit-stage');
const outZip = join(root, 'output', 'split-finder-vm-kit.zip');

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
mkdirSync(join(root, 'output'), { recursive: true });

execFileSync('npm', ['run', 'package'], { cwd: root, stdio: 'inherit' });

const zips = readdirSync(join(root, 'output')).filter((f) => f.endsWith('-chrome.zip'));
if (zips.length !== 1) throw new Error(`Expected one chrome zip in output/, found ${zips.length}`);
const chromeZip = join(root, 'output', zips[0]!);
const extDir = join(stage, 'chrome-extension');
mkdirSync(extDir, { recursive: true });
execFileSync('unzip', ['-q', chromeZip, '-d', extDir], { cwd: root });

cpSync(join(root, 'windows'), join(stage, 'windows'), { recursive: true });
mkdirSync(join(stage, 'docs'), { recursive: true });
copyFileSync(join(root, 'docs/install.md'), join(stage, 'docs/install.md'));
copyFileSync(join(root, 'docs/windows-vm.md'), join(stage, 'docs/windows-vm.md'));

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string;
writeFileSync(
  join(stage, 'QUICKSTART.txt'),
  `Split Finder VM kit (v${version})

You need the full project folder inside the VM for the local agent (npm run agent:dashboard).
This zip gives you a ready-made Chrome extension folder and Windows shortcuts.

FAST PATH (extension only):
  1. Install Google Chrome in the VM.
  2. chrome://extensions → Developer mode → Load unpacked.
  3. Choose the chrome-extension folder next to this file.

FULL PATH (extension + agent):
  1. Copy or clone the whole Bundle-Split-Finder repo into the VM (shared folder or git).
  2. Double-click windows\\SplitFinder-Setup.vbs (or .bat) in that repo.
  3. Load unpacked from the path Setup prints (or use chrome-extension here if versions match).
  4. Double-click windows\\SplitFinder-Start.vbs for the agent dashboard.

Optional .exe launchers (in the VM only):
  powershell -ExecutionPolicy Bypass -File windows\\build-exes.ps1

Read docs\\windows-vm.md for UTM, Chrome, and shared-folder tips.
`,
);

rmSync(outZip, { force: true });
execFileSync('zip', ['-rq', outZip, '.'], { cwd: stage });
rmSync(stage, { recursive: true, force: true });

console.log(`\nVM kit: ${outZip}`);
console.log('Copy this zip (or the whole repo) into your Windows VM, then follow QUICKSTART.txt');