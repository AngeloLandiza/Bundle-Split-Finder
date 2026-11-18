# Install Split Finder

Split Finder is a Chrome extension. It finds discounted DEWALT and RYOBI bundles on Home Depot, splits each bundle into its parts, matches every part to its Amazon listing and ranks the bundles by estimated profit. It uses your own SerpApi key and keeps everything in your browser.

## 1. Load it in Chrome

1. Unzip `bundle-split-finder-<version>-chrome.zip` to a folder you will keep, for example `Documents/split-finder`. Chrome reads the extension from that folder, so do not delete it.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the unzipped folder.

Split Finder now appears in the extensions list. Pin it from the puzzle-piece menu if you like. Clicking its button opens the side panel.

## 2. Add your SerpApi key

Every price comes from SerpApi, a paid search service with a free plan.

1. Make an account at serpapi.com. The free plan gives 250 searches a month.
2. Copy your API key from your SerpApi dashboard.
3. In Split Finder, open Settings (the settings button in the side panel).
4. Paste the key into **SerpApi key** and click **Check key**. It shows your plan and how many searches you have left.

The key is stored in this browser only and is sent only to serpapi.com.

## 3. What a search is

A search is one request to SerpApi: one page of Home Depot results, or one Amazon lookup for one part. Your plan counts searches, so the panel shows the cost on every button that spends them.

**Scan now** reads the Home Depot deals pages and looks up the parts. It spends at most **Searches per scan** (Settings, under Scanning), and keeps the reserve you set there untouched. Click **Stop** to end a scan early.

## 4. The side panel

- **Deals** lists the bundles in sections, such as Confirmed and Waiting for an Amazon lookup. Sort by Profit, ROI or Discount. Click a row for its Detail.
- **Review** holds the questions the tool will not guess, for example which model a kit contains, or whether an Amazon listing is the right part. Answer one at a time, or use **Accept all** for the split questions that offer only one reading. Questions with a real choice, and ones that come from a Home Depot page, you answer one by one.
- **Detail** shows the estimate for one bundle: ways to sell it (whole, or split into its parts), each part with its Amazon listing, and **Copy ASINs**. **Look up** finds the Amazon listing for parts that have none yet and shows its cost first. **Verify** checks a listing that was matched by title only. Every price and match has a link to its Home Depot or Amazon page.
- **Download CSV** saves all bundles with their figures to a file you can open in a spreadsheet.

## 5. On Home Depot product pages

On a bundle's product page a small chip appears under the price: how many parts it splits into, the estimated profit and ROI. Click it to open the **This page** tab in the side panel. If the parts have no prices yet, the chip says how many searches a lookup would cost; the lookup itself is the **Look up** button in the bundle's Detail. Reading the page costs no search. You can turn the chip off in Settings (Alerts).

## 6. What "Est. profit" means

Profit is an estimate. It is worked out from the fee settings in Settings (referral fee, fulfillment per unit, sales tax on purchases and inbound cost per bundle), not from your real Amazon fees. Change the settings to match your account and the figures follow.

## 7. Your data

Everything, including the key, the deals, your answers and your settings, stays in this browser. Nothing goes to any server except the searches sent to serpapi.com. The Your data section in Settings exports the deals as CSV and your matches and answers as a file, and can clear the saved search results (the next scan then spends searches again).

## Updating

Unzip the new version over the same folder, then click the reload button on the Split Finder card in `chrome://extensions`. Your settings and data stay. Do not remove the extension to update it: removing it deletes its saved data, so export your matches and answers first if you do.
