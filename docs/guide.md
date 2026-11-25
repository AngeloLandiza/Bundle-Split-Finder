# Split Finder: getting started

For Alex. You have the installer file and this page. Nothing here needs any technical skill.

## 1. What it does

Split Finder looks for discounted DEWALT and RYOBI bundles on Home Depot. It splits each bundle into its parts and finds each part on Amazon. Then it ranks the bundles by estimated profit.

It never buys anything. It never lists anything. The profit figures are estimates. They come from the fee numbers you set in Settings, not from your real Amazon fees. Every price and match has a link to its Home Depot or Amazon page, so you can check it yourself.

## 2. Install

### On Windows 10 or 11 (64-bit)

1. Double-click `Split Finder_<version>_x64-setup.exe`.
2. Windows may say "Windows protected your PC". This is because the installer is new and not yet signed with a paid certificate. It is not a virus warning about this file. Click **More info**, then **Run anyway**.
3. It installs for you only. It does not ask for an administrator password.
4. It needs Microsoft Edge WebView2. Windows 11 already has it. If your Windows 10 PC does not, the installer downloads and installs it by itself (it needs internet for that).
5. Open Split Finder from the Start menu.

The app keeps running by the clock, in the notification area, after you close its window. If you cannot see the icon, click the ^ arrow. Right-click the icon for the menu. To stop the app, choose **Exit**.

### On a Mac

Open the DMG and drag Split Finder to Applications. The first time, macOS may block it because it is unsigned. Right-click the app and choose Open. The app lives in the menu bar. To stop it, use Quit from the menu bar icon.

## 3. Your first 10 minutes

When you first open the app, a welcome window shows three steps. You can use the app behind it. **Skip for now** closes it. "Finish setup" at the bottom of the left list opens it again.

**Step 1: Connect Chrome.** The app reads Home Depot pages through a small Chrome add-on, called the helper.

1. In the welcome window, press **Install the Chrome helper**. The app unpacks it into `Documents\split-finder` and tells you where.
2. In Chrome, type `chrome://extensions` in the address bar. Turn on **Developer mode**. Click **Load unpacked** and choose that folder.
3. Open the Split Finder side panel in Chrome and press **Connect to the Split Finder app**. Chrome shows a 6-digit code.
4. The app shows "Chrome wants to connect" with a code. If the two codes match, press **Allow**.

**Step 2: Add your SerpApi key.** SerpApi is the service that fetches the Home Depot and Amazon results. Get a free key at serpapi.com (the welcome window links to it). The free plan gives 250 searches a month and 50 an hour. Paste the key and press **Save**.

**Step 3: Run the first scan.** Press **Scan now**. It takes a few minutes. Keep Chrome open while it runs. At first it uses at most 5 searches and keeps 100 untouched in reserve. Leave those numbers alone until you have seen one scan.

**Optional keys.** Add these later under **Settings, Keys**. Each one only adds something.

| Key | What it adds |
| --- | --- |
| Keepa | Amazon prices and how many units a part sold last month. It works from Keepa tokens that refill over time. |
| Anthropic (or another AI service) | AI suggestions for the questions in Review. |
| eBay | Sold prices on eBay, shown as a reference. They are not counted in the profit estimate. |
| Telegram | The same summary message sent to your phone. |

## 4. A normal day

**Today** is the first screen. Look at "Needs you" (questions waiting) and "Worth buying now" (or "Best deals" if nothing has that verdict). The four figures at the top are open questions, best estimated profit, bundles found and searches left.

**Deals** lists every bundle. The left list has these views:

- **Worth buying now.** The last scan judged these to clear your minimum profit and ROI, sell fast enough, and look better than before.
- **Missing a price.** A part has no price yet, so there is no estimate. The row says what it still needs.
- **Losing money.** The estimate is below zero.
- **Watchlist.** Bundles you starred. The app tracks them from scan to scan.

There are also All deals, Confirmed, Needs an answer and Waiting for data.

**Sets.** Some rows read "Set · N items" where a model number would be. These are Home Depot's own sets: Home Depot lists exactly which items are inside, so the app never asks you what a set contains. It reads each item's page for its model and price, then looks the items up on Amazon like any other part.

**Sets with other brands' items.** Some DEWALT and RYOBI sets include an item of another brand (a Husky workbench, Everbilt screws). The app prices only DEWALT and RYOBI parts, so such a set is listed under "Other brands' items" with each item and its link, and gets no estimate. It is never a question for you.

