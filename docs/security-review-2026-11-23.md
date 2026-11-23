# Security review of the desktop agent, Nov 23 2026

Scope: everything added since the step 13 review (docs/decisions.md, "Step 13 security fix round"), and a fresh pass over the
surface it rests on. Base `fcda48a`. The agent is a Node HTTP server on 127.0.0.1:8790 that holds the owner's keys,
spends his money, drives his Chrome through the paired extension, and is about to run on the PO's Windows PC.

Read: `agent/http.ts`, `auth.ts`, `app.ts` (every route and its role), `store.ts`, `winAcl.ts`, `workerJobs.ts`,
`events.ts`, `uiStatic.ts`, `setup.ts`, `server.ts`, `remoteReaders.ts`, `verifyMatches.ts`, `followUp.ts`, `brief.ts`,
`alerts.ts`, the key paths of `work.ts`; `src-tauri/src/*.rs`, `tauri.conf.json`, `capabilities/*.json`;
`extension/lib/agentJobs.ts`, `researchTools.ts`, `hdReader.ts` (URL building), `sender.ts`, `background.ts` (message
gate), `wxt.config.ts` (permissions); `core/src/ai`, `core/src/research/prompt.ts`, `core/src/brief/ground.ts`,
`core/src/scan/csv.ts`, `core/src/scan/confirmed.ts`, `core/src/tracking/bogo*.ts`, `core/src/ebay/client.ts`;
desktop-ui link rendering and the token reader.

Nothing was spent: no SerpApi, Keepa or model call, no network beyond the tests' own loopback listener.

## Critical

None found.

## Important

### I1. eBay's error text could keep the first part of a key (fixed, `3432432`)

`core/src/ebay/client.ts:129` (`answered`). eBay's `error_description` was cut to 200 characters and only then were the
App ID and Cert ID taken out. A key that straddled the cut no longer matched, so its first half stayed. The Basic
credential (`base64(appId:certId)`) was never taken out at all.

*Failure:* eBay answers a 401 with a long description that ends by echoing the credential it was sent. The sentence
becomes `keyProblems.ebay` (work.ts `notedEbayKeys`). From there it goes to `runtime.json` (0644), `GET /api/state`, the
event stream that the paired extension also reads, and the Keys pane. Part of the Cert ID is now outside `keys.json`
(rule 3). Since step 15 the sentence is passed through to `keyProblems`, which is what makes this reachable.

*Fix:* take the keys and the Basic credential out first, then cut. Test: `agent/test/ebayKeys.test.ts`, "keeps no part of
a key that falls across the length limit, nor the Basic credential".

## Minor

### M1. CSV cells starting with a tab or carriage return (fixed, `24a76eb`)

`core/src/scan/csv.ts:25`. `= + - @` were made inert, but a tab or CR followed by a formula was not, and spreadsheets
skip those before they read a formula. *Failure:* a Home Depot title read as `\t=HYPERLINK(...)` runs as a formula when
the owner opens the export. *Fix:* the guard is now OWASP's full list. Test: `core/test/csv-injection.test.ts`, which
also checks a `=cmd|' /C calc'!A0` cell.

### M2. The agent queued worker jobs the helper would refuse (fixed, `0696b6a`)

`agent/app.ts:136-180`. `POST /api/worker/jobs` (app token only) took any text of up to 32 characters as an item id, and
an object became `"[object Object]"`. It also took any search page. The helper re-checks every input
(`extension/lib/agentJobs.ts`: digits, at most 12; search page 1; the BOGO listing regex), so no address outside Home
Depot's `/p/<digits>`, `/s/<encoded query>` and the one Featured BOGO listing could be fetched. *Failure:* junk sat in
the queue and failed only in Chrome. *Fix:* the agent applies the helper's checks and answers 400. Test:
`agent/test/securityAttacks.test.ts`, "malformed or oversized worker job input".

### M3. Two links put in `href` as stored (fixed, `a26f80e`)

`desktop-ui/src/components/BogoSheet.tsx:108` and `ConfirmPriceSheet.tsx:155`. Every other link went through `webUrl`
or `openPage`, each its own copy, and neither copy refused a user name in the address. These two links are already
limited to http(s) where they come in (`core/src/tracking/bogo.ts` `freeItemOf`, `core/src/scan/confirmed.ts`
`webLink`). React 19 blocks `javascript:` in `href`, and the CSP has no `'unsafe-inline'` for scripts. *Failure:* none
today; the risk was a later source of links skipping all three. *Fix:* one check, `desktop-ui/src/lib/webUrl.ts`: http
or https, no user or password (`https://www.homedepot.com@evil.example` is refused). Every link and `openPage` uses it.
Test: `desktop-ui/src/lib/webUrl.test.ts` (`javascript:`, mixed case, a tab inside the scheme, `data:`, `vbscript:`,
`file:`, UNC paths, `ms-settings:`, user-name tricks).

