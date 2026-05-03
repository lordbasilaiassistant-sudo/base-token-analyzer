// NOT FINANCIAL ADVICE. Mechanical heuristics over candle data.

function median(values) {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const pct = (a, b) => ((a - b) / b) * 100;

export function estimateRoundTrip({ tradeSizeUsd = 100, poolFeeBps = 3000, liquidityUsd = 0, baseGasUsd = 0.005 }) {
  const feePct = (poolFeeBps / 1_000_000) * 2 * 100;
  const slipPct = liquidityUsd > 0 ? (tradeSizeUsd / liquidityUsd) * 100 * 2 : 0;
  const gasPct = (baseGasUsd * 2 / tradeSizeUsd) * 100;
  const totalPct = feePct + slipPct + gasPct;
  return {
    feePct: +feePct.toFixed(4),
    slippagePct: +slipPct.toFixed(4),
    gasPct: +gasPct.toFixed(4),
    totalPct: +totalPct.toFixed(4),
    breakdown: `pool ${feePct.toFixed(3)}%  slippage ${slipPct.toFixed(3)}%  gas ${gasPct.toFixed(3)}%`,
  };
}

export function generateSignals({ candles, pivots, profile, currentPriceWeth, dexscreener, init, decimalsToken, effectiveFeeBps }) {
  const last = candles[candles.length - 1];
  if (!last) return { state: 'NO_DATA', reasons: ['No candle data yet'], buyZone: null, takeProfit: null, stop: null, roundTrip: null };
  const current = currentPriceWeth || last.close;

  const window = candles.slice(-168);
  const w7lo = window.reduce((m, c) => Math.min(m, c.low), Infinity);
  const w7hi = window.reduce((m, c) => Math.max(m, c.high), -Infinity);
  const med  = median(window.map(c => c.close));

  const lowsBelow  = pivots.lows.filter(p => p.price < current).sort((a, b) => b.price - a.price);
  const highsAbove = pivots.highs.filter(p => p.price > current).sort((a, b) => a.price - b.price);
  const supports    = lowsBelow.slice(0, 2).map(p => p.price);
  const resistances = highsAbove.slice(0, 3).map(p => p.price);
  const poc = profile && profile.poc ? (profile.poc.priceLow + profile.poc.priceHigh) / 2 : null;

  const liqUsd = dexscreener?.liquidityUsd || 0;
  const initFee = init?.fee ?? 3000;
  const dynamicFee = (initFee & 0x800000) !== 0;
  const fee = (dynamicFee || effectiveFeeBps) ? (effectiveFeeBps ?? 10_000) : initFee;
  const rt100 = estimateRoundTrip({ tradeSizeUsd: 100,  poolFeeBps: fee, liquidityUsd: liqUsd });
  const rt500 = estimateRoundTrip({ tradeSizeUsd: 500,  poolFeeBps: fee, liquidityUsd: liqUsd });
  const rt1k  = estimateRoundTrip({ tradeSizeUsd: 1000, poolFeeBps: fee, liquidityUsd: liqUsd });

  const breakEvenPct = rt100.totalPct;
  const minEdgePrice = current * (1 + breakEvenPct / 100);

  const buyHi = supports[0] || current * 0.98;
  const buyLo = Math.max(supports[1] || w7lo, buyHi * 0.92);
  const buyZone = [Math.min(buyLo, buyHi), Math.max(buyLo, buyHi)];

  const tp1 = resistances[0] || current * 1.10;
  const tp2 = resistances[1] || Math.max(tp1 * 1.10, w7hi);
  const tp3 = resistances[2] || tp2 * 1.20;

  const stop = supports[0] ? supports[0] * 0.95 : Math.min(w7lo * 0.95, buyZone[0] * 0.95);

  const reasons = [];
  let state = 'WATCH';
  const distanceToBuyHi = pct(current, buyZone[1]);
  const distanceToTp1   = pct(tp1, current);

  if (current <= buyZone[1] && current >= buyZone[0]) {
    state = 'BUY';
    reasons.push(`Price in buy zone ${buyZone[0].toExponential(3)} – ${buyZone[1].toExponential(3)} WETH`);
    reasons.push(`Round-trip cost on $100 trade: ${rt100.totalPct}% (${rt100.breakdown})`);
    if (distanceToTp1 > breakEvenPct * 1.5) reasons.push(`TP1 sits ${distanceToTp1.toFixed(1)}% up — clears round-trip ${breakEvenPct}% with margin`);
    else { state = 'WATCH'; reasons.push(`TP1 only ${distanceToTp1.toFixed(1)}% up, smaller than 1.5× round-trip — wait for deeper dip`); }
  } else if (current < buyZone[0]) {
    state = 'BUY';
    reasons.push(`Price BELOW buy zone — aggressive accumulation if liquidity supports it`);
    reasons.push(`But check: liquidity $${liqUsd.toFixed(0)} — exit slippage on $1k = ${rt1k.slippagePct}%`);
    if (liqUsd < 5000) { state = 'AVOID'; reasons.push(`Liquidity below $5k — exit will be expensive`); }
  } else if (current >= tp3) {
    state = 'SELL';
    reasons.push(`Above TP3 ${tp3.toExponential(3)} — fully exited zone`);
  } else if (current >= tp1) {
    state = 'TAKE_PROFIT';
    reasons.push(`Past TP1 ${tp1.toExponential(3)} — scale out 33-50%`);
    reasons.push(`Next target TP2 ${tp2.toExponential(3)} (+${pct(tp2, current).toFixed(1)}%)`);
  } else {
    state = 'HOLD';
    reasons.push(`Price between buy zone top (+${distanceToBuyHi.toFixed(1)}%) and TP1 — let positions run`);
  }

  if (liqUsd > 0 && liqUsd < 2000) {
    reasons.push(`WARNING: pool liquidity $${liqUsd.toFixed(0)} — round-trip slippage on $500 = ${rt500.slippagePct}%`);
    if (state === 'BUY') state = 'AVOID';
  }
  if (dynamicFee) {
    reasons.push(`Dynamic-fee pool — using ${effectiveFeeBps ? 'median per-swap fee from history' : 'fallback 1.0%'} = ${(fee / 10_000).toFixed(2)}%. Real fee varies per swap.`);
  }
  const v24 = dexscreener?.volume24h || 0;
  const v1h = dexscreener?.volume1h  || 0;
  if (v24 > 0 && v1h > 0 && v1h / v24 > 0.5) reasons.push(`Volume spiking: last hour = ${(v1h / v24 * 100).toFixed(0)}% of 24h volume`);
  if (v24 < 100) reasons.push(`Low 24h volume ($${v24.toFixed(0)}) — illiquid, expect wider spreads`);

  return {
    state, reasons,
    current,
    buyZone,
    takeProfit: { tp1, tp2, tp3 },
    stop,
    supports, resistances, poc,
    weeklyHigh: w7hi, weeklyLow: w7lo, median7d: med,
    minEdgePrice,
    roundTrip: { trade100: rt100, trade500: rt500, trade1000: rt1k },
    poolFeeBps: fee,
  };
}
