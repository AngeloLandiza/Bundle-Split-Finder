# Bundle Split Finder

Finds discounted DEWALT and RYOBI bundles on Home Depot, splits each bundle into its parts,
matches the parts to Amazon listings, and ranks bundles by estimated profit. Profit is an
estimate from the fee settings, not the seller's real fees.

## Install (start here if you only want to use it)

You do not need this code, an account on GitHub, or any developer tools. Download one file and open it.

| Your computer | Download |
| --- | --- |
| Windows 10 or 11 (64-bit) | [Split-Finder-Windows-x64-setup.exe](https://github.com/AngeloLandiza/Bundle-Split-Finder/releases/latest/download/Split-Finder-Windows-x64-setup.exe) |
| Mac with Apple silicon (M1 or newer) | [Split-Finder-Mac-Apple-silicon.dmg](https://github.com/AngeloLandiza/Bundle-Split-Finder/releases/latest/download/Split-Finder-Mac-Apple-silicon.dmg) |

All versions are on the [Releases page](https://github.com/AngeloLandiza/Bundle-Split-Finder/releases).

**On Windows**

1. Open the downloaded `.exe`.
2. Windows may say "Windows protected your PC". The installer is not yet signed with a paid certificate; this is
   not a virus warning about this file. Click **More info**, then **Run anyway**.
3. It installs for you only and does not ask for an administrator password.
4. Open **Split Finder** from the Start menu. It keeps running in the notification area (click the ^ arrow if you
   cannot see its icon). Right-click the icon and choose **Exit** to stop it.

**On a Mac**

1. Open the downloaded `.dmg` and drag **Split Finder** to **Applications**.
2. The first time, right-click the app and choose **Open** (it is not signed, so a double-click is blocked).
3. It lives in the menu bar. Choose **Quit** from its menu bar icon to stop it.

**Then**

The app opens a welcome window with three steps: connect Chrome (you need Google Chrome installed), add a
SerpApi key (free at serpapi.com), and run the first scan. Each step is explained in the
[getting started guide](docs/guide.md), which also covers a normal day, what costs money, and what to do when
something looks wrong.

Three things to know before you rely on it:

- **It never buys or lists anything.** Every profit figure is an estimate, and every price and match links to its
  Home Depot or Amazon page so you can check it.
- **Enter your sales tax and inbound shipping** in Settings, Scanning. Until you do, profit is shown "before sales
  tax and inbound shipping".
- **To report a problem**, open Settings, Data, press **Export audit file**, and send that file. It contains no keys.

## What it is now (step 13)

- **The desktop app is the agent and the work place.** It runs the schedule, the scans, the
  Keepa and AI passes, Autopilot and the messages, and it holds the keys. You work in it:
  Today, Deals, Review, Activity, Settings. It lives in the menu bar and keeps running when
  the window is closed.
- **The Chrome extension is its paired helper.** It reads Home Depot pages in your Chrome
  when the app asks, and shows the on-page chip. It pairs with the app by a 6-digit code.
  When Chrome is closed, Home Depot reads wait.
- **The extension still works alone.** Unpaired, it keeps its own side panel, keys and scans.

Honest status: a Mac `.dmg` and a Windows `.exe` installer are both built and attached to each release.
The Windows installer is installed, started, checked and uninstalled on a Windows machine by an automated
check (`.github/workflows/windows-smoke.yml`) before a release; it has not yet been used day to day on a real
PC. Neither installer is signed. Keys are in a file only the owner can read (not the keychain), and the store
is JSON files (not SQLite). Details in `docs/desktop-app.md`.

## Start here

| To | Read |
| --- | --- |
| Daily use, in plain words (Alex) | `docs/guide.md` |
| Install and set up (owner, PO) | `docs/install.md` |
| How the app is built, what is not done | `docs/desktop-app.md` |
| What was decided in step 13 | `docs/superpowers/plans/2026-11-22-step-13-agent-workplace.md` and `docs/decisions.md` |

## Commands

```
npm install
npm run typecheck
npm test                  # no network
npm run desktop:dev       # the app with the agent, live (needs Rust)
npm run desktop:build     # the macOS app and DMG (needs Rust)
npm run desktop:build:windows  # the Windows x64 installer (.exe), built on a Mac
npm run ui:dev            # the app's UI in a browser, against a running agent
npm run ui:mock           # the app's UI on fixture data, no agent
npm run ext:dev           # the extension with live reload
npm run package           # the extension zip, in output/
npm run budget            # free: what the SerpApi account has and what may be spent
npm run scan -- --fixtures   # free: the whole pipeline on recorded responses
```

Nothing may call serpapi.com except through `SerpApiClient`. Before a command that can spend
searches, run `npm run budget`. Rules for anyone working here are in `CLAUDE.md`.

## Where things live

| Folder | What |
| --- | --- |
| `core/` | Pure TypeScript: splitting, matching, profit, the pipeline, the API contract (`core/src/api/`), AI providers. No `chrome.*`, no `node:*`. |
| `agent/` | The Node agent: HTTP API, store, schedule, scans, Autopilot, alerts, worker jobs. |
| `desktop-ui/` | The app's screens (React, Vite). |
| `src-tauri/` | The Tauri shell: window, tray, notifications, launch at login. Starts the agent. |
| `desktop/` | Build and dev scripts for the app. |
| `extension/` | The Chrome extension (WXT). |
| `scripts/`, `fixtures/`, `docs/` | Node tools, recorded responses, plans and specs. `reference/` is the old Python prototype. |
