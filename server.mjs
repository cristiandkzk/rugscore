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

// --- Risk / Why / Survival (11/9/2026) -----------------------------------
// The gate above was already PASS/FLAG. This adds the 3-piece explainable
// shape suggested during pitch review (RISK probability, WHY evidence,
// SURVIVAL time-to-resolution) -- but honestly, not by inventing a
// differentiated per-token score. We tested 7-8 candidate variables against
// real outcomes over several nights; only 2 survived: creator reputation
// (moves EV, not rug probability) and initial post-migration size (moves
// timing/magnitude, not rug probability either). Rug probability itself
// doesn't discriminate on ANYTHING we tried -- it's a flat category base
// rate. So RISK stays a flat, honest number; WHY and SURVIVAL carry the 2
// signals that actually do explain something, and neither of them changes
// RISK's value for any given mint.
const RISK = {
  basePct: 95.6,
  conditionedOn: 'reaches a real post-migration price peak and resolves (crash >=80% from peak, or bounces back) -- not "any graduation," and not tokens still too new to have resolved either way',
  n: 30984,
  rangeAcrossCuts: '89.2%-98.2% across every size decile and reputation bucket tested -- nothing we measured moves this number outside that band',
  externalValidation: {
    source: 'Slinky21/Pumpfun_Memecoin_Corpus (HuggingFace) -- an independently collected corpus, different 39-day window, unrelated team/pipeline',
    pct: 95.05,
    n: 4727,
  },
  note: 'This is a category base rate, not a per-token differentiated score. Creator reputation and initial size (see `why` below) do NOT move this number -- they explain EV and timing instead, which is why they live in `why`/`survival`, not here.',
};
// EV by reputation bucket, same 2 independent date-split halves as the gate
// itself (see README) -- n=11,495 real graduations.
const REPUTATION_EV = {
  n: 11495,
  passesEvPct: [13.1, 7.5],
  flaggedEvPct: [4.3, 6.4],
  note: 'Expected value by reputation bucket across 2 independent date-split halves of 11,495 real graduations. This is what reputation actually predicts -- not rug probability (see `risk` above), EV.',
};
// Size-decile table: initial post-migration price in SOL (supply-invariant,
// same field as safety.js/creatorLedger.js) crossed against REAL hold time
// and REAL net return -- see data/size-decile-timing.json for methodology.
const SIZE_DECILE = JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'size-decile-timing.json'), 'utf8'));

// Classifies a live priceNative (SOL) into the historical decile whose
// range it falls in. Deciles are sorted ascending by minInitialPriceSol;
// decile 10 has no upper bound (open-ended top bucket) and decile 1 catches
// anything below decile 2's floor.
function classifySizeDecile(priceSol) {
  if (typeof priceSol !== 'number' || !(priceSol > 0)) return null;
  const table = SIZE_DECILE.decileTable;
  let match = table[0];
  for (const row of table) {
    if (priceSol >= row.minInitialPriceSol) match = row;
    else break;
  }
  return match;
}

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
      priceNativeSol: pair.priceNative ? Number(pair.priceNative) : null,
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

// --- Post-trade guard (10/9/2026) ---------------------------------------
// rugscore was entry-only: check a mint BEFORE you buy. This closes the
// other half — while you're holding, has this token shown the exact
// pattern that historically precedes a bad outcome?
//
// The gate: a single-candle price drop >= TRIGGER_DROP_PCT since you
// entered. Threshold and the stats below are not guesses — they're the
// same ones already live in the trading bot's rug guard
// (GRAD_RUG_SELL_PCT_LIQ=8), re-tested the night of 9/9-10/9/2026 against
// 42,645 real executed fills (grad-social-shadow.jsonl, not backtests):
// positions that saw this pattern and were held anyway averaged −31.5%,
// vs −24.4% for positions that never saw it. The gap grows with the
// threshold (7.1pp at 8%, up to 22.8pp at 20%) — holding through a big
// single-tick drop rarely pays off, no matter how lenient the bar.
const TRIGGER_DROP_PCT = 8;
const REAL_FILL_STATS = { n: 42645, nTriggered: 31557, avgNetRetWithTriggerPct: -31.5, avgNetRetWithoutTriggerPct: -24.4, gapPct: 7.1 };
const GECKO_BASE = 'https://api.geckoterminal.com/api/v2';

