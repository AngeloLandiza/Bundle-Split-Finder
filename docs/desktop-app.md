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