**"Needs a look".** After every scan the app checks its own work. A deal gets an amber "Needs a look" tag when something about it does not add up: the Amazon listing's title names a different model, one listing is counted for two different parts, Amazon's price is several times Home Depot's price for the same part, or the estimate is better than any real deal has been. Such a deal is never marked Buy now. Open it, follow the Home Depot and Amazon links, then press **This is right** (the app remembers) or **Wrong listing** (the app drops that listing and looks again).

**Why some bundles are still waiting.** The app reads Home Depot slowly on purpose: a pause of 10 to 15 seconds between pages, 40 pages at most in one scan, and up to 40 an hour between scans while Chrome is open. Discounted bundles are read first. If Home Depot refuses a page, the app stops reading for a while and says when it continues; it never tries to get around that. A first scan can leave many bundles under Waiting for data. They fill in over the next hours without you doing anything.

**Reading one deal.** Click a row. You see the estimated profit and ROI, and what the bundle costs, what the parts sell for and what is left after fees. "Open on Home Depot" opens the bundle's page. Each part links to its Amazon listing. Some bundles show **BOGO choices**: buy the starter and pick one free item. The app lists the choices and marks the best estimate. It never picks one for you. If a part has no price, press **Confirm a price**. Enter a price you have seen and a link. It counts in the estimate until an Amazon New price replaces it.

**Review** holds the questions the app will not guess, such as "which parts are in this bundle". The app looks things up itself first. It only asks when it could not settle it. A card shows:

- the suggestion, with a tag: Verified (the app checked it against the pages), Suggested, not verified, or AI could not tell;
- **Why** it suggests this;
- **Check**: the one thing left for you to look at;
- **Confirmed by Home Depot**: parts whose model and kind Home Depot's own pages confirmed, each with a link.

Press a number to choose an answer, then **Enter** to save. A "Saved" line appears with **Undo** for a few seconds. **Ctrl+Z** does the same. You can also undo from Activity later. A part left unanswered is not counted.

### Recording what you bought and what it made

The app can only say what it expects. To find out whether its estimates can be trusted, tell it what you really did.

