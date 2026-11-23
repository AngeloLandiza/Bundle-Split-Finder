# Desktop app (step 13)

Honest status: working on macOS. Not done: Windows packaging, keychain for keys, SQLite.

## How it fits together

```
 Tauri shell (src-tauri)          Node agent (agent/)              Chrome
 tray, window, notifications  --> HTTP API on 127.0.0.1:8790 <---- extension (paired helper)
 starts the agent, reads token     store, schedule, scans,          long-polls for Home Depot
        |                          Keepa, AI, Autopilot, alerts     read jobs, posts results
        v                                  ^
 Desktop UI (desktop-ui)  -----------------+
 React, served by the agent at /ui/        core/ (pure logic) is used by all three
```

| Piece | Detail |
| --- | --- |
| Processes | The Tauri shell starts the agent as a bundled sidecar (`binaries/agent-dashboard`, built from `agent/` by `desktop:bundle-agent`). The UI runs in the shell's window. The extension runs in Chrome. |
| Port | `127.0.0.1:8790` only. The agent checks Host (no DNS rebinding) and Origin (the app's own or the paired extension's). |
| Auth | The app uses a token file, `<app-data>/agent-token` (owner-only). The shell injects it into the UI. The extension pairs once: a 6-digit code approved in the app returns its own token. Only a hash of each token is kept. No endpoint returns a key. |
| Store | One writer, the agent. JSON files under `<app-data>/store/`, written to a temp file and renamed. A lock file refuses a second agent on the same folder. Keys are in `store/keys.json`, mode 0600. |
| Events | `GET /api/events` (server-sent): `state`, `deals`, `review`, `activity`, `notify`. The UI and the shell both listen. The shell turns `notify` into a native notification and the review count into the tray count. |
| Home Depot reads | Queued as worker jobs. The extension long-polls `/api/worker/next` and posts results. Jobs wait while Chrome is closed. |
| Contract | `core/src/api/`, shared by agent, UI and extension. |

The shell: tray with open-question count, close to tray, single instance, window size
remembered (minimum 1000x680), Cmd+R scan, Cmd+, settings, launch at login (opt-in).

## Commands

```
npm run desktop:dev     # builds the UI, starts the agent from source on the app's data folder, runs tauri dev (needs Rust)
npm run ui:dev          # the UI with hot reload in a browser, proxying /api to a running agent
npm run ui:mock         # the UI on fixture data, no agent (VITE_MOCK=1; ?mock=offline|chrome-closed|limit|scanning|paused|empty|error|firstrun|slow)
npm run desktop:build   # the macOS app and DMG, with the extension zip inside
npm run agent:dashboard # the agent alone, from source
npm run typecheck && npm test
```

## What is not done

- **Windows.** `desktop:build:windows` exists but packaging does not work and is untested.
  Step 13 left it out. The VM guide `docs/windows-vm.md` is superseded.
- **Keychain.** Keys sit in a file readable only by the owner. The OS keychain is the next step.
- **SQLite.** The store rewrites a whole JSON file per collection. Fine at this size.
- **Signing.** The app is unsigned, so macOS asks you to approve it. A signed app would also
  allow a real notification-click callback; today the click is inferred from the app being
  activated within two minutes.
- **Extension install.** The zip ships inside the app, but the app has no button for installing
  it; load it by hand (see `install.md`).

Decisions and reasons: `docs/decisions.md` (step 13 entries) and
`docs/superpowers/plans/2026-11-22-step-13-agent-workplace.md`.
