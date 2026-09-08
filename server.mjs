#!/usr/bin/env node
// rugscore — deterministic risk gate for pump.fun graduations.
// Zero dependencies: node:http + fetch (Node >=18). No API keys required.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;

// Validated gate thresholds, reused as-is from the live trading bot
// (src/core/config.js: GRAD_CREATOR_MAX_PRIOR=0, GRAD_CREATOR_MAX_DEVBUY_SOL=0.5).
// Measured on 11,495 real graduations, two independent date-split halves:
// prior==0 & devBuy<=0.5 SOL -> EV +13.1%/+7.5% vs +4.3%/+6.4% otherwise.
const MAX_PRIOR = 0;
const MAX_DEVBUY_SOL = 0.5;

console.log('Loading historical creator-reputation index...');
const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'creator-ledger-agg.json'), 'utf8'));
const index = new Map(raw.map((r) => [r.mint, r]));
console.log(`Indexed ${index.size} graduated mints (Jun 10 - Sep 1 2026, 84 days).`);

// Same helper as the live bot (src/ai/aiscorer.js:fetchDexData), copied
// standalone: DexScreener public API, no key needed, works for any mint
// with a live DEX pool.
function pickSolPair(pairs) {
  const solPairs = (pairs || []).filter(
    (p) => p.quoteToken?.symbol === 'SOL' || p.quoteToken?.address === 'So11111111111111111111111111111111111111112',
  );
  if (solPairs.length <= 1) return solPairs[0] || null;
  const activity = (p) => (p.txns?.m5?.buys || 0) + (p.txns?.m5?.sells || 0);
  const active = solPairs.filter((p) => activity(p) > 0);
  const pool = active.length > 0 ? active : solPairs;
  return pool.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
}

async function fetchDexData(mint) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    const pair = pickSolPair(data.pairs);
    if (!pair) return null;
    const buys5m = pair.txns?.m5?.buys ?? 0;
    const sells5m = pair.txns?.m5?.sells ?? 0;
    return {
      liquidityUsd: Math.round(pair.liquidity?.usd || 0),
      mcapUsd: Math.round(pair.marketCap || pair.fdv || 0),
      volume5mUsd: Math.round(pair.volume?.m5 || 0),
      buys5m,
      sells5m,
      priceChangePct5m: pair.priceChange?.m5 ?? null,
    };
  } catch {
    return null;
  }
}

// Fallback for tokens that haven't migrated to a DEX pool yet: DexScreener
// has nothing for those (no pool exists), but pump.fun's own API still
// tracks their bonding-curve market cap. Same endpoint flashrug-guard (a
// companion extension) already uses for its drawdown-from-ATH check.
async function fetchPumpFunCoin(mint) {
  try {
    const res = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const coin = await res.json();
    if (typeof coin?.usd_market_cap !== 'number') return null;
    const athAgeMin = coin.ath_market_cap_timestamp ? (Date.now() - coin.ath_market_cap_timestamp) / 60000 : null;
    return {
      stage: coin.complete ? 'graduated_unindexed' : 'bonding_curve',
      complete: !!coin.complete,
      marketCapUsd: Math.round(coin.usd_market_cap),
      athMarketCapUsd: typeof coin.ath_market_cap === 'number' ? Math.round(coin.ath_market_cap) : null,
      athAgeMin: athAgeMin != null ? Math.round(athAgeMin) : null,
    };
  } catch {
    return null;
  }
}

function reputationVerdict(rep) {
  if (!rep) {
    return {
      known: false,
      verdict: 'DESCONOCIDO',
      reasons: ['This mint is outside our 84-day historical window, or we never saw its create event.'],
    };
  }
  const reasons = [];
  if (rep.priorCount > MAX_PRIOR) reasons.push(`Creator wallet had ${rep.priorCount} prior token launches (validated gate requires 0).`);
  if (rep.batch) reasons.push('Creator deployed this token within 60s of another one (batch-deploy pattern).');
  if (rep.devBuySol > MAX_DEVBUY_SOL) reasons.push(`Dev-buy was ${rep.devBuySol} SOL (validated gate flags >0.5 SOL: correlates with worse post-graduation entries).`);
  const passes = reasons.length === 0;
  return {
    known: true,
    verdict: passes ? 'PASSES' : 'FLAGGED',
    reasons: passes ? ['Creator is first-time (prior==0), no batch-deploy, dev-buy <= 0.5 SOL — matches the validated gate.'] : reasons,
    priorGraduatedBefore: rep.priorGrad,
    priorGradNote: rep.priorGrad ? 'Creator had already graduated another token before this create (measured 5.3x grad-rate lift vs the rest of the gated pool).' : null,
    raw: rep,
  };
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(DIR, 'public', 'index.html')));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/stats') {
      return json(res, 200, { indexedMints: index.size, windowDays: 84, windowStart: '2026-06-10', windowEnd: '2026-09-01' });
    }
    if (req.method === 'GET' && url.pathname === '/api/score') {
      const mint = (url.searchParams.get('mint') || '').trim();
      if (!mint) return json(res, 400, { error: 'missing ?mint=' });
      const rep = index.get(mint) || null;
      const dex = await fetchDexData(mint);
      let market = dex;
      if (!market) {
        const curve = await fetchPumpFunCoin(mint);
        market = curve
          ? { ...curve, note: curve.complete ? 'Graduated, but DexScreener has no active pool for it (likely dead or delisted liquidity).' : 'Still on the pump.fun bonding curve — no DEX pool exists yet, so liquidity data does not apply.' }
          : { note: 'No live data found on DexScreener or pump.fun for this mint. Check the address, or it may be too old/delisted.' };
      }
      return json(res, 200, {
        mint,
        reputation: reputationVerdict(rep),
        market,
      });
    }
    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`rugscore listening on http://localhost:${PORT}`);
});
