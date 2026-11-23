/** Local agent dashboard HTML (design tokens from docs/design.md). */

export const DASHBOARD_HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Split Finder</title>
  <style>
    :root {
      --paper: #fafaf7;
      --surface: #fff;
      --sunken: #f1f0ea;
      --ink: #1a1c1e;
      --ink-2: #54585d;
      --ink-3: #676b70;
      --line: #e2e0d8;
      --line-strong: #8b887f;
      --link: #1d4ed8;
      --attention: #744600;
      --attention-bg: #fff3d1;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--paper);
      color: var(--ink);
      font-family: system-ui, 'Segoe UI', sans-serif;
      font-size: 14px;
      line-height: 20px;
    }
    .mono { font-family: ui-monospace, 'JetBrains Mono', Menlo, monospace; font-variant-numeric: tabular-nums; }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 20px;
      background: var(--surface);
      border-bottom: 1px solid var(--line);
    }
    header h1 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: 0.01em; }
    .mark {
      width: 20px; height: 20px; flex-shrink: 0;
      border: 1.5px solid var(--ink); border-radius: 2.5px;
      position: relative;
    }
    .mark::after {
      content: '';
      position: absolute; top: 0; right: 0; width: 50%; height: 100%;
      background: var(--ink); border-radius: 0 2px 2px 0;
    }
    main { max-width: 32rem; margin: 0 auto; padding: 24px 20px 40px; display: flex; flex-direction: column; gap: 14px; }
    .band {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 14px 16px;
    }
    .label {
      font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
      color: var(--ink-2); margin: 0 0 8px;
    }
    .figure { font-size: 13px; color: var(--ink-2); margin: 0; }
    .figure strong { color: var(--ink); font-weight: 600; }
    .loading { color: var(--ink-3); }
    .loading::after {
      content: '';
      display: inline-block;
      width: 4px; height: 4px; margin-left: 2px;
      border-radius: 50%; background: var(--ink-3);
      animation: pulse 1s ease-in-out infinite;
    }
    @keyframes pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
    .notice-attention {
      background: var(--attention-bg);
      color: var(--attention);
      border: 1px solid #e8c98a;
      border-radius: 6px;
      padding: 12px 14px;
      font-size: 13px;
      line-height: 18px;
    }
    .notice-sunken {
      background: var(--sunken);
      color: var(--ink-2);
      border-radius: 6px;
      padding: 12px 14px;
      font-size: 13px;
      line-height: 18px;
    }
    ol.steps { margin: 0; padding: 0; list-style: none; }
    ol.steps li {
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr);
      column-gap: 12px;
      padding: 12px 0;
      border-bottom: 1px solid var(--line);
    }
    ol.steps li:last-child { border-bottom: none; padding-bottom: 0; }
  ol.steps li:first-child { padding-top: 0; }
    .step-n {
      width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;
      border-radius: 12px; border: 1px solid var(--line-strong); color: var(--ink-2);
      font-size: 12px; font-weight: 600;
    }
    .step-n.on { background: var(--ink); color: var(--surface); border-color: var(--ink); }
    .step h2 { margin: 0 0 2px; font-size: 14px; font-weight: 600; }
    .step p { margin: 0; font-size: 13px; line-height: 18px; color: var(--ink-2); }
    a { color: var(--link); font-weight: 500; }
    a:hover { text-decoration: underline; }
    details { margin-top: 8px; }
    details summary {
      cursor: pointer;
      font-size: 13px;
      color: var(--ink-2);
      font-weight: 500;
    }
    pre.tech {
      margin: 8px 0 0;
      padding: 12px;
      background: var(--sunken);
      border-radius: 4px;
      font-size: 11px;
      line-height: 16px;
      overflow: auto;
      max-height: 12rem;
    }
    .row-metrics { display: grid; gap: 6px; }
    .metric { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
    .metric span:last-child { color: var(--ink); font-weight: 500; }
    .btn {
      height: 32px;
      padding: 0 12px;
      border-radius: 4px;
      border: none;
      background: var(--ink);
      color: var(--surface);
      font-weight: 600;
      font-size: 13px;
      cursor: pointer;
    }
    .btn:disabled { background: var(--sunken); color: var(--ink-3); cursor: default; }
    .btn-secondary {
      background: var(--surface);
      color: var(--ink);
      border: 1px solid var(--line-strong);
    }
    .path {
      margin-top: 8px;
      padding: 8px 10px;
      background: var(--sunken);
      border-radius: 4px;
      font-size: 12px;
      word-break: break-all;
    }
    #deals-list .deal-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      column-gap: 12px;
      padding: 11px 0;
      border-bottom: 1px solid var(--line);
    }
    #deals-list .title {
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  </style>
</head>
<body>
  <header>
    <div style="display:flex;align-items:center;gap:8px">
      <div aria-hidden="true" class="mark"></div>
      <h1>Split Finder</h1>
    </div>
    <span class="mono figure" id="header-state">Home</span>
  </header>
  <main>
    <section class="band" id="setup-band">
      <p class="label">Browser helper</p>
      <p id="setup-line" class="figure loading">Checking install</p>
      <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:12px">
        <button type="button" class="btn" id="btn-install" disabled>Install helper folder</button>
        <button type="button" class="btn btn-secondary" id="btn-chrome">Open Chrome extensions</button>
      </div>
      <p class="path mono" id="setup-path" hidden></p>
    </section>
    <section class="band" id="settings-band">
      <p class="label">Settings</p>
      <label class="figure" for="serp-key">SerpApi key</label>
      <input id="serp-key" type="password" autocomplete="off" style="width:100%;margin:8px 0 10px;padding:8px 10px;border:1px solid var(--line-strong);border-radius:4px" />
      <div style="display:flex;flex-wrap:wrap;gap:10px">
        <button type="button" class="btn" id="btn-save-settings">Save settings</button>
        <button type="button" class="btn btn-secondary" id="btn-scan">Scan now</button>
      </div>
      <p id="settings-line" class="figure" style="margin-top:10px"></p>
    </section>
    <section class="band" id="deals-band">
      <p class="label">Deals</p>
      <p id="deals-line" class="figure loading">Loading</p>
      <ul id="deals-list" style="margin:10px 0 0;padding:0;list-style:none"></ul>
    </section>
    <section class="band" id="review-band">
      <p class="label">Review</p>
      <p id="review-line" class="figure loading">Loading</p>
      <ul id="review-list" style="margin:10px 0 0;padding:0;list-style:none"></ul>
    </section>
    <section class="band" aria-live="polite">
      <p class="label">Last scan</p>
      <p id="scan-line" class="figure loading">Loading status</p>
      <div id="scan-metrics" class="row-metrics" hidden></div>
    </section>
    <section class="band">
      <p class="label">Extension sync</p>
      <p id="bridge-line" class="figure loading">Loading</p>
    </section>
    <div id="empty-hint" class="notice-sunken" hidden>
      <p style="margin:0 0 8px;font-weight:600;color:var(--ink)">Next steps in Chrome</p>
      <p style="margin:0;font-size:13px;line-height:18px">After Load unpacked: save your SerpApi key above. The helper syncs every minute. Answer Review in the helper until the full Review screen ships here.</p>
    </div>
    <div id="attention" class="notice-attention" hidden></div>
    <details id="tech-wrap" hidden>
      <summary>Technical details</summary>
      <pre class="tech mono" id="json"></pre>
    </details>
  </main>
  <script>
    const scanLine = document.getElementById('scan-line');
    const bridgeLine = document.getElementById('bridge-line');
    const scanMetrics = document.getElementById('scan-metrics');
    const emptyHint = document.getElementById('empty-hint');
    const attention = document.getElementById('attention');
    const techWrap = document.getElementById('tech-wrap');
    const jsonEl = document.getElementById('json');
    const headerState = document.getElementById('header-state');
    const setupLine = document.getElementById('setup-line');
    const setupPath = document.getElementById('setup-path');
    const btnInstall = document.getElementById('btn-install');
    const btnChrome = document.getElementById('btn-chrome');
    const serpKey = document.getElementById('serp-key');
    const btnSave = document.getElementById('btn-save-settings');
    const btnScan = document.getElementById('btn-scan');
    const settingsLine = document.getElementById('settings-line');
    const dealsLine = document.getElementById('deals-line');
    const dealsList = document.getElementById('deals-list');
    const reviewLine = document.getElementById('review-line');
    const reviewList = document.getElementById('review-list');

    btnChrome.addEventListener('click', () => { window.open('chrome://extensions/', '_blank'); });

    function clearLoading(el) { el.classList.remove('loading'); }

    function renderSetup(data) {
      clearLoading(setupLine);
      setupPath.textContent = data.extensionDir;
      setupPath.hidden = false;
      if (data.extensionReady) {
        setupLine.textContent = 'Browser helper folder is ready. Load unpacked in Chrome using the path below.';
        btnInstall.disabled = true;
        btnInstall.textContent = 'Helper installed';
      } else {
        setupLine.textContent = data.extensionMessage || 'Install the helper folder, then Load unpacked in Chrome.';
        btnInstall.disabled = !data.zipAvailable;
        btnInstall.textContent = 'Install helper folder';
      }
    }

    fetch('/api/setup/status')
      .then((r) => r.json())
      .then(renderSetup)
      .catch(() => {
        clearLoading(setupLine);
        setupLine.textContent = 'Could not read setup status.';
      });

    btnInstall.addEventListener('click', () => {
      btnInstall.disabled = true;
      fetch('/api/setup/install-extension', { method: 'POST' })
        .then((r) => r.json())
        .then((data) => {
          if (data.ok) renderSetup(data);
          else {
            setupLine.textContent = data.message || 'Install failed.';
            btnInstall.disabled = false;
          }
        })
        .catch(() => {
          setupLine.textContent = 'Install failed. Try again.';
          btnInstall.disabled = false;
        });
    });

    function renderMetrics(container, pairs) {
      container.innerHTML = '';
      for (const [k, v] of pairs) {
        const row = document.createElement('div');
        row.className = 'metric figure';
        row.innerHTML = '<span>' + k + '</span><span class="mono">' + v + '</span>';
        container.appendChild(row);
      }
      container.hidden = pairs.length === 0;
    }

    fetch('/api/settings')
      .then((r) => r.json())
      .then((s) => {
        if (s.ok) {
          settingsLine.textContent = s.serpApiKeySet
            ? 'Key on file. The helper picks up changes within a minute.'
            : 'Paste your SerpApi key and save. Estimates need a working key.';
          if (s.serpApiKey) serpKey.placeholder = 'Key saved (enter to replace)';
        }
      })
      .catch(() => {});

    btnSave.addEventListener('click', () => {
      fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serpApiKey: serpKey.value || undefined,
          appPrimaryUi: true,
          settings: { agentBridgeAfterScan: true },
        }),
      })
        .then((r) => r.json())
        .then((s) => {
          settingsLine.textContent = s.ok ? 'Saved. The helper will sync shortly.' : (s.message || 'Save failed.');
          if (s.ok) serpKey.value = '';
        });
    });

    btnScan.addEventListener('click', () => {
      btnScan.disabled = true;
      fetch('/api/scan/start', { method: 'POST' })
        .then((r) => r.json())
        .then((s) => {
          settingsLine.textContent = s.ok
            ? 'Scan queued. Keep Chrome open with the helper loaded.'
            : (s.message || 'Could not queue scan.');
          btnScan.disabled = false;
        });
    });

    function renderDeals(data) {
      clearLoading(dealsLine);
      clearLoading(reviewLine);
      if (!data.ok) {
        dealsLine.textContent = data.message || 'No deals yet.';
        reviewLine.textContent = '—';
        return;
      }
      dealsLine.textContent = data.bundles.length + ' bundles synced at ' + data.at + '. Figures are estimates.';
      dealsList.innerHTML = '';
      const sections = ['confirmed', 'review', 'missing_listing', 'contents_not_known'];
      for (const sec of sections) {
        const rows = data.bundles.filter((b) => b.section === sec).slice(0, 8);
        for (const b of rows) {
          const li = document.createElement('li');
          li.className = 'deal-row';
          li.innerHTML =
            '<div style="min-width:0;display:flex;flex-direction:column;gap:2px">' +
            '<div class="title">' + b.title + '</div>' +
            '<div class="figure" style="color:var(--ink-2)">' + b.brand + ' · <span class="mono">' + b.model + '</span> · ' + b.section + '</div>' +
            '</div><div class="figure mono" style="color:var(--ink-2);align-self:center">' + (b.itemId ? '#' + b.itemId : '—') + '</div>';
          dealsList.appendChild(li);
        }
      }
      reviewLine.textContent = data.reviewOpen.length
        ? data.reviewOpen.length + ' open in helper (answer there for now).'
        : 'No open review questions.';
      reviewList.innerHTML = '';
      for (const q of data.reviewOpen.slice(0, 6)) {
        const li = document.createElement('li');
        li.style.cssText = 'padding:8px 0;border-bottom:1px solid var(--line);font-size:13px;color:var(--ink-2)';
        li.textContent = q.kind + ' · ' + (q.bundleKey || q.id);
        reviewList.appendChild(li);
      }
    }

    fetch('/api/deals').then((r) => r.json()).then(renderDeals).catch(() => {
      clearLoading(dealsLine);
      dealsLine.textContent = 'Could not load deals.';
    });

    Promise.all([fetch('/api/status'), fetch('/api/bridge')])
      .then(async ([statusRes, bridgeRes]) => {
        const scan = await statusRes.json();
        const bridge = await bridgeRes.json();
        jsonEl.textContent = JSON.stringify({ scan, bridge }, null, 2);
        techWrap.hidden = false;

        clearLoading(scanLine);
        clearLoading(bridgeLine);

        let empty = !scan.ok;
        if (scan.ok && scan.summary) {
          const s = scan.summary;
          const ended = scan.ended || {};
          headerState.textContent = 'Last run · ' + (ended.status || 'done');
          scanLine.textContent = 'Scan finished. Figures below are estimates from your fee settings.';
          const pairs = [
            ['Bundles', String(s.bundles ?? '—')],
            ['Confirmed', String(s.confirmed ?? '—')],
            ['Review open', String(s.reviewOpen ?? 0)],
            ['SerpApi searches', String(ended.searchesUsed ?? '—')],
            ['Keepa tokens', String(ended.keepaTokensUsed ?? '—')],
          ];
          if (s.keepaPlan) {
            pairs.push(['Keepa plan', s.keepaPlan.discoveryTokens + ' discovery / ' + s.keepaPlan.trackingTokens + ' tracking']);
          }
          renderMetrics(scanMetrics, pairs);
          empty = false;
          if (s.reviewOpen > 0) {
            attention.hidden = false;
            attention.textContent = s.reviewOpen + ' review question(s) open in the Chrome extension.';
          }
        } else {
          scanLine.textContent = scan.message || 'No scan saved yet.';
          scanMetrics.hidden = true;
        }

        if (bridge.ok && bridge.summary) {
          bridgeLine.textContent = bridge.summary.bundleCount + ' bundles synced at ' + bridge.summary.at + '.';
        } else {
          bridgeLine.textContent = bridge.message || 'No extension export yet.';
        }

        if (empty) emptyHint.hidden = false;
        headerState.textContent = empty ? 'Setup' : 'Overview';
      })
      .catch(() => {
        clearLoading(scanLine);
        clearLoading(bridgeLine);
        scanLine.textContent = 'Could not reach the agent.';
        bridgeLine.textContent = 'Try quitting and reopening Split Finder.';
        headerState.textContent = 'Offline';
      });
  </script>
</body>
</html>`;