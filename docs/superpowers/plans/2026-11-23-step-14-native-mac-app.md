# Step 14: a native Mac app

**Owner (Nov 23), on the step 13 UI (a centered first-run column, paper/ink web styling):** "don't you think you can make this app more native … what happened to using principal UI/UX designs … make this better. I want it cooler, better and native and where everything lives. I want options." · "if I need to do the setup first to see everything let me know" (answer: no — and setup must never block the app).

**Direction:** the desktop app follows macOS conventions, not the extension's web design system (the extension side panel keeps its own). Product rules stay: estimates labelled, every price/match with a source link, no emoji, never guess.

## The native shell (D1 — foundation, Opus)
- **Window:** unified title bar — `titleBarStyle: Overlay`, hidden title, traffic lights inset into the sidebar; the sidebar is translucent (macOS vibrancy, "sidebar" material); the content area is the window background; full-size content; drag regions on the toolbar; min 1000×680.
- **Typography:** the system font (SF Pro via `-apple-system`), 13px body like AppKit, SF Pro tabular numerals for money/ROI/counts, SF Mono only for model numbers and ASINs.
- **Colour:** system semantic colours (label, secondary label, separator, control background, selected content), the system accent colour (WebKit `-apple-system-control-accent` with a fallback), light / dark / follow system; profit green and loss red from the system palette; no paper/ink.
- **Layout:** sidebar source list — Today; Deals with saved views (All, Confirmed, Needs an answer, Waiting for a lookup, Losing money); Review with its badge; Activity; a bottom status block (agent state, next scan, searches left, Chrome connected). Toolbar in the title bar per screen (Scan button with progress, search field, view options). Inspector on the right for a selected deal or question (toggle Cmd+Opt+I). Native-like controls: segmented controls, pop-up buttons, switches, search field, table with zebra/hover/selection in accent, context menus.
- **Never blocked:** first run is a welcome **sheet** over the live app (steps with progress, Skip); while setup is incomplete a quiet "Finish setup · 2 of 3" item sits at the sidebar's foot.

## Then, in parallel
- **D2 Preferences window (Sonnet):** a separate window (Cmd+,) with toolbar tabs — General (appearance, accent, density, launch at login, menu bar icon, Dock icon, sounds), Scanning (schedule, per-scan cap, reserve, forecast, brands, fees), Keys, AI & Autopilot (provider/model per pipeline, trust, monthly cap, Autopilot on/off, what it may apply), Notifications (per kind on/off, ROI and profit thresholds, digest timing, quiet hours, Telegram), Chrome (pairing, helper status, install), Data (export, reset scan data, open data folder), Advanced (logs, agent port status). Changes save as you go; agent settings gain the new fields.
- **D3 Power features (Sonnet):** command palette (Cmd+K: go to, scan, find a deal by model, ask AI, open settings), context menus on deals and questions, keyboard shortcuts sheet (Cmd+/), Quick actions in the inspector.
- **D4 Menu bar extra (Sonnet):** clicking the menu bar icon opens a small popover window — needs-you count, best new deal, agent state, Scan now, Pause, Open app; Dock badge with the open-question count.

Testing scope as always: typecheck + unit tests; one visual look per screen by the builder; the controller rebuilds and installs the DMG and looks at the real window.
