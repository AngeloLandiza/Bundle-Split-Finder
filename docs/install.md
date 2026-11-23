# Install Split Finder

For the daily user, a plain-words guide is in `docs/guide.md`.

Split Finder finds discounted DEWALT and RYOBI bundles on Home Depot, splits each into its
parts, matches the parts to Amazon listings and ranks bundles by estimated profit. The desktop
app does the work. The Chrome extension reads Home Depot pages for it. It runs on macOS and
on Windows 10 or 11 (64-bit).

## 1. Install the app

1. Open the DMG and drag **Split Finder** to Applications. (To build it yourself:
   `npm run desktop:build`; the DMG is in `src-tauri/target/release/bundle/dmg/`.)
2. Open Split Finder. If macOS blocks it, the app is unsigned: right-click it, choose Open.
3. The first screen walks you through connecting Chrome and adding the SerpApi key.

The app lives in the menu bar. Closing the window does not stop it. Quit from the menu bar
icon.

### On Windows 10 or 11 (64-bit)

1. Run `Split Finder_<version>_x64-setup.exe`. (To build it on a Mac: `npm run
   desktop:build:windows`; it is in `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`.
   See `docs/desktop-app.md`, Windows.)
2. The installer is not signed yet, so Windows SmartScreen says "Windows protected your PC".
   Click **More info**, then **Run anyway**. It installs for you only; no administrator prompt.
3. The app needs Microsoft Edge WebView2. Windows 11 has it. On a Windows 10 PC without it, the
   installer downloads and installs it first (an internet connection is needed for that step).
4. Split Finder starts from the Start menu. It lives in the notification area by the clock (if
   the icon is not there, open the ^ arrow, or pin it in Settings, Personalization, Taskbar,
   Other system tray icons). Left click opens the small flyout, right click the menu, Exit
   stops it. Closing the window does not stop it.

Its data folder is `%APPDATA%\com.bundlesplitfinder.desktop`. The Chrome helper unpacks to
`Documents\split-finder`. Everything else below is the same, with Settings in place of
Preferences and File Explorer in place of Finder.

## 2. Install the extension

1. In the app, open Settings, Chrome helper (or the first-run setup, step 1) and press
   **Install the Chrome helper**. The app unpacks the extension into `Documents/split-finder`
   and says where it went.
   (The zip is also inside the app: right-click Split Finder in Applications, Show Package
   Contents, Contents, Resources, `bundle-split-finder-<version>-chrome.zip`. Unzip it by hand
   to a folder you will keep if the button is not there. From a clone, `npm run package`
   makes the same zip in `output/`.)
2. In Chrome open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**
   and choose that folder.

To update, unzip the new zip over the same folder and click reload on the extension's card.
Do not remove the extension: that deletes its saved data.

## 3. Pair them

1. In Chrome, open the Split Finder side panel and press **Connect to the Split Finder app**.
   Chrome asks to allow access to the app on this computer; allow it.
2. The panel shows a 6-digit code. The app shows a band: "Chrome wants to connect. Code ...".
3. Check the codes match and press **Allow** in the app.

Only a paired Chrome can talk to the app. Settings, Chrome helper, lists paired browsers and
can revoke one. If the app stops recognising Chrome, the panel says so; connect again.

## 4. Add keys in the app

Open **Settings, Keys**. A key is saved in the app's data folder on this Mac and is never
shown again: you can replace or remove it, not read it back.

- **SerpApi (required).** Every Home Depot results page and every Amazon lookup is one search.
  The free plan is 250 a month and 50 an hour. Get a key at
  [serpapi.com](https://serpapi.com/users/sign_up).
- **Keepa (optional).** Amazon price history and trends.
- **Anthropic, or an OpenAI-compatible model such as DeepSeek (optional).** Used for the listing
  check, Ask AI and research. For DeepSeek or similar, add the key and set the base URL and
  model under **AI**. Cost is billed to that account; the app keeps a monthly cap (default $25,
  0 turns AI off). The key is not checked when saved, because a check costs money.
- **eBay (optional).** A reference for what New units sold for. It is not counted in the
  profit estimate and needs a model key to check listings.
- **Telegram (optional).** A bot token and chat id; it carries the same digest as the
  notification, never a key.

## 5. What runs on its own

Set the schedule under **Settings, Scanning**: only when you press Scan now, every 6 or 12
hours, or once a day. While the app is running and not paused, the agent then:

- scans Home Depot and looks up Amazon parts, within **Searches per scan** and keeping your
  **reserve** untouched (a scheduled scan keeps the reserve; Scan now may use it);
- pulls Keepa data inside the scan, if a Keepa key is set;
- runs the **AI pass** on open Review questions and saves suggestions. A suggestion is never
  an answer by itself;
- runs **Autopilot** (a switch in Settings, off by default; turn it on to apply without a tap): it applies a suggestion only when
  the code checked its quotes against the source, it is a split question, and the model is one
  you marked trusted. Each one is in **Activity** with **Undo**. Anything unverified, "cannot
  tell" or "none fits" waits in Review for you;
- sends one **digest** per run: new deals above your ROI and profit minimums, questions
  waiting, what Autopilot applied. It is a Mac notification, and Telegram if set.

Pause and Resume are in the menu bar. **Launch at login** is a switch under Settings, General.

## 6. What needs Chrome open

Reading Home Depot pages, including part prices, runs in your Chrome through the extension.
With Chrome closed, those reads wait and the app says so; the next scan with Chrome open reads
them. Everything else runs without Chrome.

## 7. Your first scan

Settings starts at 5 searches per scan with 100 held in reserve. Leave those until you have
seen one scan. Press **Scan now**; **Stop** ends it early. Then open **Review** and answer what
the tool will not guess. A part left unanswered counts at $0.

## 8. Estimates are estimates

Profit and ROI come from the fee settings (referral fee, fulfillment, sales tax, inbound
cost), not your real Amazon fees. Change them under **Settings, Fees** to match your account.
Every price and match links to its Home Depot or Amazon source.

## Using the extension alone

Unpaired, the extension works as before: its own side panel, its own keys in Chrome, scans
started from the panel. See the extension's Settings. Once paired, the app does the work.