The links are not narrowed to Home Depot, Amazon and eBay hosts. The owner may type a confirmed-price link to any shop,
so that limit would change behaviour.

### M4. The default capability let a page spawn and kill processes; the CSP let images load from any https host (fixed, `f0aded2`)

`src-tauri/capabilities/default.json` gave the main window's local content `shell:allow-spawn`, `shell:allow-kill` and
`shell:allow-execute` (the sidecar). No page uses them: the Rust side starts and stops the agent itself, and Rust calls
are not ACL-gated. A release window loads the agent's page, which is remote, so only `agent-ui.json` applies to it; dev
builds, though, treat `devUrl` as local. `img-src https:` (in `tauri.conf.json` and `agent/uiStatic.ts` `UI_CSP`) let a
script that got in send data out through image requests, and no screen loads a remote image. *Fix:* the shell
permissions are removed and `img-src` is `'self' data:`. `cargo check` passes.

### M5. Pairing trusts an `Origin` that a local program can forge (not fixed)

`agent/auth.ts:172`. `POST /api/pair/request` requires `Origin: chrome-extension://<id>`. A browser cannot fake that, but
any program on the computer can. That includes another Windows account on the PO's PC, because loopback is shared.
*Failure:* (a) a stranger's request shows up in the app, and an owner who clicks Allow without comparing codes gives that
stranger an extension token. With it the stranger can read deals, settings and state (never a key), answer Review
questions, and feed fake Home Depot reads into scans. (b) Five pending requests under made-up ids hold pairing shut
for ten minutes. *Mitigated by:* the code shown both in Chrome and in the app ("Allow it only if Chrome shows the same
code", `PairingNotice.tsx`), and a token that is claimed only with the 256-bit claim secret. *Possible fix (v2):* have
the owner type the code that Chrome shows into the app, instead of only clicking Allow.

### M6. Worker results are stored whole and rewritten on every save (not fixed)

`agent/app.ts:769`, `agent/workerJobs.ts:255`. A result is kept as the helper sent it, up to 1 MB, for the last 200
finished jobs. `jobs.json` is rewritten whole on every lease, heartbeat and answer. *Failure:* a faulty or compromised
helper fills `jobs.json` toward 200 MB and every heartbeat rewrites it. *Fix (v2):* keep results only until their
reader has read them, or cap their size per kind.

### M7. Any extension may answer any job (not fixed)

`agent/app.ts:765`. `POST /api/worker/result` takes an answer for any unfinished job id, whichever extension leased it
and even one still queued. Today only one extension is paired. *Fix if more are ever paired:* record the leasing
extension on the job and refuse others.

### M8. The installer folder and the zip fallback (not fixed)

`agent/setup.ts:17` and `:62`. Without `SPLIT_FINDER_EXTENSION_ZIP` (the packaged app sets it from its resources),
the agent installs `<cwd>/output/*-chrome.zip`. That is a planted helper if the sidecar's working folder is one other
people can write to. Install helper also removes `~/Documents/split-finder` (Windows: Documents\split-finder) entirely
first, and the owner's own files there would go with it. *Fix:* release builds ignore the cwd fallback, and only a
folder the installer made (for example one holding a marker file) is replaced.

### M9. No limit on open streams; no request timeout (not fixed)

`agent/events.ts:23`, `agent/server.ts:19`. Any token holder may open any number of event streams.
`requestTimeout = 0` (needed for long polls) also lets a local program hold the token-less pairing routes open with a
slow body. The listener is loopback only, so this is a local denial of service. *Fix:* a per-principal stream cap, and a
body read timeout in `readJsonBody`.

### M10. `keyProblem` stores the sentence it is given (not changed)

`agent/work.ts:639`. Every sentence it is given today is a fixed one or, since I1, eBay's scrubbed words. A
`scrub(sentence, keys)` there would hold for future callers. It is left alone because work.ts is being changed in
parallel.

## Checked and sound

- **Host and DNS rebinding.** Every request, including the token-less routes and `/ui`, must carry Host
  `127.0.0.1:8790` or `localhost:8790`. A rebound name, `[::1]` and a missing port are refused (tested).
- **Origin and CSRF.** Every route except `hello` and the two pairing calls needs a Bearer token, read only from the
  Authorization header: never from the query (the dev `?token=` is UI-side and dev-only) or a cookie. A request with an
  Origin must pair it with its own token. This covers GET routes with side effects (`/api/worker/next`,
  `/api/deals/:id/lookup`) and the event stream. `null` and foreign origins are refused, and a foreign preflight gets
  no CORS headers (tested).
- **Token comparison.** The app token is compared by `timingSafeEqual` over sha256. Extension tokens are looked up by
  sha256, so a timing difference says nothing about the token. Tokens are 256-bit.
- **Pairing.** The six-digit code is never a credential. The claim takes the 256-bit secret, from the asking
  extension's origin, once. Approval is app-only, requests expire after 10 minutes, and at most 5 wait (tested with
  guessed codes and request ids).
