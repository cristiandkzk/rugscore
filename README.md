# rugscore

A deterministic risk gate for pump.fun (Solana) token graduations — built by extracting the creator-reputation filter out of a live memecoin trading bot and exposing it as a lookup anyone can query.

**Live idea:** paste a mint address, get back whether its creator wallet passes a validated, measured gate — no LLM, no black box, no invented "87/100" score. Just the same threshold a real trading bot uses to decide whether to enter a position, plus live liquidity data.

## Why

Pump.fun graduations are adversarial: **32% of graduated tokens rug within 1 hour**, **85% never reach 2x**, and when a rug happens, **71% go to zero within 30 seconds** — near-zero time to react once it starts. The single best-measured signal isn't a chart pattern, it's the creator wallet's own history: has this wallet launched tokens before, did it batch-deploy, how much did it buy of its own token.

On **11,495 real graduations** (validated across two independent date-split halves of the data), the gate **creator has 0 prior launches AND dev-buy ≤ 0.5 SOL AND no batch-deploy** separates EV +13.1% / +7.5% from +4.3% / +6.4% for everything else. That's the whole model. It's not fancy, but it's measured against real outcomes, not backtested on a held-out set that was never touched again.

## What's in this repo

- `server.mjs` — a zero-dependency Node HTTP server (just `node:http` + built-in `fetch`, no npm install needed). Two endpoints:
  - `GET /api/score?mint=<address>` — creator-reputation verdict (from the historical index below) + live liquidity/volume from DexScreener.
  - `GET /api/stats` — index coverage.
- `data/creator-ledger-agg.json` — **49,687 real pump.fun graduations**, Jun 10 – Sep 1 2026 (84 days), each with the creator wallet's reputation snapshot *at the moment that token was created*: prior launch count, batch-deploy flag, whether a prior token of theirs already graduated, and dev-buy size. **No wallet addresses, no keys, no signatures** — only the aggregated flags, extracted from a larger private dataset.
- `public/index.html` — a minimal frontend to try it without curl.

## Run it

```bash
node server.mjs
# -> http://localhost:8787
```

No API keys, no build step, no dependencies.

## Data quality note

While building the export, we found and filtered 11 "mints" that were actually a data-collection artifact (a recorder fallback value that happened to collide with well-known SPL token addresses, logged thousands of times with empty metadata) — not real pump.fun tokens. They're excluded from the dataset. Worth knowing before trusting any tape-derived dataset: check for entries that couldn't possibly be real before you publish them.

## Scope, honestly

- The reputation index only covers mints whose *create* event we directly observed in our 84-day window. A mint outside that window returns `"known": false` — we don't guess.
- Liquidity/market data is always live (DexScreener), for any mint with an active pool, regardless of whether it's in our historical index.
- This is a read-only research tool, not trading advice, and it doesn't execute anything on-chain.

## Origin

Extracted from `creatorLedger.js`, a module inside a live Solana memecoin trading bot that trades real (small) capital. The underlying research — rug timing, dev-buy thresholds, batch-deploy detection — comes from measuring real executed fills, not simulated backtests.
