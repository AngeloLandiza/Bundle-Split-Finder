# Native desktop app + Chrome extension

The v2 plan splits the product into two parts ([plan §0 and Phase 3](superpowers/plans/2026-11-22-keepa-agent-discovery-tracking.md)):

| Piece | Role |
| --- | --- |
| **Chrome extension (Split Finder Helper)** | Home Depot chip, page reads, background scans, bridge POST — thin helper when Lane D `appPrimaryUi` is on. |
| **Native app (Tauri)** | Main product UI (`/ui/`): setup, settings, deals, review, scan. Embeds the localhost agent (port 8790). |

There is **no** single binary that replaces Chrome. The `.app` / `.exe` is the **agent companion**; scans that need Home Depot page reads still go through the extension.

## Build outputs

From a clone with Rust ([rustup](https://rustup.rs)) and Node:

```bash
npm install
npm run desktop:build          # macOS: .dmg in src-tauri/target/release/bundle/dmg/
npm run desktop:build:windows  # on Windows or cross: .msi/.exe installer
```

Development (live reload, agent on port 8790):

```bash
npm run desktop:dev
```

## What ships in the DMG / Windows installer

- **Split Finder** Tauri app (menubar/window) pointing at the local dashboard (`http://127.0.0.1:8790`).
- **Extension zip** in app resources (`bundle-split-finder-*-chrome.zip`); menu **Install extension** opens the folder / copy instructions.
- The **dashboard** ships **inside** the app (embedded sidecar). Opening Split Finder starts it on port **8790** — no Terminal and no npm for end users.
- **Scans** still run in **Chrome** (Home Depot page reads). `npm run agent:scan` in the repo stays a developer-only tool.

## Install path for Mac users

1. Open the **DMG**, drag **Split Finder** to Applications.
2. Launch **Split Finder** → dashboard opens.
3. Menu **Install extension** → unzip the bundled zip to a permanent folder (e.g. `~/Documents/split-finder`).
4. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → that folder.
5. Follow [`install.md`](install.md) for SerpApi / Keepa keys.

## Install path for Windows users

Same flow with the **Split Finder Setup.exe** from `desktop:build:windows`. Use **Google Chrome** (not Edge-only) for the extension. Optional VM scripts in `windows/` remain for repo-based development.

## Why this is not "just an exe"

The extension must run inside Chrome's extension APIs. The native installer distributes **both** artifacts and keeps the agent running outside the browser, which is what the plan called **menubar app + extension**.

## The shell (step 13, W3)

What the Tauri shell does, in `src-tauri/src/`:

- **Tray** (`shell.rs`): template icon, menu with Open Split Finder, Scan now, Open questions (N), Pause or Resume agent, Settings, Quit. On macOS the open-question count shows as text beside the icon (`set_title`); elsewhere it is the tooltip.
- **Close to tray**: closing the window hides it and the agent keeps running. Quit (tray, app menu or Cmd/Ctrl+Q) stops the sidecar: SIGTERM, then kill after about 3 seconds. A second launch focuses the window (single instance).
- **Window**: title "Split Finder", default 1280x800, minimum 1000x680, size and position remembered (window-state; visibility is deliberately not remembered).
- **Shortcuts** (application menu): Scan now Cmd/Ctrl+R (`POST /api/scan`), Settings Cmd/Ctrl+, , Find Cmd/Ctrl+F.
- **Notifications** (`events.rs`): the shell subscribes to `GET /api/events` (Rust side, reconnect with backoff 1 s to 30 s). `event: notify` with `{title, body, kind, count?}` becomes a native notification. `event: state` or `review` carrying `counts.review` and `agent.status` drives the tray count and the Pause/Resume label (when the payload has neither, the shell fetches `GET /api/state`).
- **Launch at login**: opt-in. A checkbox in the application menu, and the page can call the Tauri commands `get_launch_at_login` and `set_launch_at_login({enabled})` through `window.__TAURI_INTERNALS__.invoke` (allowed only for `http://127.0.0.1:8790/*`, see `capabilities/agent-ui.json`).
- **Token**: the shell reads `<app-data>/agent-token` (constant `TOKEN_FILE` in `agent.rs`), sends it as `Authorization: Bearer`, and sets `window.__SPLIT_FINDER_TOKEN__` before each page load.
- **Contract with the page**: window events `split-finder:navigate` (`detail.route`, e.g. `/review`) and `split-finder:find`; the shell also sets `location.hash` to the route. Routes: `/today`, `/deals`, `/review`, `/activity`, `/settings`.
- **Agent endpoints the shell assumes**: `GET /api/events`, `GET /api/state`, `POST /api/scan`, `POST /api/agent/pause`, `POST /api/agent/resume`.
- **Developer paths**: the extension zip is found through `SPLIT_FINDER_HOME` or the current directory. No fixed path. Windows is out of scope for this step.
- **Known limit**: desktop notification plugins have no click callback. A click is detected as the app being activated (Dock click, window focus) within two minutes of a notification, then the shell navigates to the notification's screen.
