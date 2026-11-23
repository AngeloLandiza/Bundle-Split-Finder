# Bundle Split Finder

Finds discounted DEWALT and RYOBI bundles on Home Depot, splits each bundle into parts,
matches them to Amazon listings, and ranks bundles by estimated profit.

**Lane D (app-first, in repo):** The native **Split Finder** app is the main UI; Chrome runs a thin
**Split Finder Helper** for Home Depot page reads and background sync. Start with
[`docs/install.md`](docs/install.md) §0 (app + helper). The extension-only path below
remains for development and for users who have not installed the app yet.

## Native app (recommended path)

1. `npm run desktop:build` (or use a packaged `.app` / installer).
2. Open **Split Finder**, complete **Home**, paste your SerpApi key in **Settings**.
3. Install and load the helper in Chrome — see [`docs/install.md`](docs/install.md).

## Chrome extension only (legacy / dev)

## Setup

### 1. Install the extension

1. Unzip `output/bundle-split-finder-0.1.0-chrome.zip` (from `npm run package`) to a folder
   you will keep, for example `Documents/split-finder`. Chrome reads the extension from that
   folder, so do not delete it.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the unzipped folder.
5. Pin Split Finder from the puzzle-piece menu. Clicking its button opens the side panel.

To update, unzip the new zip over that same folder and click the reload button on the Split
Finder card. Do not remove the extension: removing it deletes its saved data.

### 2. SerpApi key (required)

Every Home Depot results page and every Amazon lookup is one SerpApi search. The free plan
is 250 searches a month and 50 an hour.

1. Create an account at [serpapi.com/users/sign_up](https://serpapi.com/users/sign_up).
2. On the dashboard, copy the API key.
3. In the side panel, open Settings.
4. Paste the key under **SerpApi key** and click **Check key**. It shows the plan and how
   many searches are left.

The key is stored in this browser only and is sent only to serpapi.com.

### 3. eBay keys (optional)

eBay shows what New units of a part have sold for. That figure is a reference. It is not
counted in the profit estimate. Skip this and the scan still runs. The Deals list will say
that eBay was skipped.

eBay prices also need the Anthropic key in the next step. The scan asks a model to check
that each listing is the part, New, with the same contents.

1. Sign in at [developer.ebay.com](https://developer.ebay.com).
2. Open [your keys](https://developer.ebay.com/my/keys).
3. Copy the **Production** keyset, not Sandbox. The App ID is also called Client ID. The
   Cert ID is also called Client Secret.
4. In Settings, under **eBay reference values**, paste both and click **Check eBay keys**.
   They are saved only when eBay accepts them.

The keys are stored in this browser only and are sent only to api.ebay.com.

### 4. Anthropic key (optional)

This key does two things: it lets the scan check eBay listings, and it turns on **Ask AI**
in Review. A suggestion is a draft. Nothing is saved until you approve it.

1. Create an account at [console.anthropic.com](https://console.anthropic.com).
2. Open **API keys** and create a key.
3. In Settings, under **Listing check**, paste it and click **Add key**.

The key is not checked on save, because a check would cost money. A wrong key shows up the
first time a listing is judged. Calls are billed to the Anthropic account. The key is stored
in this browser only and is sent only to api.anthropic.com.

### 5. First scan

Settings, under **Scanning**, starts at 5 searches per scan, with 100 searches held in
reserve. Leave those until you have seen one scan. Click **Scan now**. **Stop** ends it early.

Then:

- **Review** holds the questions the tool will not guess. Answer them. A part left there
  counts at $0, which pulls the estimate down.
- A part with no Amazon listing has **Confirm sell price**. Type a price you have seen and
  a link. An eBay or Facebook link is enough. The page is not scraped.
- A red ROI where a part still says it counts at $0 is unfinished. A red ROI where every
  part has an Amazon New price is a loss under the fee settings.
- Profit is an estimate from Settings, under **Fees** (referral fee, fulfillment, sales tax,
  inbound cost), not from the seller's real Amazon fees.

## Working in this repo

```
npm install
npm run typecheck
npm test                 # no network
cp .env.example .env     # then paste a SerpApi key; never commit .env
npm run budget           # free: what the account has, and what may be spent
npm run keepa:budget     # free from cache: Keepa tokens left (add KEEPA_API_KEY to .env)
npm run keepa:measure    # free: tokens/part vs SerpApi on fixtures
npm run scan -- --fixtures
npm run package          # output/bundle-split-finder-<version>-chrome.zip
npm run vm:bundle        # output/split-finder-vm-kit.zip for a Windows VM (see docs/windows-vm.md)
npm run desktop:dev      # native agent shell + dashboard (needs Rust: docs/desktop-app.md)
npm run desktop:build    # macOS .dmg / Windows .exe + bundled extension zip
```

Nothing may call serpapi.com except through `SerpApiClient`. Before a command that can spend
searches, run `npm run budget`.

| Read | For |
| --- | --- |
| `docs/install.md` | The same setup, as the one-page guide to send with the zip |
| `docs/superpowers/plans/2026-11-22-keepa-agent-discovery-tracking.md` | Keepa, discovery/tracking scale, both combination scopes, agent alerts (planned) |
| `docs/v1-plan.md` | Scope, architecture, scan flow, acceptance criteria |
| `docs/search-budget.md` | How searches are counted and how the free 250 are spent |
| `docs/design.md` | The extension's design |
| `docs/decisions.md` | Choices the code alone does not explain |
| `CLAUDE.md` | Rules for any agent working in this repo |
