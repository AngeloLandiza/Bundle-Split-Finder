# Desktop app (step 13)

Honest status: the Mac `.dmg` and the Windows `.exe` installer are both built and working on the Mac. The Windows build has not been run on a real PC yet. Not done: keychain for keys, SQLite.

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
--target x86_64-pc-windows-msvc` (NSIS only: `bundle.targets` in `src-tauri/tauri.windows.conf.json`;
the CLI on a Mac refuses `--bundles nsis`), Tauri's documented route for building Windows apps on
macOS. It writes `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Split Finder_<version>_x64-setup.exe`.
One-time setup on the Mac:

```
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin
brew install nsis llvm lld
```

cargo-xwin downloads Microsoft's CRT and Windows SDK headers and libraries into its cache on the first
build (that download is Microsoft's, under its licence, about 1 GB), and the Tauri CLI fetches its
NSIS plugin (`nsis_tauri_utils.dll`, hash-checked) from Tauri's GitHub releases. On a Windows PC the
same command builds natively without cargo-xwin. The installer is about 26 MB (0.1.0); the VC runtime
is linked statically, so nothing else needs installing.

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
  `"Split Finder.exe" --quit` quits a running app the same way as the tray's Exit (a second launch hands the
  argument to the running app; with no app running it starts nothing). The Windows smoke test quits with it.
- **Launch at login.** The autostart plugin writes the per-user Run key.

Unverified until it runs on a Windows PC: install and first launch; Mica and the transparent
webview; the flyout's position, focus and hide-on-blur; Chrome opening `chrome://extensions` from
the Helper menu; `icacls` on a real profile; toast sound; launch at login; quit leaving no agent
behind.

## Updates

The shell updates the app from the project's GitHub releases (`src-tauri/src/updater.rs`, tauri-plugin-updater 2.14),
from Rust, so it works with no window open. No page has an updater permission.

| Piece | Detail |
| --- | --- |
| Where | `https://github.com/AngeloLandiza/Bundle-Split-Finder/releases/latest/download/latest.json` only, HTTPS only; redirects only to `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`; the update file must be under `github.com/AngeloLandiza/Bundle-Split-Finder/releases/download/`. |
| When | A look a minute after launch, then every 6 hours (wall clock). A newer version is downloaded at once and verified. Every 20 s the shell offers it to the agent (`POST /api/update/pending`), which answers with core's `installDecision`: the owner's setting (Install new versions automatically, default on) or Install now, nothing running (a scan, the AI, a lookup), and not from 15 minutes before a scheduled scan to 5 minutes after its time. |
| Trust | `plugins.updater.pubkey` in `tauri.conf.json` (written by `npm run updater:setup`). `requireSignedVersion`: the signature must name the version latest.json announces. Never a version that is not newer. |
| Install | `agent::stop` as Quit, then the plugin installs: Windows runs the NSIS installer passive with `/UPDATE` (per user, no admin prompt; the data folder and the Run key are left alone) and it starts the app again; macOS swaps the `.app` bundle and the shell restarts. A failure starts the agent again on the old version. |
| Told | `POST /api/update/report` (last checked; a failure is one Activity line). Before installing the agent writes `runtime.selfUpdate.installing`; the next start turns it into "Split Finder was updated to X" (a calm notice) or "The update to X did not finish". With automatic installs off: "Version X is ready" once (notice, Activity, the new-version message) and Install now (`POST /api/update/install-now`). |
| Without a key | A debug build, or a build whose `pubkey` is empty, never updates; `SPLIT_FINDER_UPDATER` tells the agent why, Settings says so, and the agent reads `docs/release.json` as before (a message and a link). |
| Releases | `.github/workflows/release.yml` (tag `v*`): steps in `docs/install.md`, "Releasing a new version". |

Unverified: an update from one released version to the next on a real PC or Mac (the first one will be the first
check); the Windows side of the shell (type-checked on the Mac with cargo xwin, not linked or run); the Mac build on
GitHub's runner.

## What is not done

- **Windows on real hardware.** The installer is built on a Mac (below) but has not been run
  on Windows by us yet; see the list under Windows for what is unverified. The VM guide
  `docs/windows-vm.md` is superseded.
- **Keychain.** Keys sit in a file readable only by the owner. The OS keychain is the next step.
- **SQLite.** The store rewrites a whole JSON file per collection. Fine at this size.
- **Signing.** The app is not signed with an Apple or Microsoft certificate (updates are signed with the project's own
  key, which is another thing: see Updates), so macOS asks you to approve it. A signed app would also
  allow a real notification-click callback; today the click is inferred from the app being
  activated within two minutes.
- **Extension install.** The zip ships inside the app. The app has an **Install the Chrome helper**
  button (the welcome sheet and Settings, Chrome) that unpacks it into a folder; Chrome still needs
  Developer mode and **Load unpacked** once, because the app cannot do that for you (see `install.md`).

## Settings, Data

- **Export audit file** (`GET /api/export/audit`): one JSON file, `split-finder-audit-<date>.json`, with the scan
  store (bundles with their read pages, matches, part prices, reviews, scans), deals, Review questions and
  suggestions, Activity (runs, errors, answers, Autopilot), settings without keys, the app and helper versions and
  the platform. Every string goes through the key scrubber, and a last check refuses the whole file (a plain error,
  nothing written) if any stored key value is still in it. No key is included.
- **Reset scan data** (`POST /api/data/reset`, body `{ "confirm": "RESET" }`): copies what it deletes to
  `<app-data>/backup-before-reset-<time>/` (kept, no keys), then clears the scan store, deals, Review,
  suggestions, Activity, Autopilot history, saved answers, tracking and queued jobs. Keys, settings, pairing and the
  saved search responses stay. It refuses (409) while a scan, an ask, an answer or the drip is writing.

Decisions and reasons: `docs/decisions.md` (step 13 entries) and
`docs/superpowers/plans/2026-11-22-step-13-agent-workplace.md`.
