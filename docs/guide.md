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

**Your sales tax and inbound shipping.** The app does not know what sales tax you pay at Home Depot or what it costs you to send stock to Amazon, and it does not guess. Until you say, every profit figure is "before sales tax and inbound shipping", and the line under each list of deals says so. Open **Settings, Scanning**, enter both, or press **It is 0%** / **It is $0** if zero is right. The note then goes away for good. Do this before you trust a deal that is close to your minimum profit.

## 4. A normal day

**Today** is the first screen. Look at "Needs you" (questions waiting) and "Worth buying now" (or "Best deals" if nothing has that verdict). The four figures at the top are open questions, best estimated profit, bundles found and searches left.

**Deals** lists every bundle. The left list has these views:

- **Worth buying now.** Deals that clear your minimum profit and ROI, sell fast enough, leave nothing unsold, have every fee counted and sit on confirmed Amazon listings, with nothing holding them for a look. A deal stays here for as long as all of that holds; the row says how its estimate moved since the last check ("Down from $38.79 at the last check"), but a small drop does not take it off. You are told when a deal first gets here, when it improves by $5 or more over what you were last told, and once when it leaves, with the reason. All profit figures are estimates from your fee settings.
- **Missing a price.** A part has no price yet, so there is no estimate. The row says what it still needs.
- **Losing money.** The estimate is below zero.
- **Watchlist.** Bundles you starred. The app tracks them from scan to scan.

There are also All deals, Confirmed, Needs an answer and Waiting for data.

**Usual prices and the market.** A price can be high for a day. When a part's Amazon price is 20% or more above what its listing averaged over the last 90 days (Keepa's record), the app works the deal out a second time with that part at its 90-day average, with the same fees, and a deal is worth buying now only if it clears your numbers both ways. If it clears them only at today's prices, the row says "Worth buying now at today's prices only: at the 90-day average of $17.47 for PCG002 it is +$8.48 (9% ROI), below your $20 and 20%. Not marked Buy now." A listing too new to have an average says "No price history yet" and is judged at today's price. In the deal's inspector, **Market** under the parts shows each part's counted price beside its 30-, 90- and 180-day averages and when Keepa read them, the second estimate when there is one, and short notes that never hold a deal back by themselves: Amazon sells it itself (hard to win sales against), many more sellers than usual, often out of stock, and a lithium battery ("Lithium battery (UN3480): Amazon treats it as dangerous goods; check it is approved in your FBA account before buying."). These come from the Keepa reads the app already makes; nothing extra is spent.

**Sets.** Some rows read "Set · N items" where a model number would be. These are Home Depot's own sets: Home Depot lists exactly which items are inside, so the app never asks you what a set contains. It reads each item's page for its model and price, then looks the items up on Amazon like any other part.

**Sets with other brands' items.** Some DEWALT and RYOBI sets include an item of another brand (a Husky workbench, Everbilt screws). The app prices only DEWALT and RYOBI parts, so such a set is listed under "Other brands' items" with each item and its link, and gets no estimate. It is never a question for you.

**"Needs a look".** After every scan the app checks its own work. A deal gets an amber "Needs a look" tag when something about it does not add up: the Amazon listing's title names a different model, one listing is counted for two different parts, Amazon's price is several times Home Depot's price for the same part, or the estimate is better than any real deal has been. Such a deal is never marked Buy now. Open it, follow the Home Depot and Amazon links, then press **This is right** (the app remembers) or **Wrong listing** (the app drops that listing and looks again).

**Why some bundles are still waiting.** The app reads Home Depot slowly on purpose: a pause of 10 to 15 seconds between pages, 40 pages at most in one scan, and up to 40 an hour between scans while Chrome is open. Discounted bundles are read first. If Home Depot refuses a page, the app stops reading for a while and says when it continues; it never tries to get around that. A first scan can leave many bundles under Waiting for data. They fill in over the next hours without you doing anything.

**Reading one deal.** Click a row. You see the estimated profit and ROI, and what the bundle costs, what the parts sell for and what is left after fees. "Open on Home Depot" opens the bundle's page. Each part links to its Amazon listing. Some bundles show **BOGO choices**: buy the starter and pick one free item. The app lists the choices and marks the best estimate. It never picks one for you. If a part has no price, press **Confirm a price**. Enter a price you have seen and a link. It counts in the estimate until an Amazon New price replaces it.

