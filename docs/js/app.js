// Main controller — wires the form to the analysis pipeline and renders results.

import { RpcAgg, BASE_CHAIN_ID } from './rpc.js';
import { readMetadata } from './token.js';
import { crawlTransfers, buildHolderMap, concentration } from './transfers.js';
import { findInitialize, crawlSwaps, isDynamicFee } from './v4.js';
import { fetchToken, pickBestPair, summarizePair } from './dexscreener.js';
import { fetchBlockTimestamps, swapsToTrades, buildCandles, findPivots, volumeProfile } from './ohlc.js';
import { generateSignals } from './signal.js';
import { PRESETS } from './presets.js';

const $ = (id) => document.getElementById(id);
const isAddress = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);
const isPoolId  = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s);

const fmtUsd = (n) => n == null ? '—' : `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const fmtPct = (n) => n == null ? '—' : `${Number(n).toFixed(2)}%`;
function fmtPrice(p) {
  if (p == null || !isFinite(p)) return '—';
  if (p >= 1) return p.toFixed(6);
  if (p >= 0.0001) return p.toFixed(8);
  return p.toExponential(4);
}
const escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

let state = { running: false, lastReport: null, chart: null, candleSeries: null, volumeSeries: null };

function log(msg) {
  const el = $('progress');
  el.classList.remove('hidden');
  const ts = new Date().toLocaleTimeString();
  el.textContent += `[${ts}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

function showError(msg) {
  const el = $('error');
  el.classList.remove('hidden');
  el.textContent = msg;
}

function clearError() {
  $('error').classList.add('hidden');
  $('error').textContent = '';
}

function clearProgress() {
  $('progress').classList.add('hidden');
  $('progress').textContent = '';
}

// ---- Preset wiring ----
function applyPreset(id) {
  if (id === 'custom') return;
  const p = PRESETS[id];
  if (!p) return;
  $('tokenInput').value = p.token;
  $('poolInput').value = p.poolId || '';
  $('fromBlockInput').value = p.fromBlock || 0;
}

$('preset').addEventListener('change', (e) => applyPreset(e.target.value));

// If user manually edits inputs after picking a preset, switch to "Custom"
['tokenInput', 'poolInput', 'fromBlockInput'].forEach(id => {
  $(id).addEventListener('input', () => {
    const sel = $('preset');
    if (sel.value !== 'custom') sel.value = 'custom';
  });
});

// ---- Analyze ----
$('analyzeBtn').addEventListener('click', () => {
  if (state.running) return;
  runAnalyze().catch(err => {
    console.error(err);
    showError(`Analyze failed: ${err.message}`);
  }).finally(() => {
    state.running = false;
    $('analyzeBtn').disabled = false;
    $('analyzeBtn').textContent = 'Analyze';
  });
});

async function runAnalyze() {
  clearError();
  clearProgress();
  state.running = true;
  $('analyzeBtn').disabled = true;
  $('analyzeBtn').textContent = 'Analyzing…';

  const token = $('tokenInput').value.trim();
  const poolId = $('poolInput').value.trim();
  const candleInterval = parseInt($('candleSelect').value, 10);
  const fromBlock = parseInt($('fromBlockInput').value || '0', 10);
  const tradeSize = parseInt($('tradeSizeInput').value || '100', 10);
  const maxSwaps = parseInt($('maxSwapsInput').value || '5000', 10);

  if (!isAddress(token))     throw new Error(`Invalid token address: ${token}`);
  if (poolId && !isPoolId(poolId)) throw new Error(`Invalid V4 poolId (need 0x + 64 hex): ${poolId}`);

  const rpc = new RpcAgg();
  log('Connecting to Base mainnet RPCs…');
  const chainId = await rpc.getChainId();
  if (chainId !== BASE_CHAIN_ID) throw new Error(`Connected to chain ${chainId}, expected Base (${BASE_CHAIN_ID})`);
  const latestBlock = await rpc.getBlockNumber();
  log(`Latest block: ${latestBlock}`);

  log(`Reading metadata for ${token}…`);
  const meta = await readMetadata(rpc, token);
  log(`  ${meta.symbol || '?'} (${meta.name || '?'}) · decimals ${meta.decimals} · supply ${meta.totalSupplyFmt}`);

  log(`Crawling Transfer logs ${fromBlock} → ${latestBlock}…`);
  const transfers = await crawlTransfers(rpc, token, fromBlock, latestBlock, ({ to, total }) => {
    if (total > 0 && total % 1000 === 0) log(`  ${total} transfers · @ block ${to}`);
  });
  log(`  Got ${transfers.length} transfers`);
  const holderMap = buildHolderMap(transfers, meta.decimals);
  const conc = concentration(holderMap.holders, meta.totalSupply);

  let init = null, swaps = [], trades = [], candles = [], pivots = { highs: [], lows: [] }, profile = null;
  if (poolId) {
    log(`Looking up V4 Initialize for ${poolId.slice(0, 18)}…`);
    init = await findInitialize(rpc, poolId, fromBlock, latestBlock);
    if (init) {
      log(`  init at block ${init.block}, fee ${init.fee}${isDynamicFee(init.fee) ? ' (DYNAMIC)' : ''}`);
      log(`Crawling V4 Swap logs…`);
      const allSwaps = await crawlSwaps(rpc, poolId, init.block, latestBlock, ({ to, total }) => {
        if (total > 0 && total % 500 === 0) log(`  ${total} swaps · @ block ${to}`);
      });
      log(`  Got ${allSwaps.length} swaps total`);
      swaps = allSwaps.length > maxSwaps ? allSwaps.slice(-maxSwaps) : allSwaps;
      if (allSwaps.length > maxSwaps) log(`  Trimmed to last ${maxSwaps} swaps for performance`);
      const uniqueBlocks = new Set(swaps.map(s => s.block));
      log(`Fetching block timestamps for ${uniqueBlocks.size} unique blocks…`);
      const blockTs = await fetchBlockTimestamps(rpc, [...uniqueBlocks], 8);
      trades = swapsToTrades(swaps, init, token, meta.decimals, blockTs);
      candles = buildCandles(trades, candleInterval);
      pivots = findPivots(candles, 3);
      profile = volumeProfile(candles, 30);
      log(`  ${candles.length} candles built`);
    } else {
      log('  No Initialize event found for this poolId — skipping V4 swap data');
    }
  }

  log('Fetching DexScreener snapshot…');
  let dsSummary = null;
  try {
    const ds = await fetchToken(token);
    const pair = pickBestPair(ds, { pairAddress: poolId });
    dsSummary = summarizePair(pair);
    if (dsSummary) log(`  ${dsSummary.dex} · liq $${dsSummary.liquidityUsd} · price $${dsSummary.priceUsd}`);
    else log('  no Base pair found on DexScreener');
  } catch (e) {
    log(`  DexScreener unavailable: ${e.message}`);
  }

  // Median per-swap fee for dynamic-fee pools
  let effectiveFeeBps = null;
  if (swaps.length > 0) {
    const recent = swaps.slice(-Math.min(200, swaps.length)).map(s => s.fee).filter(f => f > 0 && (f & 0x800000) === 0);
    if (recent.length > 0) {
      const sorted = recent.sort((a, b) => a - b);
      effectiveFeeBps = sorted[Math.floor(sorted.length / 2)];
    }
  }

  const lastCandle = candles[candles.length - 1];
  const currentPriceWeth = dsSummary?.priceNative || (lastCandle ? lastCandle.close : null);
  const signal = generateSignals({
    candles, pivots, profile,
    currentPriceWeth,
    dexscreener: dsSummary,
    init, decimalsToken: meta.decimals,
    effectiveFeeBps,
  });

  // Override the signal's $100 round-trip slot with whatever the user set as trade size
  if (signal.roundTrip && tradeSize !== 100) {
    const { estimateRoundTrip } = await import('./signal.js');
    const rtCustom = estimateRoundTrip({ tradeSizeUsd: tradeSize, poolFeeBps: signal.poolFeeBps, liquidityUsd: dsSummary?.liquidityUsd || 0 });
    signal.roundTrip[`trade${tradeSize}`] = rtCustom;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    chainId, latestBlock,
    token: meta,
    holders: {
      holderCount: holderMap.holderCount,
      transferCount: holderMap.transferCount,
      mintsFmt: holderMap.mintsFmt,
      burnsFmt: holderMap.burnsFmt,
      concentration: conc,
      holders: holderMap.holders.slice(0, 100),
    },
    pool: init ? { poolId, ...init } : null,
    swaps: swaps.length,
    dexscreener: dsSummary,
    signal,
    rpcStats: rpc.stats(),
  };
  state.lastReport = report;

  log('Done. Rendering report…');
  // Show results FIRST so the chart container has real dimensions when we create the chart.
  $('results').classList.remove('hidden');
  render(report, candles);
}

// ---- Render ----
function render(report, candles) {
  const sig = report.signal || {};
  const ds = report.dexscreener || {};
  const t = report.token;

  // Signal box
  $('signalState').className = `signal ${sig.state || 'NO_DATA'}`;
  $('signalState').textContent = sig.state || 'NO_DATA';
  $('signalKV').innerHTML = [
    kv('Current price', fmtPrice(sig.current) + ' WETH'),
    sig.buyZone ? kv('Buy zone', `${fmtPrice(sig.buyZone[0])} – ${fmtPrice(sig.buyZone[1])} WETH`) : '',
    sig.takeProfit ? kv('Take profit', `TP1 ${fmtPrice(sig.takeProfit.tp1)} · TP2 ${fmtPrice(sig.takeProfit.tp2)} · TP3 ${fmtPrice(sig.takeProfit.tp3)} WETH`) : '',
    sig.stop != null ? kv('Stop loss', fmtPrice(sig.stop) + ' WETH') : '',
    sig.minEdgePrice != null ? kv('Break-even exit', fmtPrice(sig.minEdgePrice) + ' WETH') : '',
    sig.weeklyHigh != null ? kv('7d range', `${fmtPrice(sig.weeklyLow)} → ${fmtPrice(sig.weeklyHigh)}`) : '',
    sig.poc != null ? kv('Volume POC', fmtPrice(sig.poc)) : '',
    sig.poolFeeBps != null ? kv('Effective pool fee', `${(sig.poolFeeBps / 10000).toFixed(3)}%`) : '',
  ].join('');

  // Round-trip table — add data-danger for CSS threshold coloring (per Zara's hook request)
  $('rtTable').innerHTML = sig.roundTrip ? Object.entries(sig.roundTrip).map(([k, r]) => {
    const m = k.match(/trade(\d+)/);
    const size = m ? `$${m[1]}` : k;
    const danger = r.totalPct > 10 ? 'high' : r.totalPct > 5 ? 'mid' : 'low';
    return `<tr data-danger="${danger}"><td>${size}</td><td class="mono">${fmtPct(r.totalPct)}</td><td class="mono">${fmtPct(r.feePct)}</td><td class="mono">${fmtPct(r.slippagePct)}</td><td class="mono">${fmtPct(r.gasPct)}</td></tr>`;
  }).join('') : '';

  // Reasons
  $('reasons').innerHTML = (sig.reasons || []).map(r => `<li>${escapeHtml(r)}</li>`).join('');

  // Token card
  $('tokenKV').innerHTML = [
    kv('Address', `<a href="https://basescan.org/address/${escapeHtml(t.address)}" target="_blank" class="mono">${escapeHtml(t.address)}</a>`, false),
    kv('Name', escapeHtml(t.name || '—')),
    kv('Symbol', escapeHtml(t.symbol || '—')),
    kv('Decimals', t.decimals),
    kv('Total supply', `<span class="mono">${escapeHtml(t.totalSupplyFmt)}</span>`, false),
    kv('Owner', t.owner ? `<a href="https://basescan.org/address/${escapeHtml(t.owner)}" target="_blank" class="mono">${escapeHtml(t.owner)}</a>` : '(none / renounced)', false),
  ].join('');

  // DexScreener card
  $('dsKV').innerHTML = ds && ds.dex ? [
    kv('DEX', escapeHtml(ds.dex)),
    kv('Price USD', fmtUsd(ds.priceUsd)),
    kv('Price native', fmtPrice(ds.priceNative) + ' WETH'),
    kv('Liquidity', fmtUsd(ds.liquidityUsd)),
    kv('FDV / MC', `${fmtUsd(ds.fdv)} / ${fmtUsd(ds.marketCap)}`),
    kv('Volume 24h', fmtUsd(ds.volume24h)),
    kv('Volume 1h', fmtUsd(ds.volume1h)),
    kv('Δ 5m / 1h / 24h', `${fmtPct(ds.priceChange?.m5)} / ${fmtPct(ds.priceChange?.h1)} / ${fmtPct(ds.priceChange?.h24)}`),
    kv('Link', ds.url ? `<a href="${escapeHtml(ds.url)}" target="_blank">DexScreener page</a>` : '—', false),
  ].join('') : '<div class="k">no data</div>';

  // Holders
  $('holdersTable').innerHTML = (report.holders.holders.slice(0, 25)).map((h, i) =>
    `<tr><td>${i + 1}</td><td class="mono"><a href="https://basescan.org/address/${escapeHtml(h.address)}" target="_blank">${escapeHtml(h.address)}</a></td><td class="mono">${escapeHtml(h.balanceFmt)}</td></tr>`
  ).join('');
  const c = report.holders.concentration;
  // wrap each concentration figure in a span with risk class so CSS can color it
  const concSpan = (v) => {
    const r = v >= 90 ? 'crit' : v >= 70 ? 'high' : v >= 40 ? 'mid' : 'low';
    return `<span class="conc conc-${r}">${fmtPct(v)}</span>`;
  };
  $('holdersFooter').innerHTML =
    `Total holders: <span class="mono">${report.holders.holderCount}</span> · ` +
    `Top10 ${concSpan(c.top10Pct)} · ` +
    `Top50 ${concSpan(c.top50Pct)} · ` +
    `Top100 ${concSpan(c.top100Pct)} of supply · ` +
    `<span class="mono">${report.holders.transferCount}</span> total transfers`;

  // Pool
  if (report.pool) {
    const dyn = isDynamicFee(report.pool.fee);
    $('poolKV').innerHTML = [
      kv('PoolId', `<span class="mono">${escapeHtml(report.pool.poolId)}</span>`, false),
      kv('Currency 0', `<a href="https://basescan.org/address/${escapeHtml(report.pool.currency0)}" target="_blank" class="mono">${escapeHtml(report.pool.currency0)}</a>`, false),
      kv('Currency 1', `<a href="https://basescan.org/address/${escapeHtml(report.pool.currency1)}" target="_blank" class="mono">${escapeHtml(report.pool.currency1)}</a>`, false),
      kv('Fee', dyn ? '<span style="color:var(--warn)">DYNAMIC (set by hook per swap)</span>' : `${(report.pool.fee / 10000).toFixed(3)}%`, false),
      kv('Tick spacing', report.pool.tickSpacing),
      kv('Hooks', report.pool.hooks === '0x0000000000000000000000000000000000000000' ? '(none)' : `<a href="https://basescan.org/address/${escapeHtml(report.pool.hooks)}" target="_blank" class="mono">${escapeHtml(report.pool.hooks)}</a>`, false),
      kv('Init block', report.pool.block),
      kv('Swap events', report.swaps),
    ].join('');
  } else {
    $('poolKV').innerHTML = '<div class="k">no V4 pool data</div>';
  }

  // Chart
  renderChart(candles);
}

function kv(k, v, escape = true) {
  const value = escape ? escapeHtml(v) : v;
  return `<div class="k">${escapeHtml(k)}</div><div>${value}</div>`;
}

function renderChart(candles) {
  const el = $('chart');
  el.innerHTML = '';
  if (candles.length === 0) {
    el.innerHTML = '<div style="padding:24px;color:var(--muted);text-align:center">No swap history available — not enough data to plot.</div>';
    return;
  }
  // Robust outlier filter — clip to where most price action lives. Use the 5th and
  // 95th percentile of midpoints, then keep only candles whose entire wick stays in
  // [p5 * 0.7, p95 * 1.4]. This excludes early launch chaos and zero-volume noise.
  const mids = candles.map(c => (c.open + c.close) / 2).filter(x => x > 0).sort((a, b) => a - b);
  const p = (q) => mids[Math.min(mids.length - 1, Math.max(0, Math.floor(q * mids.length)))];
  const p5 = p(0.05), p95 = p(0.95);
  const lo = p5 * 0.7, hi = p95 * 1.4;
  candles = candles.filter(c =>
    isFinite(c.high) && isFinite(c.low) && c.low > 0 &&
    c.high <= hi && c.low >= lo
  );
  if (candles.length === 0) {
    el.innerHTML = '<div style="padding:24px;color:var(--muted);text-align:center">All candles fell outside the robust price range.</div>';
    return;
  }
  // Scale values into a numerically friendly range. lightweight-charts can't render
  // candles whose absolute values fall below its priceFormat.minMove (default 0.01).
  // Multiply the prices so the maximum lands around ~10 and pick fixed precision 6.
  let maxPrice = 0;
  for (const c of candles) if (c.high > maxPrice) maxPrice = c.high;
  let scaleExp = 0;
  if (maxPrice > 0 && maxPrice < 1) {
    scaleExp = Math.ceil(-Math.log10(maxPrice)) + 1; // bring max to ~10
  } else if (maxPrice >= 1000) {
    scaleExp = -Math.floor(Math.log10(maxPrice)); // bring max down to ~10
  }
  const scale = 10 ** scaleExp;
  const precision = 6;
  const minMoveScaled = 10 ** -precision;

  // Render the displayed price as the ORIGINAL token price (sub-pico WETH) using a
  // custom formatter, while feeding the chart series scaled values.
  const labelExp = scaleExp;
  state.chart = LightweightCharts.createChart(el, {
    layout: { background: { color: '#11151b' }, textColor: '#e6e6e6' },
    grid: { vertLines: { color: '#1c222b' }, horzLines: { color: '#1c222b' } },
    timeScale: { timeVisible: true, secondsVisible: false },
    rightPriceScale: { scaleMargins: { top: 0.1, bottom: 0.25 } },
    localization: { priceFormatter: (p) => (p / scale).toExponential(4) },
  });
  state.candleSeries = state.chart.addCandlestickSeries({
    upColor: '#6fffaa', downColor: '#ff7a7a', borderVisible: false,
    wickUpColor: '#6fffaa', wickDownColor: '#ff7a7a',
    priceFormat: { type: 'price', precision, minMove: minMoveScaled },
    title: labelExp ? `WETH (×10⁻${labelExp})` : 'WETH',
  });
  const data = candles.map(c => ({
    time: c.time,
    open: c.open * scale,
    high: c.high * scale,
    low: c.low * scale,
    close: c.close * scale,
  }));
  state.candleSeries.setData(data);
  state.volumeSeries = state.chart.addHistogramSeries({
    priceFormat: { type: 'volume' },
    priceScaleId: '',
    scaleMargins: { top: 0.8, bottom: 0 },
    lastValueVisible: false,
    priceLineVisible: false,
  });
  state.volumeSeries.setData(candles.map(c => ({
    time: c.time,
    value: c.volume,
    color: c.close >= c.open ? '#2a5a3a' : '#5a2a2a',
  })));
  state.chart.timeScale().fitContent();
  // Defensive resize: re-measure on next animation frame in case container width
  // settled after paint (e.g. scrollbar appearing or font load).
  requestAnimationFrame(() => {
    if (!state.chart) return;
    const w = el.offsetWidth, h = el.offsetHeight || 460;
    if (w > 0) state.chart.resize(w, h);
  });
  // Re-fit on window resize so it stays responsive.
  if (!state._resizeBound) {
    window.addEventListener('resize', () => {
      if (!state.chart || !el.offsetWidth) return;
      state.chart.resize(el.offsetWidth, el.offsetHeight || 460);
    });
    state._resizeBound = true;
  }
}

// ---- Download JSON ----
$('downloadJson').addEventListener('click', () => {
  if (!state.lastReport) return;
  const blob = new Blob(
    [JSON.stringify(state.lastReport, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2)],
    { type: 'application/json' }
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${state.lastReport.token.symbol || 'token'}-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
});

// ---- On load: apply the active preset (sets fromBlock etc.) so first click works without re-selecting ----
applyPreset($('preset').value);
console.log('[Base Token Analyzer] ready. Click Analyze.');
