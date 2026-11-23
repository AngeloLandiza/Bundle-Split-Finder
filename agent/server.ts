// Phase 3 prototype dashboard: serve agent status JSON written by agent:scan.
// npm run agent:dashboard

import { createServer } from 'node:http';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { bridgeSummary, wrapBridgeBody } from './bridge';
import { DASHBOARD_HTML } from './dashboardPage';
import { clearAskQueue, enqueueAsk, readAskQueue } from './askQueue';
import { clearPaidQueue, enqueuePaid, readPaidQueue } from './paidQueue';
import { enqueueReview, readReviewQueue, clearReviewQueue } from './reviewQueue';
import { tryServeUi, uiIndexExists } from './uiStatic';
import { agentBridgePath, agentStatusPath } from './paths';
import { checkEbayKeysApp } from './checkEbayKeysApp';
import { checkSerpApiKey } from './checkSerpKey';
import { limitCopy } from '../core/src/deals/limitCopy';
import { publicAppSettings, readAppSettings, writeAppSettings } from './appStore';
import { ingestAuditBody, readDealsSnapshot } from './dealsStore';
import { DEAL_SORTS, type DealSortKey } from '../core/src/deals/sort';
import { dealListSections } from '../core/src/deals/sections';
import { staleBundleDays } from '../core/src/deals/freshness';
import { bundlesCsv } from '../core/src/scan/csv';
import { DEFAULT_SCAN_SETTINGS, type PaidAction } from '../core/src/scan/types';
import { enrichedDealRows, ingestPanelBody, readPanelBundle, readPanelSnapshot } from './panelStore';
import { readHelperState, writeHelperState, type HelperLastJob } from './stateStore';
import {
  clearHdReadPending,
  peekHdReadPending,
  readHdReadResult,
  requestHdRead,
  storeHdReadResult,
} from './hdReadQueue';
import { clearPendingScan, peekPendingScan, requestScan } from './scanQueue';
import { extensionInstallDir, extensionZipSource, installExtensionFromZip, setupStatus } from './setup';

const port = Number(process.env.AGENT_PORT ?? 8790);

function readJsonBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer((req, res) => {
  if (tryServeUi(req.url ?? '', res)) return;
  if (req.url === '/' || req.url === '/index.html') {
    if (uiIndexExists()) {
      res.writeHead(302, { Location: '/ui/' });
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(DASHBOARD_HTML);
    return;
  }
  if (req.method === 'POST' && req.url === '/api/panel') {
    void readJsonBody(req)
      .then((body) => {
        const at = new Date().toISOString();
        const parsed = JSON.parse(body) as unknown;
        ingestPanelBody(parsed, at);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      })
      .catch(() => {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, message: 'Invalid JSON body.' }));
      });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/bridge') {
    void readJsonBody(req)
      .then((body) => {
        const bridgePath = agentBridgePath();
        mkdirSync(dirname(bridgePath), { recursive: true });
        const at = new Date().toISOString();
        const parsed = JSON.parse(body) as unknown;
        writeFileSync(bridgePath, JSON.stringify(wrapBridgeBody(parsed, at), null, 2));
        ingestAuditBody(parsed, at);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      })
      .catch(() => {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, message: 'Invalid JSON body.' }));
      });
    return;
  }
  if (req.url === '/api/bridge' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    const bridgePath = agentBridgePath();
    if (!existsSync(bridgePath)) {
      res.end(JSON.stringify({ ok: false, message: 'No extension export yet. Enable the bridge in Settings and finish a scan.' }));
      return;
    }
    try {
      const wrapped = JSON.parse(readFileSync(bridgePath, 'utf8')) as import('./bridge').BridgeEnvelope;
      res.end(JSON.stringify({ ok: true, summary: bridgeSummary(wrapped) }));
    } catch {
      res.end(JSON.stringify({ ok: false, message: 'Could not read agent-bridge.json.' }));
    }
    return;
  }
  if (req.url === '/api/setup/status' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, ...setupStatus() }));
    return;
  }
  if (req.url === '/api/setup/install-extension' && req.method === 'POST') {
    res.setHeader('Content-Type', 'application/json');
    const zip = extensionZipSource();
    if (!zip) {
      res.statusCode = 503;
      res.end(JSON.stringify({ ok: false, message: 'Extension zip is not bundled with this app.' }));
      return;
    }
    try {
      const dir = extensionInstallDir();
      installExtensionFromZip(zip, dir);
      res.end(JSON.stringify({ ok: true, ...setupStatus(), extensionDir: dir }));
    } catch (err) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, message: err instanceof Error ? err.message : 'Install failed.' }));
    }
    return;
  }
  if (req.url === '/api/state' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    const st = readHelperState();
    res.end(JSON.stringify(st ? { ok: true, ...st } : { ok: false, message: 'Helper has not synced yet.' }));
    return;
  }
  if (req.url === '/api/state' && req.method === 'POST') {
    void readJsonBody(req)
      .then((body) => {
        const parsed = JSON.parse(body) as Parameters<typeof writeHelperState>[0];
        writeHelperState(parsed);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      })
      .catch(() => {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, message: 'Invalid state JSON.' }));
      });
    return;
  }
  if (req.url === '/api/settings/check-serp' && req.method === 'POST') {
    void readJsonBody(req)
      .then((body) => {
        const parsed = JSON.parse(body) as { serpApiKey?: string };
        const result = checkSerpApiKey(parsed.serpApiKey ?? '');
        return result.then((r) => {
          res.setHeader('Content-Type', 'application/json');
          if (r.ok) res.end(JSON.stringify({ ok: true, account: r.account }));
          else {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, message: r.message }));
          }
        });
      })
      .catch(() => {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, message: 'Invalid JSON.' }));
      });
    return;
  }
  if (req.url === '/api/settings/check-ebay' && req.method === 'POST') {
    void readJsonBody(req)
      .then((body) => {
        const parsed = JSON.parse(body) as { ebayAppId?: string; ebayCertId?: string };
        return checkEbayKeysApp(parsed.ebayAppId ?? '', parsed.ebayCertId ?? '').then((r) => {
          res.setHeader('Content-Type', 'application/json');
          if (r.ok) res.end(JSON.stringify({ ok: true }));
          else {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, message: r.message }));
          }
        });
      })
      .catch(() => {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, message: 'Invalid JSON.' }));
      });
    return;
  }
  if (req.url === '/api/settings' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    const pub = publicAppSettings();
    const full = readAppSettings();
    res.end(
      JSON.stringify({
        ok: true,
        appPrimaryUi: full.appPrimaryUi,
        updatedAt: full.updatedAt,
        serpApiKeySet: pub.serpApiKeySet,
        serpApiKey: full.serpApiKey,
        keepaKeySet: pub.keepaKeySet,
        keepaApiKey: full.keepaApiKey,
        ebayKeysSet: pub.ebayKeysSet,
        ebayAppId: full.ebayAppId,
        ebayCertId: full.ebayCertId,
        anthropicKeySet: pub.anthropicKeySet,
        anthropicKey: full.anthropicKey,
        ebaySettings: full.ebaySettings,
        compactHelperPanel: full.compactHelperPanel,
        askAfterScan: full.askAfterScan,
        settings: full.settings,
      }),
    );
    return;
  }
  if (req.url === '/api/settings' && req.method === 'POST') {
    void readJsonBody(req)
      .then((body) => {
        const patch = JSON.parse(body) as {
          serpApiKey?: string | null;
          keepaApiKey?: string | null;
          ebayAppId?: string | null;
          ebayCertId?: string | null;
          anthropicKey?: string | null;
          ebaySettings?: Record<string, unknown>;
          appPrimaryUi?: boolean;
          compactHelperPanel?: boolean;
          askAfterScan?: boolean;
          settings?: Record<string, unknown>;
        };
        const next = writeAppSettings({
          serpApiKey: patch.serpApiKey,
          keepaApiKey: patch.keepaApiKey,
          ebayAppId: patch.ebayAppId,
          ebayCertId: patch.ebayCertId,
          anthropicKey: patch.anthropicKey,
          appPrimaryUi: patch.appPrimaryUi,
          compactHelperPanel: patch.compactHelperPanel,
          askAfterScan: patch.askAfterScan,
          ebaySettings: patch.ebaySettings as Parameters<typeof writeAppSettings>[0]['ebaySettings'],
          settings: patch.settings as Parameters<typeof writeAppSettings>[0]['settings'],
        } as Parameters<typeof writeAppSettings>[0]);
        const pub = publicAppSettings();
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            ok: true,
            updatedAt: next.updatedAt,
            serpApiKeySet: pub.serpApiKeySet,
            keepaKeySet: pub.keepaKeySet,
            ebayKeysSet: pub.ebayKeysSet,
            anthropicKeySet: pub.anthropicKeySet,
          }),
        );
      })
      .catch(() => {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, message: 'Invalid settings JSON.' }));
      });
    return;
  }
  if (req.url === '/api/review' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    const snap = readDealsSnapshot();
    const questions = snap?.openQuestions.filter((q) => q.answer === null) ?? [];
    const ebayQuestions = snap?.openEbayQuestions ?? [];
    if (!questions.length && !ebayQuestions.length) {
      res.end(JSON.stringify({ ok: false, message: 'No open review questions. Sync after a scan with bridge on.' }));
      return;
    }
    res.end(JSON.stringify({ ok: true, questions, ebayQuestions, aiSuggestions: snap?.aiSuggestions ?? [] }));
    return;
  }
  if (req.url === '/api/review/queue' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, jobs: readReviewQueue() }));
    return;
  }
  if (req.url === '/api/review/queue/ack' && req.method === 'POST') {
    clearReviewQueue();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === '/api/review/queue' && req.method === 'POST') {
    void readJsonBody(req)
      .then((body) => {
        const parsed = JSON.parse(body) as {
          id?: string;
          answer?: import('./reviewQueue').QueuedReviewAnswer;
          aiSuggestion?: boolean;
        };
        if (!parsed.id || !parsed.answer) throw new Error('bad body');
        enqueueReview(parsed.id, parsed.answer, { aiSuggestion: parsed.aiSuggestion });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      })
      .catch(() => {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, message: 'Invalid review queue body.' }));
      });
    return;
  }
  if (req.url === '/api/paid/queue' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, jobs: readPaidQueue() }));
    return;
  }
  if (req.url === '/api/paid/queue/ack' && req.method === 'POST') {
    clearPaidQueue();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === '/api/paid/queue' && req.method === 'POST') {
    void readJsonBody(req)
      .then((body) => {
        const parsed = JSON.parse(body) as { action?: PaidAction };
        if (!parsed.action || (parsed.action.kind !== 'lookUp' && parsed.action.kind !== 'verify')) throw new Error('bad body');
        enqueuePaid(parsed.action);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      })
      .catch(() => {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, message: 'Invalid paid queue body.' }));
      });
    return;
  }
  if (req.url === '/api/review/ask/queue' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, jobs: readAskQueue() }));
    return;
  }
  if (req.url === '/api/review/ask/queue/ack' && req.method === 'POST') {
    clearAskQueue();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === '/api/review/ask/queue' && req.method === 'POST') {
    void readJsonBody(req)
      .then((body) => {
        const parsed = JSON.parse(body) as { questionId?: string; all?: boolean };
        if (parsed.all === true) enqueueAsk({ all: true });
        else if (typeof parsed.questionId === 'string' && parsed.questionId) enqueueAsk({ questionId: parsed.questionId });
        else throw new Error('bad body');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      })
      .catch(() => {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, message: 'Invalid ask queue body.' }));
      });
    return;
  }
  if (req.url === '/api/deals' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    const snap = readDealsSnapshot();
    if (!snap) {
      res.end(JSON.stringify({ ok: false, message: 'No deals yet. Run a scan with the bridge enabled.' }));
      return;
    }
    const reviewKeys = new Set(snap.reviewOpen.map((r) => r.bundleKey).filter((k): k is string => Boolean(k)));
    const panel = readPanelSnapshot();
    const staleDays =
      panel !== null
        ? staleBundleDays(panel.bundles, Date.now(), DEFAULT_SCAN_SETTINGS.freshnessMs)
        : null;
    const helper = readHelperState();
    const now = Date.now();
    const limitNotice =
      helper?.lastJob && panel?.bundles.length
        ? limitCopy(
            {
              lastJob: helper.lastJob as HelperLastJob,
              searchesPerScan: helper.searchesPerScan,
              rateLimitPerHour: helper.rateLimitPerHour,
              now,
            },
            panel.bundles,
          )
        : null;
    const ebayNotice = helper?.lastJob?.ebayNotice ?? null;
    res.end(JSON.stringify({
      ok: true,
      ...snap,
      staleDays,
      limitNotice,
      ebayNotice,
      bundles: enrichedDealRows(snap.bundles, reviewKeys),
    }));
    return;
  }
  if (req.url?.startsWith('/api/deals/export') && req.method === 'GET') {
    const panel = readPanelSnapshot();
    if (!panel?.bundles.length) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, message: 'No panel data for export. Run a scan with bridge on.' }));
      return;
    }
    const u = new URL(req.url, 'http://127.0.0.1');
    const sortParam = u.searchParams.get('sort') ?? 'profit';
    const sort: DealSortKey = DEAL_SORTS.some((s) => s.key === sortParam) ? (sortParam as DealSortKey) : 'profit';
    const groups = dealListSections(panel.bundles, sort);
    const csv = bundlesCsv(groups.flatMap((g) => g.rows));
    const d = new Date();
    const two = (n: number) => String(n).padStart(2, '0');
    const file = `split-finder-deals-${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
    res.end(csv);
    return;
  }
  const bundleExport = req.url?.match(/^\/api\/deals\/([^/]+)\/export\.csv$/);
  if (bundleExport && req.method === 'GET') {
    const key = decodeURIComponent(bundleExport[1] ?? '');
    const bundle = readPanelBundle(key);
    if (!bundle) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, message: 'Bundle not found.' }));
      return;
    }
    const csv = bundlesCsv([bundle]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="split-finder-${bundle.model}.csv"`);
    res.end(csv);
    return;
  }
  if (req.url?.startsWith('/api/deals/') && req.method === 'GET') {
    const key = decodeURIComponent(req.url.slice('/api/deals/'.length).split('?')[0] ?? '');
    res.setHeader('Content-Type', 'application/json');
    const bundle = readPanelBundle(key);
    if (!bundle) {
      res.end(JSON.stringify({ ok: false, message: 'Bundle not found. Finish a scan with bridge on.' }));
      return;
    }
    res.end(JSON.stringify({ ok: true, bundle }));
    return;
  }
  if (req.url === '/api/scan/start' && req.method === 'POST') {
    res.setHeader('Content-Type', 'application/json');
    const pending = requestScan();
    res.end(JSON.stringify({ ok: true, pending }));
    return;
  }
  if (req.url === '/api/scan/pending' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, pending: peekPendingScan() }));
    return;
  }
  if (req.url === '/api/scan/ack' && req.method === 'POST') {
    clearPendingScan();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === '/api/hd-read/pending' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, pending: peekHdReadPending() }));
    return;
  }
  if (req.url === '/api/hd-read/request' && req.method === 'POST') {
    void readJsonBody(req)
      .then((body) => {
        const parsed = JSON.parse(body) as { itemIds?: number[] };
        const pending = requestHdRead(parsed.itemIds ?? []);
        res.setHeader('Content-Type', 'application/json');
        if (!pending) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, message: 'No valid Home Depot item ids.' }));
          return;
        }
        res.end(JSON.stringify({ ok: true, pending }));
      })
      .catch(() => {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, message: 'Invalid JSON body.' }));
      });
    return;
  }
  if (req.url === '/api/hd-read/result' && req.method === 'POST') {
    void readJsonBody(req)
      .then((body) => {
        const parsed = JSON.parse(body) as { id?: string; outcomes?: unknown };
        if (!parsed.id) throw new Error('missing id');
        storeHdReadResult(parsed.id, parsed.outcomes ?? null);
        clearHdReadPending();
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      })
      .catch(() => {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, message: 'Invalid hd-read result.' }));
      });
    return;
  }
  if (req.url?.startsWith('/api/hd-read/result?id=') && req.method === 'GET') {
    const id = new URL(req.url, 'http://127.0.0.1').searchParams.get('id');
    res.setHeader('Content-Type', 'application/json');
    if (!id) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, message: 'Missing id.' }));
      return;
    }
    const stored = readHdReadResult(id);
    res.end(JSON.stringify(stored ? { ok: true, ...stored } : { ok: false, message: 'No result yet.' }));
    return;
  }
  if (req.url === '/api/status') {
    res.setHeader('Content-Type', 'application/json');
    const statusPath = agentStatusPath();
    if (!existsSync(statusPath)) {
      res.end(JSON.stringify({ ok: false, message: 'No scan saved yet. Tap Scan now below or run a scan in the helper.' }));
      return;
    }
    try {
      res.end(readFileSync(statusPath, 'utf8'));
    } catch {
      res.end(JSON.stringify({ ok: false, message: 'Could not read agent-last-scan.json.' }));
    }
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});

server.listen(port, '127.0.0.1', () => console.log(`Agent dashboard http://127.0.0.1:${port}/`));