**What Home Depot's page says about buying it.** The app keeps what a bundle's own Home Depot page states: whether it can be bought, whether it is discontinued, the limit per order ("Limit 3 per order"), the return window and the last day of its price. "On Home Depot" in the deal's details says so, with when the page was read. A page that says the bundle cannot be bought, or is discontinued, takes the deal out of Buy now ("Not worth buying now: Home Depot's page says it cannot be bought right now (read 10:55 AM)"); the next read that says it can be bought brings it back by itself. A bundle whose page has not been read yet says "not checked yet", which is never treated as "cannot be bought"; the app reads Buy now deals again every 4 hours. Where there is a limit, the details show what it allows ("Up to 3 per order: about +$107 at this estimate", an estimate from your fee settings), and "I bought this" warns when you enter more than the limit. When a Buy now deal's price ends within 3 days the app tells you once ("Home Depot's price ends Jan 31"). After the last day it reads that price again first and does not announce the deal as a buy until it has. The page does not state stock at your store or a delivery date, so the app never says either; it can only say the page says the bundle can be bought online.

**Review** holds the questions the app will not guess, such as "which parts are in this bundle". The app looks things up itself first. It only asks when it could not settle it. A card shows:

- the suggestion, with a tag: Verified (the app checked it against the pages), Suggested, not verified, or AI could not tell;
- **Why** it suggests this;
- **Check**: the one thing left for you to look at;
- **Confirmed by Home Depot**: parts whose model and kind Home Depot's own pages confirmed, each with a link.

Press a number to choose an answer, then **Enter** to save. A "Saved" line appears with **Undo** for a few seconds. **Ctrl+Z** does the same. You can also undo from Activity later. A part left unanswered is not counted.

### Looking at the Home Depot and Amazon pages inside the app

When you click a Home Depot, Amazon, Keepa or eBay link, the page opens in Split Finder's own page window. You do not need to switch to Chrome.

- **The bar at the top** shows Back, Forward and Reload, then which page this is ("Amazon · PCG002"), then the page's address. The website's name is shown in bold. It comes from the page that is really loaded, so a fake page cannot pretend to be Amazon.
- **The other pages of the same deal.** When you open a page from a deal, the button with the page's name (for example "Amazon · PCG002") lists the deal's other pages: the bundle on Home Depot and each part on Amazon. Pick one to go straight to it. The list grows with the number of parts.
- **Copy link** copies the page's address. **Open in browser** opens the same page in your normal browser.
- **To use your browser instead**, hold Ctrl (⌘ on a Mac) while you click the link, or right-click the link and choose **Open in browser**. The right-click menu also has **Copy link address**. To always use your browser, set **Settings, General, Open links** to **In my browser**.
- **You are not signed in here.** This window is not your browser. If a page asks you to sign in or pay, the app does not show it. It says "Sign in only in your browser" and offers **Open in browser**. Do not type a password into this window. Seller Central, the key sign-up pages and downloads always open in your browser.
- **If a page does not load**, the window says so and offers **Try again** and **Open in browser**. Sometimes Home Depot or Amazon shows its own "something went wrong" or "access denied" page here. The app shows that page as it is and does not try to get around it. Use **Open in browser**.
- **Clear viewer browsing data** (Settings, Data) clears the cookies and history of this window. Your own browser is not touched.
- **Pictures.** Deals, Today and a deal's details show the Amazon photo the app stored for a part. A grey square means no photo is stored. The app never guesses one. To turn the photos off, use **Settings, General, Show product pictures**.

### Recording what you bought and what it made

The app can only say what it expects. To find out whether its estimates can be trusted, tell it what you really did.

