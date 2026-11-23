# Bundle Split Finder

Finds discounted DEWALT and RYOBI bundles on Home Depot, splits each bundle into its parts,
matches the parts to Amazon listings, and ranks bundles by estimated profit. Profit is an
estimate from the fee settings, not the seller's real fees.

## What it is now (step 13)

- **The desktop app is the agent and the work place.** It runs the schedule, the scans, the
  Keepa and AI passes, Autopilot and the messages, and it holds the keys. You work in it:
  Today, Deals, Review, Activity, Settings. It lives in the menu bar and keeps running when
  the window is closed.
- **The Chrome extension is its paired helper.** It reads Home Depot pages in your Chrome
  when the app asks, and shows the on-page chip. It pairs with the app by a 6-digit code.
  When Chrome is closed, Home Depot reads wait.
- **The extension still works alone.** Unpaired, it keeps its own side panel, keys and scans.

Honest status: a Mac `.dmg` and a Windows `.exe` installer are both built. The Windows build has
not been run on a real PC yet. Keys are in a file only the owner can read (not the keychain), and
the store is JSON files (not SQLite). Details in `docs/desktop-app.md`.

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
