# Install Split Finder

**Lane D (app-first):** The native **Split Finder** app (macOS `.app` / Windows installer) is the main UI. Install the app first; use it to install the **Split Finder Helper** Chrome extension for Home Depot reads and background scans. You can still load the extension alone without the app (steps below), but keys and settings should live in the app when the helper is synced.

Split Finder finds discounted DEWALT and RYOBI bundles on Home Depot, splits each bundle into its parts, matches every part to its Amazon listing and ranks the bundles by estimated profit. It uses your own SerpApi key.

## 0. Install the native app (Lane D)

1. Build or download **Split Finder** for your platform (`npm run desktop:build` from the repo).
2. Open the app. Use **Home** to install the helper folder, then **Settings** for your SerpApi key (and optional Keepa, eBay, Anthropic keys).
3. Load the helper in Chrome (step 1 below). The app and helper sync on localhost.

When the app is the main UI, you do not need Chrome Settings for keys — only the helper for Home Depot page reads and background scans.

## 1. Load it in Chrome

1. Unzip `bundle-split-finder-<version>-chrome.zip` to a folder you will keep, for example `Documents/split-finder`. Chrome reads the extension from that folder, so do not delete it.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the unzipped folder.

Split Finder now appears in the extensions list. Pin it from the puzzle-piece menu if you like. Clicking its button opens the side panel.

## 2. Add your SerpApi key

Every Home Depot results page and every Amazon lookup comes from SerpApi, a paid search service. The free plan gives 250 searches a month and 50 an hour.

1. Create an account at [serpapi.com/users/sign_up](https://serpapi.com/users/sign_up).
2. On the dashboard, copy the API key.
3. **With the app (recommended):** open **Settings** in Split Finder.app, paste **SerpApi key**, click **Check key**, then **Save settings**. The helper syncs the key within a minute.
4. **Extension only:** in the helper side panel, open Settings, paste the key, and click **Check key**.

The key is stored on your Mac in app data (or in the browser when extension-only) and is sent only to serpapi.com.

## 3. Optional keys

The scan runs with only the SerpApi key. The two keys below add eBay sold prices and Ask AI. Skip them and Deals will say that eBay was skipped.

**eBay, for a reference price.** This is what New units of a part have sold for. It is not counted in the profit estimate. eBay prices also need the Anthropic key, because a model checks that each listing is the part, New, with the same contents.

1. Sign in at [developer.ebay.com](https://developer.ebay.com).
2. Open [your keys](https://developer.ebay.com/my/keys).
3. Copy the **Production** keyset, not Sandbox. The App ID is also called Client ID. The Cert ID is also called Client Secret.
4. In Settings, under **eBay reference values**, paste both and click **Check eBay keys**. They are saved only when eBay accepts them.

The keys are stored in this browser only and are sent only to api.ebay.com.

**Anthropic, for the listing check and Ask AI.** Ask AI drafts an answer to a Review question. Nothing is saved until you approve it.

1. Create an account at [console.anthropic.com](https://console.anthropic.com).
2. Open **API keys** and create a key.
3. In Settings, under **Listing check**, paste it and click **Add key**.

The key is not checked on save, because a check would cost money. A wrong key shows up the first time a listing is judged. Calls are billed to your Anthropic account. The key is stored in this browser only and is sent only to api.anthropic.com.

## 4. What a search is

A search is one request to SerpApi: one page of Home Depot results, or one Amazon lookup for one part. Your plan counts searches, so the panel shows the cost on every button that spends them.

**Scan now** reads the Home Depot deals pages and looks up the parts. It spends at most **Searches per scan** (Settings, under Scanning), and keeps the reserve you set there untouched. Click **Stop** to end a scan early.

## 5. A first scan

Settings, under **Scanning**, starts at 5 searches per scan, with 100 searches held in reserve. Leave those until you have seen one scan. Click **Scan now**. **Stop** ends it early.

Open **Review** and answer the questions. A part left there counts at $0, which pulls the estimate down. A part with no Amazon listing has **Confirm sell price**: type a price you have seen and a link. An eBay or Facebook link is enough. The page is not scraped.

A red ROI where a part still says it counts at $0 is unfinished. A red ROI where every part has an Amazon New price is a loss under the fee settings.

## 6. The side panel

- **Deals** lists the bundles in sections, such as Confirmed and Waiting for an Amazon lookup. Sort by Profit, ROI or Discount. Click a row for its Detail.
- **Review** holds the questions the tool will not guess, for example which model a kit contains, or whether an Amazon listing is the right part. Answer one at a time, or use **Accept all** for the split questions that offer only one reading. Questions with a real choice, and ones that come from a Home Depot page, you answer one by one.
- **Detail** shows the estimate for one bundle: ways to sell it (whole, or split into its parts), each part with its Amazon listing, and **Copy ASINs**. **Look up** finds the Amazon listing for parts that have none yet and shows its cost first. **Verify** checks a listing that was matched by title only. Every price and match has a link to its Home Depot or Amazon page.
- **Download CSV** saves all bundles with their figures to a file you can open in a spreadsheet.

## 7. On Home Depot product pages

On a bundle's product page a small chip appears under the price: how many parts it splits into, the estimated profit and ROI. Click it to open the **This page** tab in the side panel. If the parts have no prices yet, the chip says how many searches a lookup would cost; the lookup itself is the **Look up** button in the bundle's Detail. Reading the page costs no search. You can turn the chip off in Settings (Alerts).

## 8. What "Est. profit" means

Profit is an estimate. It is worked out from the fee settings in Settings (referral fee, fulfillment per unit, sales tax on purchases and inbound cost per bundle), not from your real Amazon fees. Change the settings to match your account and the figures follow.

## 9. Your data

Everything, including the keys, the deals, your answers and your settings, stays in this browser. Searches go to serpapi.com. eBay keys go only to api.ebay.com, and the Anthropic key goes only to api.anthropic.com. The Your data section in Settings exports the deals as CSV and your matches and answers as a file. Clear saved searches deletes the saved search results, so the next scan spends searches again. Delete all data deletes the deals, matches, answers, confirmed prices and saved searches. The keys, the settings and the searches already counted stay.

## Updating

Unzip the new version over the same folder, then click the reload button on the Split Finder card in `chrome://extensions`. Your settings and data stay. Do not remove the extension to update it: removing it deletes its saved data, so export your matches and answers first if you do.