- **When you buy a deal**, open it in Deals and press **I bought this…** (or right-click the row). The date is today, the price is the deal's Home Depot price and the quantity is 1; change any of them. The app saves the estimate as it stands at that moment, each part with its Amazon listing, estimated price and fees, and never changes it afterwards. The deal shows **Bought** and is listed under **Deals, Bought**.
- **As each part sells**, open **Deals, Bought** and press **Sold for…** on the part. Enter the date and what one unit sold for. If you know the net payout (what reached you after Amazon's fees), enter it too. If you leave it empty the app takes the sale price less the fees in the estimate saved at purchase and labels it "fees estimated". **Still holding** and **Returned / not sold…** (with any money you got back) are there too. You can change any of them again.
- **Undo.** Each change is a sentence in **Activity**, and the newest one that can still be taken back is also at the top of Bought. Each has **Undo** while nothing later has changed the same purchase; take back the later change first. **Change…** on a purchase corrects its date, price or quantity, or removes the record; that can be undone too.
- **The scorecard** on Today shows the profit you realised this month on parts marked sold (with "N of M parts sold" until a deal is finished), how far the estimates were from what you made on finished deals, how many deals were flagged Buy now against how many you bought, and, under **More detail**, the open questions, how many bundles have a complete estimate and this month's searches and AI spend. With nothing recorded it says "No purchases recorded yet" and shows no dollar figure. A part's share of what you paid is worked out by its estimated net; that is an allocation, not a measurement.
- **Download CSV** on Bought saves one row per part with the saved estimate beside what you recorded. Reset scan data never deletes your purchases; its backup folder includes them, and so does the audit file.

## 5. Leaving it running

Set the schedule in **Settings, Scanning**: only when you press Scan now, every few hours, or once a day. The app scans on its own only while the PC is awake and Split Finder is running. Chrome must be open for Home Depot reads. With Chrome closed, those reads wait and the app tells you. Everything else keeps going.

A daily 7:00 scan that runs without you needs three things, and the app takes care of two of them:

- **Chrome.** With a schedule set, a few minutes before a scan the app starts your own Chrome in the background (your profile, nothing hidden, no window brought forward) and waits four minutes for the Split Finder helper to connect. It does the same once a day if Home Depot pages have waited an hour with Chrome closed. If Chrome does not open, the scan runs without Home Depot pages and its summary says "Chrome did not open, so Home Depot pages wait." The app never closes a Chrome you opened. A Chrome it opened stays open unless you tick **Close it again after the scan** in Settings, Scanning. Turn the whole thing off with **Open Chrome for scheduled scans**. Today, Next scan says what the scan depends on while Chrome is closed.
- **Open at login.** The first time you have a schedule, the app turns on Open at login (a note with **Turn off** appears, and Activity says so). Turn it off and it stays off.
- **An awake computer.** Nothing in the app can wake a sleeping PC or Mac, and it does not touch your power settings. If the computer was asleep at 7:00, or Split Finder was not running, the scan runs once when the app is back, and its summary says so: "The 7:00 AM scan ran at 9:12 AM because the computer was asleep." While a scan runs the computer is kept awake (Settings, General).

Once a week (default Monday 8:00; Settings, Notifications) you get one summary: new deals and how many were worth buying now, what you recorded as bought, profit realised, how the estimates compare with what you recorded, open questions, what the week cost by service and whether the month is inside its limits, and anything held back. Dollar figures say whether they are estimates or recorded. It is a short notification on the computer and the full text on Telegram. Turn it off with "Your weekly summary" in the same place.

Searches are limited. A scan stops at **Searches per scan**. A scheduled scan never touches the **Reserve**. Only a scan or lookup you start yourself may use it. Settings shows how many searches the month allows. Between scans, if you have a Keepa key, the app looks up waiting parts as Keepa tokens refill. This costs no searches.

**Autopilot** is off by default. If you turn it on, it saves an AI answer only when the app has checked the answer against the pages and you marked that model as trusted. Each one appears in Activity with Undo. Anything else waits for you in Review.

**Notifications** come after each scan, or once a morning if you choose that (Settings, Notifications). They tell you about new deals above your numbers (default: $20 estimated profit, 20% ROI, 50 sold a month), questions waiting, and what Autopilot did. You can set quiet hours. If Telegram is set up, the same message goes to your phone.

## 6. Money and safety

What costs money:

- **SerpApi.** The free plan is 250 searches a month. A paid plan is your choice.
- **Keepa.** A subscription with Keepa.
- **AI.** You pay the AI service for each question. The app keeps a monthly cap (default $25; 0 turns AI off). Activity and Today show what you have spent.

### What it costs

Open **Costs** (sidebar, under Activity; **⌘6** or **Ctrl+6**) to see what the services cost, this month and by its end, and to set what you allow.

- **The answer is the first line:** what you have spent so far, what is expected by the end of the month with its range, and whether that stays inside your total budget. A forecast is an estimate from your own use, not a bill.
- **A price you have not entered is never counted as $0.** The app does not know what you pay SerpApi or Keepa. Until you type it in, that service says "price not entered" and is left out of the dollar totals; the first line says so and has the field.
- **The chart** shows dollars each day so far (solid line), the forecast to the month's end (dashed, its range shaded) and your total budget (a rule). Hover it, or click it and use the arrow keys, to see one day by service. **Show the numbers** gives the same figures as a table.
- **Each service** has a row: its state in words, how much of its limit it has used (a mark shows where your warning starts), the forecast in its own unit, what it costs, and anything held back, with what, why and when.
- **Limits.** Each service has a slider with a number beside it; either one sets the limit. **No limit** is its own checkbox. Set a limit below what is already used and the row says so. Changes save as you make them; the line above Services says what changed and has **Undo**.
- **Hold back anything expected to pass a limit** (on by default): a step that would take a service past its limit does not run, and a notice says so. Turn it off and you are only warned.
- A warning (nearing a limit, expected to pass it, reached, or something held back) also appears as a banner on the other screens, with **Open Costs**.

### More than one SerpApi or Keepa key

If one month's searches are not enough, you can add a key from another account, for example your partner's or a paid plan. Open **Settings, Keys** and press **Add another key** under SerpApi (or Keepa). Paste the key, give it a name if you like (otherwise it is "Key 2"), and press **Save**. The app checks it at once, for free.

- **The app adds them up.** Searches left, the month's allowance and Keepa's tokens are the totals of all your keys. Today, Settings and Costs show the total first and each key's share under it ("Key 1 60 · Partner 143").
- **Your settings stay one number.** The **Reserve** and **Searches per scan** apply to the total, exactly as before. A scheduled scan still never touches the reserve.
- **Each search uses one key:** the one with the most searches left that is not at its hourly limit. If SerpApi refuses that key during a search, the same search goes once to your next key; it is never sent twice to the same key, and you are only charged for the search that worked.
- **One refused key does not stop a scan.** The others carry on, and a banner names the key ("SerpApi Key 2 is not accepted") with a button to **Settings, Keys**. Only when every key is refused does the scan stop, as it did with one key.
- **Each key has its own line** in Settings, Keys: its name, when you added it, and what its service said ("Accepted, 143 of 250 searches left this month"). **Rename**, **Check again** and **Remove** work on that key alone.
- **Costs** shows each service's totals with one line per key underneath. Type what you pay for the service in total, for all keys together, in its **Monthly price**.
- **The AI keys, eBay, Telegram and your Amazon seller account stay one each.** The AI is capped in dollars across your account, and the others are one identity each.

You are responsible for keeping to each account's terms with its provider.

Your keys are saved only on your computer, in the app's own folder. On Windows they are readable by your Windows account and by this PC's administrators, the same as SSH keys; on a Mac, by your account alone. Each key goes only to its own service. The app never shows a key again after you save it. To remove one, open **Settings, Keys** and press **Remove**. To clear the deals, Review and scan history but keep your keys and settings, open **Settings, Data** and press **Reset scan data…**. The app copies what it deletes into a backup folder first and tells you where. To remove everything, including keys, uninstall the app and delete its data folder (**Settings, Data** shows it; on Windows it is `%APPDATA%\com.bundlesplitfinder.desktop`).

### Connecting your Amazon seller account

Before you buy, the app can ask Amazon itself, from your own seller account, whether you may list each part, whether FBA
will take it, and what Amazon's fees would be for you. It only reads: nothing is ever listed, changed or ordered. US
marketplace only for now.

1. Sign in to Seller Central as the Primary User of your professional account.
2. Open **Apps and Services**, then **Develop Apps**, and register as a private developer. Choose private data access and
   the roles **Product Listing** and **Amazon Fulfillment** (also **Inventory and Order Tracking**, for sales later). If
   Amazon opens a case about it, answer within 5 days.
3. Add an app client for yourself. Under its LWA credentials, **View** shows the **client id** and the **client secret**.
4. Choose **Authorize app** for it. Amazon shows a **refresh token**. Each click makes a new one; earlier ones keep working.
5. Your **seller id** is probably in Seller Central under **Account Info**, called **Merchant Token**. Amazon's developer
   pages do not say where it is shown; if it is not there, ask Seller Support for your merchant token.
6. In Split Finder open **Settings, Keys**, find **Amazon seller account**, paste the four, and press **Save**. The app
   signs in and checks one listing; the line under the key says whether it worked, in Amazon's words if not.

After that, each part of a deal that is worth buying (or close to it, or watched) shows one line in the deal: "You may
list it. FBA accepts it. Amazon's fees: $12.41." A deal is worth buying now only if you may list every part and FBA takes
every part. If Amazon says you need approval, the line says so with **Apply**, which opens Seller Central. If FBA will not
take a part (a battery waiting for its dangerous goods review, for example) and you ship that part yourself, press **I ship
it myself** on it. The app checks each part again after a week, and again just before it first tells you about a deal.
Amazon's fee estimate then replaces Keepa's in the estimate, and the line under the figures says "Amazon's fee estimate for
your account, read" and the day. It is still an estimate. These checks are free; Costs counts them.

Without an account connected nothing changes, except that a deal worth buying says it was not checked against your Amazon
account.

### Updates

Split Finder keeps itself up to date. You do not need to download anything.

- A minute after it opens, and then every 6 hours, it looks at the project's page on GitHub for a new version. The look sends nothing about you.
- When there is one, it downloads it in the background and checks that it really comes from the developer (every version carries his signature; one that does not is thrown away).
- It installs only when nothing is running: never during a scan, and not in the 15 minutes before a scheduled scan. Split Finder closes for about a minute and opens again by itself. On Windows a small progress window may show while it installs.
- Afterwards a quiet line near the top of the window says "Split Finder was updated to 0.2.1", with **What changed**. **Dismiss** closes it.
- Your deals, answers, keys and settings stay exactly as they were. An update never touches them.

If you would rather choose the moment yourself, open **Settings, General** and turn off "Install new versions automatically". Then you get one message (a notification, and Telegram if it is set up) and a quiet line: "Version 0.2.1 is ready", with **Install now**. Press it when you like; it still waits until nothing is running. Settings, General also shows which version you have and when it last looked.

Turning off "Look for new versions" stops the looking altogether: no request is made and nothing is installed.

If an update cannot be downloaded or does not install, Split Finder keeps running the version you have, writes one line in **Activity**, and tries again 6 hours later. You do not need to do anything.

**If you have version 0.1.0.** That first version cannot update itself. It shows a quiet line "Split Finder 0.2.0 is ready" with **Download**. Download the installer, open it and let it install over the old one, as you did the first time. If it offers to remove the old version first, that is fine; if a box says "Delete the application data", leave it unticked. Your data and keys are kept. From then on updates come by themselves.

### Setting up Telegram when you are away from the computer

Normally you paste the bot's token and chat id in Settings, Keys. If you are not at the computer but it is on, with Split Finder open and iCloud Drive turned on:

1. In Telegram, create the bot with @BotFather (`/newbot`), then open your bot, press Start and send it any message.
2. On your iPhone, copy the token BotFather gave you. In the Files app, under iCloud Drive, make a text file named `telegram.txt` and paste the token into it.
3. On the computer (or from a remote session on it) run `npm run telegram:setup` in the project folder.

The command reads the token from that file, asks Telegram which chat wrote to your bot, saves both in Split Finder, sends the test message, and removes the file. It never prints the token. Afterwards, empty Recently Deleted in Files on your phone.

### Finding your Telegram chat without typing its id

In **Settings, Keys**, paste only the bot's token and leave the chat id empty. Then open your bot in Telegram, press Start and send it any message. Within a few seconds Keys shows "Use the chat with <your name>?" Press **Use this chat** only if the name is yours: anyone who finds the bot could write to it too, so the app never picks a chat by itself, and if more than one chat wrote, it lists them all. Once you choose, it saves the chat and sends the test message.

### Acting from Telegram

Turn on **Let me act from Telegram** in **Settings, Notifications** (off until you do). Then the messages carry buttons:

- A deal worth buying now: **I bought this** (it asks once more, "Record 1 bought at $99.00 today?", then records it as the app does, with the estimate kept as it stood, and offers **Undo**), **Not for me** (you stop watching it, so it is not announced again) and **Open Home Depot**.
- A new Review question with up to four choices: a button per choice, the AI's suggestion marked, and **Skip**. With more choices it says to answer in the app. Typing a reply never answers a question.
- A cost warning: **Open Costs** only. Limits change only in the app.
- A scan's summary: **Pause scans** or **Resume**, and **Scan now**. A scan never spends your reserve; when searches are above it, the phone says how many it may spend and waits for your yes.

You can also send `/status` (deals worth buying now, open questions, searches left, this month's costs and the next scan), `/pause`, `/resume` and `/help`. Only your own chat with the bot is listened to. Keys, limits, budgets, the reserve and settings cannot be changed from the phone. Everything done there is in Activity, marked "from Telegram", with the same Undo as in the app. A button works once and stops working after two days.

## 7. When something looks wrong

Banners appear near the top. One shows at a time, with "N more" if there are others.

- **"58 sets are waiting for 105 Home Depot pages. The app is reading them: about 20 an hour today; next at 10:54 AM."** A quiet line, no button: the app reads the pages by itself, slowly, whenever Chrome is open, and the count is live. It says "Home Depot paused reading until ..." after Home Depot refused a page. Only when reading cannot go on (the app is paused) does it become a banner, with **Resume**. If Chrome is closed, the Chrome notice says so instead.
- **"The Chrome helper is being updated."** After an app update the app puts the new helper files in the helper folder and asks Chrome to reload it. Nothing to do.
- **"The Chrome helper is older than the app."** The app could not update it (it does not know which folder Chrome loaded it from, or the folder is not the helper's), or Chrome still runs the old one afterwards. The banner says which. Press **Install the helper again**; if the banner then says a folder, choose that folder with Load unpacked in `chrome://extensions` once.
- **"Chrome is closed."** Open Chrome. Waiting pages are read then.
- **"Chrome is not connected."** Press **Connect Chrome** and repeat step 1 above.
- **"The ... key is not accepted."** The service refused the saved key. Press the button on the banner and paste a new key in Settings, Keys.
- **"Searches are at your reserve."** No scan spends a search then: Amazon lookups wait for Keepa. To look some up now, press **Use searches for these** on Deals; that is the only way the reserve is spent.
- **"The agent stopped unexpectedly and is being restarted."** Wait: the app starts its background agent again by itself (at once, then after 2 seconds, 10 seconds and a minute). Activity then says when it stopped and what became of a scan that was running; **Scan again** continues that scan from its last saved step.
- **"The agent keeps stopping."** It stopped more than 5 times in 10 minutes, so the app stopped restarting it. Press **Exit and open again** (Mac: **Quit and open again**). If it stops again, send the audit file (below).

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
| Go to Costs | Ctrl+6 | ⌘6 |
| Scan now | Ctrl+R | ⌘R |
| Next or previous row | J or K (or the arrow keys) | J or K |
| Open the row | Enter | ↩ |
| Choose an answer in Review | 1 to 9 | 1 to 9 |
| Save the answer, or approve the AI's | Enter | ↩ |
| Ask AI about the question | A | A |
| Undo the answer just saved | Ctrl+Z | ⌘Z |
| Close a menu or sheet | Esc | Esc |
| Page window: close it | Ctrl+W or Esc | ⌘W or Esc |
| Page window: reload | Ctrl+R or F5 | ⌘R |
| Page window: back, forward | Ctrl+[ and Ctrl+] (or Alt+Left, Alt+Right) | ⌘[ and ⌘] |
| Page window: copy the link | Ctrl+Shift+C | ⇧⌘C |

On Windows the page window's keys work when the bar at the top has the focus: click the bar first if they do nothing.