// Resolves the highest-liquidity Solana pool for a mint. Same call the bot
// uses (src/providers/geckoterminal.js:topPool) — free, no key, real OHLCV.
async function resolveGeckoPool(mint) {
  try {
    const res = await fetch(`${GECKO_BASE}/networks/solana/tokens/${mint}/pools`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    const pools = (data?.data || [])
      .map((p) => ({ addr: p.attributes?.address, liq: Number(p.attributes?.reserve_in_usd) || 0 }))
      .filter((p) => p.addr)
      .sort((a, b) => b.liq - a.liq);
    return pools[0]?.addr || null;
  } catch {
    return null;
  }
}

// 1-minute candles for shorter windows, 5-minute for longer ones (keeps the
// candle count sane — GeckoTerminal's free tier is the bot's own budget,
// separate from this server's).
//
// Honest limit: the 8% threshold was validated against 30-second price
// ticks. 1-minute candles are close to that; 5-minute candles (windows
// over ~8h) can smooth out a fast crash that recovers within the same
// candle, so this tool is MORE conservative (under-triggers) the older
// your entry point is. A "triggered: false" on an old entry means "no
// drop survived 5-minute smoothing," not "definitely safe."
async function fetchGuardCandles(poolAddr, sinceMinutes) {
  const aggregate = sinceMinutes <= 500 ? 1 : 5;
  const limit = Math.min(500, Math.ceil(sinceMinutes / aggregate) + 2);
  try {
    const res = await fetch(`${GECKO_BASE}/networks/solana/pools/${poolAddr}/ohlcv/minute?aggregate=${aggregate}&limit=${limit}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = await res.json();
    const list = data?.data?.attributes?.ohlcv_list || []; // [ts, o, h, l, c, vol], descending
    return list.map((c) => ({ t: c[0], close: c[4] })).sort((a, b) => a.t - b.t);
  } catch {
    return [];
  }
}

// Worst close-to-close drop found, same method as the validation (tick-to-
// tick, not intra-candle high/low — stays faithful to what was measured).
function worstDrop(candles) {
  let worst = 0;
  for (let i = 1; i < candles.length; i++) {
    const drop = (1 - candles[i].close / candles[i - 1].close) * 100;
    if (drop > worst) worst = drop;
  }
  return worst;
}

// Shared by /api/guard and /api/wallet: given a mint and how long ago you
// entered, has it shown the single-candle drop pattern since then? Extracted
// (10/9/2026) so the wallet auto-check can run the identical logic per held
// token instead of duplicating it.
async function buildGuardResult(mint, sinceMinutes) {
  const pool = await resolveGeckoPool(mint);
  if (!pool) {
    return { mint, sinceMinutes, triggered: null, note: 'No indexed pool found for this mint (too new, too illiquid, or not on Solana).' };
  }
  const candles = await fetchGuardCandles(pool, sinceMinutes);
  if (candles.length < 2) {
    return { mint, sinceMinutes, triggered: null, note: 'Pool found but not enough price history yet to check.' };
  }
  const drop = worstDrop(candles);
  const triggered = drop >= TRIGGER_DROP_PCT;
  const candleMinutes = sinceMinutes <= 500 ? 1 : 5;
  return {
    mint,
    sinceMinutes,
    triggered,
    worstSingleCandleDropPct: Math.round(drop * 10) / 10,
    thresholdPct: TRIGGER_DROP_PCT,
    candleResolutionMinutes: candleMinutes,
    candleResolutionNote: candleMinutes > 1
      ? `Checked at ${candleMinutes}-minute resolution (validation used 30-second ticks) — a fast crash that recovered within one candle could be smoothed out. A "false" here means "no drop survived that smoothing," not a guarantee.`
      : null,
    recommendation: triggered
      ? `A single-candle drop of ${drop.toFixed(1)}% was seen since you entered — that matches the pattern the gate watches for. Historically, positions held through this averaged ${REAL_FILL_STATS.avgNetRetWithTriggerPct}% vs ${REAL_FILL_STATS.avgNetRetWithoutTriggerPct}% for positions that never saw it. Consider exiting.`
      : `No single-candle drop past ${TRIGGER_DROP_PCT}% seen in the last ${sinceMinutes} minute(s). No historical basis to recommend exiting on this signal alone.`,
    methodology: `Threshold and stats are the live trading bot's own rug guard (GRAD_RUG_SELL_PCT_LIQ), re-validated 9/9-10/9/2026 against ${REAL_FILL_STATS.n.toLocaleString()} real executed fills — not backtests. ${REAL_FILL_STATS.nTriggered.toLocaleString()} of those saw this exact pattern.`,
  };
}

// --- Wallet auto-check (10/9/2026) --------------------------------------
// Reads a wallet's current SPL token holdings and, for each, estimates when
// it was acquired from that token account's own on-chain history -- then
// runs the exact same guard check per token, no manual mint-pasting. Public
// Solana RPC, no key: keeps the "zero API keys" promise, at the cost of
// being slower/less reliable than a paid RPC under load (same honest-caveat
// spirit as candleResolutionNote above).
const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const MAX_WALLET_TOKENS = 15;
const SIG_HISTORY_LIMIT = 25;

async function rpcCall(method, params) {
  try {
    const res = await fetch(SOLANA_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.result ?? null;
  } catch {
    return null;
  }
}

// Current holdings only (a balance snapshot, not history). Returns null if
// the RPC was unreachable entirely (distinct from a genuinely empty wallet,
// which returns []). Prioritizes mints we already have reputation data for,
// in case the wallet holds more than MAX_WALLET_TOKENS.
async function fetchWalletTokens(address) {
  const [classic, token2022] = await Promise.all([
    rpcCall('getTokenAccountsByOwner', [address, { programId: TOKEN_PROGRAM_ID }, { encoding: 'jsonParsed' }]),
    rpcCall('getTokenAccountsByOwner', [address, { programId: TOKEN_2022_PROGRAM_ID }, { encoding: 'jsonParsed' }]),
  ]);
  if (classic === null && token2022 === null) return null;
  const accounts = [...(classic?.value || []), ...(token2022?.value || [])];
  const held = [];
  for (const acc of accounts) {
    const info = acc.account?.data?.parsed?.info;
    const amount = info?.tokenAmount?.uiAmount;
    if (!info?.mint || !amount || amount <= 0) continue;
    held.push({ mint: info.mint, tokenAccount: acc.pubkey, amount });
  }
  held.sort((a, b) => (index.has(b.mint) ? 1 : 0) - (index.has(a.mint) ? 1 : 0));
  return held;
}

// Approximates "when did this wallet acquire this token" from the token
// account's own transaction history (oldest signature in the most recent
// SIG_HISTORY_LIMIT). If the account has MORE history than that page covers,
// `truncated: true` — the real entry is older than what we found here, so
// the guard below checks a NARROWER window than the true hold (under-
// triggers, same direction as candleResolutionNote, not a new failure mode).
async function estimateEntryTime(tokenAccount) {
  const sigs = await rpcCall('getSignaturesForAddress', [tokenAccount, { limit: SIG_HISTORY_LIMIT }]);
  if (!sigs || sigs.length === 0) return null;
  const oldest = sigs[sigs.length - 1];
  if (!oldest.blockTime) return null;
  return { approxEntryMs: oldest.blockTime * 1000, truncated: sigs.length === SIG_HISTORY_LIMIT };
}

// Builds `why` (evidence for EV and timing/magnitude) and `survival` (real
// hold-time expectation by size decile). Both are population statistics --
// neither claims to predict THIS token individually, and neither changes
// `risk` (see RISK.note above).
function buildWhy(rep, priceNativeSol) {
  const why = {};
  if (rep) {
    const passes = rep.priorCount <= 0 && !rep.batch && rep.devBuySol <= 0.5;
    why.reputation = {
      bucket: passes ? 'PASSES' : 'FLAGGED',
      evPct: passes ? REPUTATION_EV.passesEvPct : REPUTATION_EV.flaggedEvPct,
      n: REPUTATION_EV.n,
      note: REPUTATION_EV.note,
    };
  }
  const decile = classifySizeDecile(priceNativeSol);
  if (decile) {
    why.initialSize = {
      decile: decile.decile,
      priceNativeSol,
      n: decile.n,
      realHoldMinMedian: decile.holdMinMedian,
      realNetRetMedianPct: decile.netRetMedianPct,
      realNetRetMeanPct: decile.netRetMeanPct,
      note: 'Bigger initial post-migration size correlates with a longer real hold time and a milder real return -- decile 10 is the only one where the median real return turns positive (mean stays negative: a few large winners, not most of the decile). Rug rate itself does not vary by decile (see risk.rangeAcrossCuts).',
    };
  }
  return why;
}

function buildSurvival(priceNativeSol) {
  const decile = classifySizeDecile(priceNativeSol);
  if (!decile) {
    return { known: false, note: 'No live SOL-denominated price available for this mint (no active DEX pool) -- cannot place it in a size decile.' };
  }
  return {
    known: true,
    decile: decile.decile,
    n: decile.n,
    expectedHoldMinMedian: decile.holdMinMedian,
    methodology: 'Median REAL hold time (grad-social-shadow.jsonl, realFill=true) for positions in this size decile, exited under the trading bot\'s own trailing-stop/hard-stop/time-stop logic -- not a theoretical "time until this token crashes," and not a per-token prediction. Tokens in smaller deciles get stopped out in ~2-4 minutes; decile 10 (largest) holds a median of 36 minutes.',
  };
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
      const priceNativeSol = dex?.priceNativeSol ?? null;
      return json(res, 200, {
        mint,
        reputation: reputationVerdict(rep),
        market,
        risk: RISK,
        why: buildWhy(rep, priceNativeSol),
        survival: buildSurvival(priceNativeSol),
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/guard') {
      const mint = (url.searchParams.get('mint') || '').trim();
      const sinceMinutesRaw = Number(url.searchParams.get('sinceMinutes'));
      if (!mint) return json(res, 400, { error: 'missing ?mint=' });
      if (!Number.isFinite(sinceMinutesRaw) || sinceMinutesRaw <= 0) return json(res, 400, { error: 'missing or invalid ?sinceMinutes= (how long ago you entered, in minutes)' });
      const sinceMinutes = Math.min(2880, Math.round(sinceMinutesRaw));
      return json(res, 200, await buildGuardResult(mint, sinceMinutes));
    }
    if (req.method === 'GET' && url.pathname === '/api/wallet') {
      const address = (url.searchParams.get('address') || '').trim();
      if (!address) return json(res, 400, { error: 'missing ?address=' });
      const held = await fetchWalletTokens(address);
      if (held === null) {
        return json(res, 200, { address, error: 'Could not read this wallet from the public Solana RPC right now (rate-limited or unreachable) — try again in a moment.' });
      }
      const capped = held.slice(0, MAX_WALLET_TOKENS);
      const results = [];
      for (const t of capped) {
        const reputation = reputationVerdict(index.get(t.mint) || null);
        const entry = await estimateEntryTime(t.tokenAccount);
        let guard = null, guardNote = null;
        if (!entry) {
          guardNote = 'No on-chain history found yet for this token account — too new, or the public RPC did not return signatures just now.';
        } else {
          const sinceMinutes = Math.max(1, Math.min(2880, Math.round((Date.now() - entry.approxEntryMs) / 60000)));
          guard = await buildGuardResult(t.mint, sinceMinutes);
        }
        results.push({ mint: t.mint, amount: t.amount, reputation, guard, guardNote, entryTimeApprox: entry?.truncated ?? null });
      }
      return json(res, 200, { address, tokensHeld: held.length, tokensChecked: capped.length, results });
    }
    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`rugscore listening on http://localhost:${PORT}`);
});
