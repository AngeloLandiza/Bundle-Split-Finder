# Desktop app (step 13)

Honest status: working on macOS; the Windows installer builds on a Mac but has not run on Windows yet. Not done: keychain for keys, SQLite.

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
| Processes | The Tauri shell starts the agent as a bundled sidecar (`binaries/agent-dashboard`, a Node single executable built from `agent/` by `desktop:bundle-agent`). The UI runs in the shell's window. The extension runs in Chrome. |
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
npm run desktop:build:windows  # the Windows x64 installer (NSIS), cross-compiled on this Mac
npm run agent:dashboard # the agent alone, from source
npm run typecheck && npm test
```

## Windows

`npm run desktop:build:windows` (`desktop/build-windows.mjs`) runs `tauri build --runner cargo-xwin
--target x86_64-pc-windows-msvc --bundles nsis`, Tauri's documented route for building Windows apps on
macOS. It writes `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Split Finder_<version>_x64-setup.exe`.
One-time setup on the Mac:

```
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin
brew install nsis llvm lld
```

cargo-xwin downloads Microsoft's CRT and Windows SDK headers and libraries into its cache on the first
build (that download is Microsoft's, under its licence). On a Windows PC the same command builds
natively without cargo-xwin.

- **Sidecar.** `desktop/bundle-agent.ts` reads `TAURI_ENV_TARGET_TRIPLE`. For Windows it takes the official
  `node-v24.13.0-win-x64.zip` from nodejs.org only, checks its SHA-256 against both the release's
  `SHASUMS256.txt` and the hash pinned in the script, caches it in `desktop/node-cache/` (ignored by
  git), removes node.exe's Authenticode signature (`desktop/pe.ts`), and injects the SEA blob with
  postject. The blob must be made by the same Node version (v24.13.0), so the build refuses another.
- **Installer.** NSIS, per user (no admin prompt), into `%LOCALAPPDATA%\Programs`. WebView2 comes with
  Windows 11 and current Windows 10; where it is missing the installer fetches Microsoft's bootstrapper
  (`webviewInstallMode: downloadBootstrapper`, `src-tauri/tauri.windows.conf.json`). Unsigned.
- **Data.** Tauri's app data dir, `%APPDATA%\com.bundlesplitfinder.desktop`, as on the Mac
  (`agent-token`, `store/`). Files the Mac writes 0600 (keys, pairing, the token) are narrowed on Windows
  to the current user with `icacls` before their content is written (`agent/winAcl.ts`); if that fails
  they keep the folder's per-user permissions and the agent logs it once. The extension unpacks to
  Documents\split-finder (the known folder, so a OneDrive-redirected Documents works) with
  System32 `tar.exe`.
- **Window.** The standard Windows frame and title bar; on Windows 11 Mica behind a transparent webview,
  and the page is told `__SPLIT_FINDER_SHELL__.backdrop = 'mica'`; on Windows 10 an opaque window and no
  backdrop. Fluent overlay scrollbars (WebView2 125+). No menu bar: the shortcuts the Mac's menu carries
  must come from the page's own key handlers.
- **Tray.** The notification-area icon is the colour app icon. Left click toggles the flyout (the
  popover) above the icon, kept inside the monitor's work area so a taskbar on any edge is not
  covered; a double click opens the window; right click is the menu (Open, Scan now, Open questions,
  Pause, Settings, Exit). No taskbar badge: the count is in the tooltip.
- **Quit.** Windows has no SIGTERM for a windowless child: the shell posts `/api/agent/quit` (app
  token only), waits up to 3 s for the port to close, then kills the process.
- **Launch at login.** The autostart plugin writes the per-user Run key.

Unverified until it runs on a Windows PC: install and first launch; Mica and the transparent
webview; the flyout's position, focus and hide-on-blur; Chrome opening `chrome://extensions` from
the Helper menu; `icacls` on a real profile; toast sound; launch at login; quit leaving no agent
behind.

## What is not done

- **Windows on real hardware.** The installer is built on a Mac (below) but has not been run
  on Windows by us yet; see the list under Windows for what is unverified. The VM guide
  `docs/windows-vm.md` is superseded.
- **Keychain.** Keys sit in a file readable only by the owner. The OS keychain is the next step.
- **SQLite.** The store rewrites a whole JSON file per collection. Fine at this size.
- **Signing.** The app is unsigned, so macOS asks you to approve it. A signed app would also
  allow a real notification-click callback; today the click is inferred from the app being
  activated within two minutes.
- **Extension install.** The zip ships inside the app, but the app has no button for installing
  it; load it by hand (see `install.md`).

Decisions and reasons: `docs/decisions.md` (step 13 entries) and
`docs/superpowers/plans/2026-11-22-step-13-agent-workplace.md`.