- **When you buy a deal**, open it in Deals and press **I bought this…** (or right-click the row). The date is today, the price is the deal's Home Depot price and the quantity is 1; change any of them. The app saves the estimate as it stands at that moment, each part with its Amazon listing, estimated price and fees, and never changes it afterwards. The deal shows **Bought** and is listed under **Deals, Bought**.
- **As each part sells**, open **Deals, Bought** and press **Sold for…** on the part. Enter the date and what one unit sold for. If you know the net payout (what reached you after Amazon's fees), enter it too. If you leave it empty the app takes the sale price less the fees in the estimate saved at purchase and labels it "fees estimated". **Still holding** and **Returned / not sold…** (with any money you got back) are there too. You can change any of them again.
- **Undo.** Each change is a sentence in **Activity**, and the newest one that can still be taken back is also at the top of Bought. Each has **Undo** while nothing later has changed the same purchase; take back the later change first. **Change…** on a purchase corrects its date, price or quantity, or removes the record; that can be undone too.
- **The scorecard** on Today shows the profit you realised this month on parts marked sold (with "N of M parts sold" until a deal is finished), how far the estimates were from what you made on finished deals, how many deals were flagged Buy now against how many you bought, and, under **More detail**, the open questions, how many bundles have a complete estimate and this month's searches and AI spend. With nothing recorded it says "No purchases recorded yet" and shows no dollar figure. A part's share of what you paid is worked out by its estimated net; that is an allocation, not a measurement.
- **Download CSV** on Bought saves one row per part with the saved estimate beside what you recorded. Reset scan data never deletes your purchases; its backup folder includes them, and so does the audit file.

## 5. Leaving it running

Set the schedule in **Settings, Scanning**: only when you press Scan now, every few hours, or once a day. The app scans on its own only while the PC is awake and Split Finder is running. Chrome must be open for Home Depot reads. With Chrome closed, those reads wait and the app tells you. Everything else keeps going.

Searches are limited. A scan stops at **Searches per scan**. A scheduled scan never touches the **Reserve**. Only a scan or lookup you start yourself may use it. Settings shows how many searches the month allows. Between scans, if you have a Keepa key, the app looks up waiting parts as Keepa tokens refill. This costs no searches.

**Autopilot** is off by default. If you turn it on, it saves an AI answer only when the app has checked the answer against the pages and you marked that model as trusted. Each one appears in Activity with Undo. Anything else waits for you in Review.

**Notifications** come after each scan, or once a morning if you choose that (Settings, Notifications). They tell you about new deals above your numbers (default: $20 estimated profit, 20% ROI, 50 sold a month), questions waiting, and what Autopilot did. You can set quiet hours. If Telegram is set up, the same message goes to your phone.

## 6. Money and safety

What costs money:

- **SerpApi.** The free plan is 250 searches a month. A paid plan is your choice.
- **Keepa.** A subscription with Keepa.
- **AI.** You pay the AI service for each question. The app keeps a monthly cap (default $25; 0 turns AI off). Activity and Today show what you have spent.

Your keys are saved only on your computer, in the app's own folder. On Windows they are readable by your Windows account and by this PC's administrators, the same as SSH keys; on a Mac, by your account alone. Each key goes only to its own service. The app never shows a key again after you save it. To remove one, open **Settings, Keys** and press **Remove**. To clear the deals, Review and scan history but keep your keys and settings, open **Settings, Data** and press **Reset scan data…**. The app copies what it deletes into a backup folder first and tells you where. To remove everything, including keys, uninstall the app and delete its data folder (**Settings, Data** shows it; on Windows it is `%APPDATA%\com.bundlesplitfinder.desktop`).

### New versions

Once a day Split Finder looks at the project's public page on GitHub (one plain request that sends nothing about you) to see whether a new version is ready. If one is, you get one message through the channels you have on (a notification, and Telegram if it is set up), and a quiet line near the top of the window: "Split Finder 0.1.1 is ready", with **Download** and **What changed**. Download opens the link in your browser. You run the installer yourself; the app never downloads or installs anything on its own, and it tells you about each version once. **Dismiss** closes the line for that version. If the message says to ask the developer for the link, the link was missing or not allowed, so nothing is offered to open.

To switch it off, open **Settings, General** and turn off "Tell me when a new version is ready" (no request is made then), or **Settings, Notifications** to stop only the message. Activity lists the versions you were told about.

## 7. When something looks wrong

Banners appear near the top. One shows at a time, with "N more" if there are others.

- **"The last scan could not read N Home Depot pages."** Chrome could not load some pages, so those bundles have no estimate yet. Press **Read pages again** (free). Chrome must be open.
- **"The Chrome helper is older than the app."** Press **Reload it**. If nothing changes, open `chrome://extensions` and press Reload on Split Finder.
- **"Chrome is closed."** Open Chrome. Waiting pages are read then.
- **"Chrome is not connected."** Press **Connect Chrome** and repeat step 1 above.
- **"The ... key is not accepted."** The service refused the saved key. Press the button on the banner and paste a new key in Settings, Keys.
- **"Searches are at your reserve."** No scan spends a search then: Amazon lookups wait for Keepa. To look some up now, press **Use searches for these** on Deals; that is the only way the reserve is spent.
- **"The agent is not running."** Open Split Finder from the notification area.

**Activity** shows what happened: errors that need you (some have a retry button), your saved answers, what Autopilot did, and every scan with its searches, Keepa tokens and AI cost. If something is wrong, look there first.

To report a problem, open **Settings, Data** and press **Export audit file**, then send the developer that file. It holds what was scanned, matched and asked and what went wrong, and no keys. A screenshot of the banner and of the matching Activity entry helps too.

## 8. Keyboard shortcuts

Press **Ctrl+/** in the app to see this list.

| Does | Windows | Mac |
| --- | --- | --- |
| Command palette | Ctrl+K | ⌘K |
| Keyboard shortcuts | Ctrl+/ | ⌘/ |
| Search this screen | Ctrl+F | ⌘F |
| Show or hide the inspector | Ctrl+Alt+I | ⌥⌘I |
| Go to Today, Deals, Review, Activity | Ctrl+1, 2, 3, 4 | ⌘1, 2, 3, 4 |
| Open Settings | Ctrl+5 | ⌘5 |
| Scan now | Ctrl+R | ⌘R |
| Next or previous row | J or K (or the arrow keys) | J or K |
| Open the row | Enter | ↩ |
| Choose an answer in Review | 1 to 9 | 1 to 9 |
| Save the answer, or approve the AI's | Enter | ↩ |
| Ask AI about the question | A | A |
| Undo the answer just saved | Ctrl+Z | ⌘Z |
| Close a menu or sheet | Esc | Esc |
