# rugscore

A deterministic risk gate for pump.fun (Solana) token graduations — built by extracting the creator-reputation filter out of a live memecoin trading bot and exposing it as a lookup anyone can query.

**Live idea:** paste a mint address, get back whether its creator wallet passes a validated, measured gate — no LLM, no black box, no invented "87/100" score. Just the same threshold a real trading bot uses to decide whether to enter a position, plus live liquidity data. And it doesn't stop at the buy: tell it how long ago you entered, and it checks whether the token has shown the price pattern that, measured against 42,645 real executed fills, predicts a bad outcome if you keep holding. Or skip the mint-pasting entirely — paste a wallet address and it reads every token it currently holds, estimates when each was acquired from its own on-chain history, and runs both checks automatically.

## Why

Pump.fun graduations are adversarial: **32% of graduated tokens rug within 1 hour**, **85% never reach 2x**, and when a rug happens, **71% go to zero within 30 seconds** — near-zero time to react once it starts. The single best-measured signal isn't a chart pattern, it's the creator wallet's own history: has this wallet launched tokens before, did it batch-deploy, how much did it buy of its own token.

On **11,495 real graduations** (validated across two independent date-split halves of the data), the gate **creator has 0 prior launches AND dev-buy ≤ 0.5 SOL AND no batch-deploy** separates EV +13.1% / +7.5% from +4.3% / +6.4% for everything else. That's the whole model. It's not fancy, but it's measured against real outcomes, not backtested on a held-out set that was never touched again.

A second, more targeted number, and the reason this tool doesn't try to rank individual tokens by "safety": of graduated tokens that actually rally to a real post-migration price peak and go on to a resolved outcome (crash or bounce back), **95.6% end up falling ≥80% from that peak and never recovering** (n=30,984). We tested whether creator reputation, entry speed, or pool size at migration could split that number — none did; it stayed between 89% and 98% across every decile and bucket cut. That's a base rate for the category once a token actually pumps, not a per-token signal, which is exactly why the gate above checks creator history (the one thing that did measurably move EV) instead of pretending to score individual tokens.

That number isn't just internally consistent — it replicates on data we never touched. Cross-checked against [`Slinky21/Pumpfun_Memecoin_Corpus`](https://huggingface.co/datasets/Slinky21/Pumpfun_Memecoin_Corpus) (an independently collected corpus, ~5,700 graduated tokens, a different 39-day window, built by an unrelated team with its own pipeline), the exact same peak-to-crash methodology gives **95.05%**. Pool size at migration shows the same pattern there too — flat across the rug rate (92-98% by decile, same non-signal) but a real predictor of *how long it takes to crash* (Spearman rho 0.46-0.50 there vs. 0.42-0.51 in our own data). Creator reputation's null effect on rug probability holds as well (95.2% vs. 95.0%). An external replication on a dataset we didn't collect and couldn't have biased is a stronger claim than a backtest on our own held-out split.

A third number covers the other side of the trade — holding, not buying. The live bot's own exit guard assumed a short price bounce meant a big sell wasn't a real rug, and gave the position a chance to recover. Re-tested against 42,645 real fills: of those, the 31,557 that saw a single-candle drop ≥8% and were held anyway averaged **−31.5%**, against −24.4% for the rest that never saw that pattern — and the gap widens the bigger the drop (up to −22.8pp at a 20% threshold). The "give it a chance" logic doesn't hold up; closing on the signal does. `/api/guard` exposes exactly that check.

## What's in this repo

- `server.mjs` — a zero-dependency Node HTTP server (just `node:http` + built-in `fetch`, no npm install needed). Four endpoints:
  - `GET /api/score?mint=<address>` — creator-reputation verdict (from the historical index below) + live liquidity/volume from DexScreener.
  - `GET /api/guard?mint=<address>&sinceMinutes=<n>` — post-entry check: has the token shown a single-candle price drop ≥8% (live OHLCV from GeckoTerminal) since you entered `sinceMinutes` ago? That threshold and the recommendation it gives are the trading bot's own exit-guard trigger, re-validated against real fills (see above), not a new guess.
  - `GET /api/wallet?address=<address>` — reads a wallet's current SPL token holdings (public Solana RPC, no key, no connect/sign needed) and runs both checks above automatically for each: reputation, plus a guard check whose `sinceMinutes` is estimated from that token account's own on-chain history (the oldest transaction found in its most recent 25). Capped to 15 tokens per wallet to stay responsive. If a token account has more than 25 transactions, the real entry could be older than what we found — flagged as `entryTimeApprox: true`, same under-triggering direction as the `/api/guard` candle-resolution caveat, not a new failure mode.
  - `GET /api/stats` — index coverage.
- `data/creator-ledger-agg.json` — **49,687 real pump.fun graduations**, Jun 10 – Sep 1 2026 (84 days), each with the creator wallet's reputation snapshot *at the moment that token was created*: prior launch count, batch-deploy flag, whether a prior token of theirs already graduated, and dev-buy size. **No wallet addresses, no keys, no signatures** — only the aggregated flags, extracted from a larger private dataset.
- `public/index.html` — a minimal frontend to try it without curl. One click on a check result ("I bought this — watch it") bridges the two endpoints: it remembers the mint and the time in your browser (no backend, no wallet) and re-runs `/api/guard` against it every 30s in a "Watching" section — no need to paste the mint or track the minutes yourself.

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
- `/api/guard` checks price at 1-minute candle resolution for entries under ~8 hours ago, 5-minute resolution beyond that (GeckoTerminal's free tier). The threshold was validated against 30-second ticks, so a "not triggered" result on an old entry means "no drop survived 5-minute smoothing," not a guarantee nothing happened.
- `/api/wallet` uses the public Solana RPC (no key, to keep the zero-dependency promise), which can be slower or rate-limited than a paid RPC under heavy use. It estimates entry time from on-chain history, not from a stored purchase price/time — a token bought and sold multiple times in the same wallet gets the oldest transaction still visible in its recent history, which may not match what you'd consider "my current position's entry."
- This is a read-only research tool, not trading advice, and it doesn't execute anything on-chain.

## Origin

Extracted from `creatorLedger.js`, a module inside a live Solana memecoin trading bot that trades real (small) capital. The underlying research — rug timing, dev-buy thresholds, batch-deploy detection — comes from measuring real executed fills, not simulated backtests.
