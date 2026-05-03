import { rawPriceFromSqrtX96, priceWethPerToken } from './v4.js';

// Base mainnet: block 0 at 2023-06-15 12:35:47 UTC = unix 1686789347. Block time = 2s.
// Verified empirically — drift is at most ~1s over millions of blocks.
const BASE_GENESIS_TS = 1686789347;
const BASE_BLOCK_TIME = 2;

// Compute timestamps locally for a list of blocks. Optionally calibrate against a real
// block (single RPC call) to absorb any genesis-offset drift.
export async function fetchBlockTimestamps(rpc, blocks, _concurrency, { calibrate = true } = {}) {
  const map = new Map();
  let offset = 0;
  if (calibrate && blocks.length > 0) {
    const sample = blocks[Math.floor(blocks.length / 2)];
    try {
      const blk = await rpc.getBlock(sample, false);
      if (blk) {
        const realTs = parseInt(blk.timestamp, 16);
        const predictedTs = BASE_GENESIS_TS + sample * BASE_BLOCK_TIME;
        offset = realTs - predictedTs;
      }
    } catch { /* drift will stay 0 */ }
  }
  for (const n of blocks) map.set(n, BASE_GENESIS_TS + n * BASE_BLOCK_TIME + offset);
  return map;
}

export function swapsToTrades(swaps, init, tokenAddress, decimalsToken, blockTs) {
  const isToken0 = init.currency0.toLowerCase() === tokenAddress.toLowerCase();
  const orientation = isToken0 ? 'token0' : 'token1';
  const wethDecimals = 18;
  return swaps.map(s => {
    const raw = rawPriceFromSqrtX96(s.sqrtPriceX96);
    const priceWeth = priceWethPerToken(raw, orientation, decimalsToken, wethDecimals);
    const a0 = s.amount0;
    const a1 = s.amount1;
    const tokenAmount = isToken0 ? a0 : a1;
    const wethAmount  = isToken0 ? a1 : a0;
    const side = tokenAmount > 0n ? 'sell' : 'buy';
    const tokenAbs = tokenAmount < 0n ? -tokenAmount : tokenAmount;
    const wethAbs  = wethAmount  < 0n ? -wethAmount  : wethAmount;
    const tokenAmt = Number(tokenAbs) / 10 ** decimalsToken;
    const wethAmt  = Number(wethAbs)  / 10 ** wethDecimals;
    return {
      block: s.block,
      tx: s.tx,
      ts: blockTs.get(s.block) || 0,
      priceWeth,
      tokenAmt,
      wethAmt,
      side,
      sender: s.sender,
      tick: s.tick,
      fee: s.fee,
    };
  });
}

export function buildCandles(trades, interval) {
  if (trades.length === 0) return [];
  const buckets = new Map();
  for (const t of trades) {
    if (!t.ts) continue;
    const b = Math.floor(t.ts / interval) * interval;
    let c = buckets.get(b);
    if (!c) {
      c = { time: b, open: t.priceWeth, high: t.priceWeth, low: t.priceWeth, close: t.priceWeth, volume: 0, trades: 0, buys: 0, sells: 0 };
      buckets.set(b, c);
    }
    c.high = Math.max(c.high, t.priceWeth);
    c.low  = Math.min(c.low,  t.priceWeth);
    c.close = t.priceWeth;
    c.volume += t.wethAmt;
    c.trades++;
    if (t.side === 'buy') c.buys++; else c.sells++;
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

export function findPivots(candles, lookback = 5) {
  const highs = [];
  const lows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    let isHigh = true, isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].high >= c.high || candles[i + j].high >= c.high) isHigh = false;
      if (candles[i - j].low  <= c.low  || candles[i + j].low  <= c.low)  isLow  = false;
    }
    if (isHigh) highs.push({ time: c.time, price: c.high });
    if (isLow)  lows.push({ time: c.time, price: c.low });
  }
  return { highs, lows };
}

export function volumeProfile(candles, bins = 30) {
  if (candles.length === 0) return null;
  let lo = Infinity, hi = -Infinity;
  for (const c of candles) { lo = Math.min(lo, c.low); hi = Math.max(hi, c.high); }
  if (!isFinite(lo) || !isFinite(hi) || hi <= lo) return null;
  const span = hi - lo;
  const binW = span / bins;
  const arr = Array.from({ length: bins }, (_, i) => ({
    priceLow: lo + i * binW,
    priceHigh: lo + (i + 1) * binW,
    volume: 0,
  }));
  for (const c of candles) {
    const mid = (c.high + c.low) / 2;
    const idx = Math.min(bins - 1, Math.max(0, Math.floor((mid - lo) / binW)));
    arr[idx].volume += c.volume;
  }
  let pocIdx = 0;
  for (let i = 1; i < arr.length; i++) if (arr[i].volume > arr[pocIdx].volume) pocIdx = i;
  return { bins: arr, poc: arr[pocIdx] };
}