- **Roles.** Everything that changes things is `ui`. The extension's `any` routes are reads plus
  `POST /api/review/:id/answer` (the paired side panel answers, by design: decisions.md W5). The extension cannot queue
  jobs, change settings or keys, quit, reload, or ask the AI (tested). What it reads (state, settings, deals, review,
  activity, events) never holds a key (tested).
- **New routes.** `read-pages`, `helper/reload`, `lookups/run` (`maxSearches` checked; spending stays under
  `SearchBudget`), `review/:id/undo`, `review/:id/ask {force}` (boolean checked; the question must be open; cost stays
  under the AI cap), `deals/:id/watch|bogo|parts/:part/price` (the deal must exist; bodies checked by core), and
  `agent/quit`: all `ui`. Each version string, from a heartbeat or `?v=`, must match `HELPER_VERSION` (tested with
  markup).
- **What Chrome may be made to fetch.** Item ids become digits in `/p/<id>`, a search becomes `/s/<encodeURIComponent>`,
  and BOGO listings must match one fixed path regex. All of it runs on homedepot.com in an isolated-world script. No
  job names a URL or a host.
- **Prompt injection.** The research tools are a Home Depot page read (digits or a homedepot.com `/p/` address), a Home
  Depot search (at most 200 characters), the local catalog (read-only), and Anthropic's server-side web search and fetch
  limited to the brand sites by `allowed_domains`. None reaches the store, the keys, the agent API or any other host.
  Tool calls are capped per question and cost is capped per month. Quotes and brief sentences are checked by code
  (`core/src/research/verify.ts`, `core/src/brief/ground.ts`). A brief's links come from the evidence, never from the
  model. Results are suggestions, and Autopilot acts only on trusted models' verified ones.
- **Model output in the UI.** Rendered as React text. There is no `dangerouslySetInnerHTML` or `innerHTML` in
  desktop-ui or the extension, and the CSP is `script-src 'self'`.
- **Static files.** `/ui` refuses `..`, encoded dots and slashes (never decoded), backslashes, NUL, double slashes and
  absolute paths, and serves nothing outside its folder (tested on 12 shapes). The CSV and deal exports take no path
  from the request, and the file name is cleaned.
- **Keys at rest and in errors.** `keys.json`, `pairing.json` and `agent-token` are written 0600, and on Windows the
  ACL is narrowed before the content goes in. The store directory is 0700. No route returns a key. Run errors go through
  `scrub`. The OpenAI-compatible provider and the Telegram client take the key out before they cut the text. An
  OpenAI-compatible address must be https (or http on loopback), with no user or query; the Anthropic provider has no
  address setting. The unhandled-error log prints only the error's name.
- **Shell.** The token goes into a page only after the HMAC challenge, and only when the page is at the agent's origin.
  `popover_do` routes are allow-listed and JSON-encoded. The Preferences tab is allow-listed. `reveal_data_folder` and
  `app_info` take no input. The Windows helpers (`icacls`, `whoami`, `tar.exe`, Explorer reveal, Chrome start) use full
  System32 paths, argument arrays and fixed strings, with no shell and no input from the network.
- **Extension.** Host permissions are serpapi, homedepot, eBay, Anthropic, Keepa and the one loopback port. Any other
  host is an optional runtime request. Messages are taken only from the extension's own pages, plus the chip's two
  types from its content script. There is no `externally_connectable` and no `onMessageExternal`.
- **Telegram.** The token is only in Telegram's own URL path. Messages are plain text (no `parse_mode`), so a title
  cannot add links or markup.
- **Dependencies.** The sidecar is the agent plus core, bundled by esbuild into a Node 24.13.0 single executable whose
  download is pinned by SHA-256. Agent and core import nothing but `node:*` and repo code.
