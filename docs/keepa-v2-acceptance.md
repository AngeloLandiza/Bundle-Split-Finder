# Keepa v2 acceptance (plan §8)

Fixture and automated gates run in CI (`npm test`). Live checks need Alex's Keepa key and budget approval.

## Phase delivery and critiques (plan §7)

| Phase | Deliverable | Tests / tools | Critique |
| --- | --- | --- | --- |
| 0 | `core/src/keepa/`, fixtures, `keepa:budget` | `core/test/keepa*.ts` | Bugbot c3b47b68 — fixed |
| 1 | Extension Keepa key, planner, identify, option snapshots | `keepa-paid.test.ts`, `keepa-snapshots.test.ts`, worker keepa key test | [Bugbot Phase 1](684ad678-6f19-4b35-b0ce-71dfd704529a) — fixed |
| 2 | Scale, trends, alerts, deferred UI | `keepa-plan`, `keepa-acceptance`, `keepa-discovery` | Bugbot 45391542 — fixed |
| 3 | `agent/`, dashboard, bridge | `agent:scan`, `agent-bridge.test.ts` | Bugbot 11b7b147 — fixed |
| 4 | Relay, desktop notify, digest | `relay.test.ts`, worker alerts | Bugbot 1ffed92b — fixed |

## Automated (no network)

| Gate | Command / test |
| --- | --- |
| Keepa client, budget, fixtures | `core/test/keepa*.ts` |
| Discovery scale and planner | `core/test/keepa-plan.test.ts`, `keepa-discovery.test.ts`, `keepa-acceptance.test.ts` |
| Trends, alerts, relay | `keepa-trends.test.ts`, `keepa-alerts.test.ts`, `relay.test.ts`, `post-scan.test.ts` |
| Extension worker Keepa + relay + bridge | `extension/lib/worker.test.ts` |
| Agent fixture scan | `npm run agent:scan -- --fixtures` |

## Manual (Alex)

1. **20/min bucket** — Set `keepaTokensPerScan` for a scheduled scan; confirm StatusBar shows deferred Keepa/Serp steps and the scan stops on cap, not account empty.
2. **Discovery drops after Confirm** — Resolve one bundle; next run's Keepa plan should favour refreshes (`keepa-acceptance` models this on fixtures).
3. **All ways to sell** — Open Detail for a bundle with multiple options; each way shows profit/ROI or "No estimate yet".
4. **Messages** — Enable alerts + Review digest; finish a scan with open Review or ROI hit; confirm desktop line + optional relay digest.
5. **Rule 8b** — No change to match promotion; existing audit tests still apply.

## Prototype agent

1. `npm run agent:scan -- --fixtures` then `npm run agent:dashboard`
2. In Settings › Your data, enable audit bridge (Chrome should ask for the local host); finish an extension scan; confirm `output/agent-bridge.json` updates.