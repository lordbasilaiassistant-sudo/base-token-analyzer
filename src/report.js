// Console + HTML report renderer.

const fs = require('fs');
const path = require('path');

function fmtUsd(n) { return n == null ? '—' : `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`; }
function fmtPct(n) { return n == null ? '—' : `${(n).toFixed(2)}%`; }
function fmtPrice(p) {
  if (p == null) return '—';
  if (p >= 1) return p.toFixed(6);
  if (p >= 0.0001) return p.toFixed(8);
  return p.toExponential(4);
}
function fmtTs(ts) { return ts ? new Date(ts * 1000).toISOString() : '—'; }

function consoleSummary(report) {
  const t = report.token;
  const ds = report.dexscreener;
  const sig = report.signal;
  const lines = [];
  lines.push('='.repeat(72));
  lines.push(`THRYXTokenChecks — ${t.name || '(unnamed)'} (${t.symbol || '?'})`);
  lines.push(`Address: ${t.address}`);
  lines.push(`Chain:   Base mainnet (8453)`);
  lines.push('-'.repeat(72));
  lines.push(`Decimals:        ${t.decimals}`);
  lines.push(`Total supply:    ${t.totalSupplyFmt}`);
  lines.push(`Owner:           ${t.owner || '(none / renounced)'}`);
  lines.push(`Holders found:   ${report.holders.holderCount}`);
  lines.push(`Top10 control:   ${fmtPct(report.holders.concentration.top10Pct)}`);
  lines.push(`Top50 control:   ${fmtPct(report.holders.concentration.top50Pct)}`);
  lines.push(`Mints / burns:   ${report.holders.mintsFmt} / ${report.holders.burnsFmt}`);
  lines.push(`Transfers:       ${report.holders.transferCount}`);
  if (report.pool) {
    lines.push('-'.repeat(72));
    lines.push(`Pool (V4):       ${report.pool.poolId}`);
    lines.push(`  currency0:     ${report.pool.currency0}`);
    lines.push(`  currency1:     ${report.pool.currency1}`);
    lines.push(`  fee field:     ${report.pool.fee}${(report.pool.fee & 0x800000) ? ' [DYNAMIC FEE FLAG]' : ''}`);
    lines.push(`  tickSpacing:   ${report.pool.tickSpacing}`);
    lines.push(`  hooks:         ${report.pool.hooks}`);
    const swapCount = typeof report.swaps === 'number' ? report.swaps : (report.swaps?.length || 0);
    const isDynFee = (report.pool.fee & 0x800000) !== 0;
    lines.push(`  swaps:         ${swapCount}`);
    lines.push(`  fee mode:      ${isDynFee ? 'DYNAMIC (set by hook per swap)' : ((report.pool.fee / 10000).toFixed(3) + '% fixed')}`);
  }
  if (ds) {
    lines.push('-'.repeat(72));
    lines.push(`DexScreener live snapshot (${ds.dex}):`);
    lines.push(`  price USD:     ${fmtUsd(ds.priceUsd)}`);
    lines.push(`  price native:  ${fmtPrice(ds.priceNative)} WETH`);
    lines.push(`  liquidity:     ${fmtUsd(ds.liquidityUsd)}`);
    lines.push(`  FDV / MC:      ${fmtUsd(ds.fdv)} / ${fmtUsd(ds.marketCap)}`);
    lines.push(`  vol 5m / 1h / 24h: ${fmtUsd(ds.volume5m)} / ${fmtUsd(ds.volume1h)} / ${fmtUsd(ds.volume24h)}`);
    if (ds.priceChange) lines.push(`  Δ 5m / 1h / 24h:    ${fmtPct(ds.priceChange.m5)} / ${fmtPct(ds.priceChange.h1)} / ${fmtPct(ds.priceChange.h24)}`);
  }
  if (sig) {
    lines.push('-'.repeat(72));
    lines.push(`SIGNAL: ${sig.state}`);
    lines.push(`  current price:    ${fmtPrice(sig.current)} WETH`);
    if (sig.buyZone)   lines.push(`  buy zone:         ${fmtPrice(sig.buyZone[0])} – ${fmtPrice(sig.buyZone[1])} WETH`);
    if (sig.takeProfit) {
      lines.push(`  TP1 / TP2 / TP3:  ${fmtPrice(sig.takeProfit.tp1)} / ${fmtPrice(sig.takeProfit.tp2)} / ${fmtPrice(sig.takeProfit.tp3)} WETH`);
    }
    if (sig.stop != null)         lines.push(`  stop loss:        ${fmtPrice(sig.stop)} WETH`);
    if (sig.minEdgePrice != null) lines.push(`  break-even exit:  ${fmtPrice(sig.minEdgePrice)} WETH (entry @ current)`);
    if (sig.weeklyHigh != null)   lines.push(`  7d high / low:    ${fmtPrice(sig.weeklyHigh)} / ${fmtPrice(sig.weeklyLow)}`);
    if (sig.poc != null)          lines.push(`  vol POC:          ${fmtPrice(sig.poc)} WETH`);
    if (sig.roundTrip) {
      lines.push(`  round-trip cost  $100 trade: ${fmtPct(sig.roundTrip.trade100.totalPct)}  (${sig.roundTrip.trade100.breakdown})`);
      lines.push(`  round-trip cost  $500 trade: ${fmtPct(sig.roundTrip.trade500.totalPct)}`);
      lines.push(`  round-trip cost $1000 trade: ${fmtPct(sig.roundTrip.trade1000.totalPct)}`);
    }
    lines.push('  reasons:');
    for (const r of sig.reasons || []) lines.push(`    · ${r}`);
  }
  lines.push('-'.repeat(72));
  lines.push('NOT FINANCIAL ADVICE. This is automated heuristic output for research only.');
  lines.push('You assume all risk for trades you take. Verify everything independently.');
  lines.push('='.repeat(72));
  return lines.join('\n');
}

function htmlReport(report, candles) {
  const symbol = report.token.symbol || 'TOKEN';
  const sig = report.signal || {};
  const ds = report.dexscreener || {};
  const candlesJson = JSON.stringify(candles.map(c => ({
    time: c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  })));
  const reasonsHtml = (sig.reasons || []).map(r => `<li>${escapeHtml(r)}</li>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(symbol)} — Token Report</title>
<style>
  body { font: 14px/1.5 -apple-system, system-ui, "Segoe UI", sans-serif; background: #0b0d10; color: #e6e6e6; margin: 0; padding: 24px; }
  h1, h2 { font-weight: 600; margin: 8px 0; }
  h1 { font-size: 22px; } h2 { font-size: 16px; color: #a0c4ff; margin-top: 24px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 16px 0; }
  .card { background: #11151b; border: 1px solid #1c222b; border-radius: 8px; padding: 16px; }
  .kv { display: grid; grid-template-columns: 200px 1fr; gap: 4px 12px; }
  .kv .k { color: #8a96a6; }
  .signal { font-size: 28px; font-weight: 700; padding: 10px 16px; border-radius: 6px; display: inline-block; }
  .BUY            { background: #134a2c; color: #6fffaa; }
  .WATCH          { background: #444a14; color: #fff09a; }
  .HOLD           { background: #1f3a52; color: #aacaff; }
  .TAKE_PROFIT    { background: #4a3414; color: #ffc99a; }
  .SELL           { background: #5a1c1c; color: #ff9a9a; }
  .AVOID          { background: #5a1c1c; color: #ff9a9a; }
  .NO_DATA        { background: #2a2a2a; color: #888; }
  ul.reasons { margin: 8px 0; padding-left: 18px; }
  ul.reasons li { margin: 4px 0; }
  .disclaimer { background: #2a1a1a; border: 1px solid #5a1c1c; color: #ff9a9a; padding: 12px; border-radius: 6px; margin: 24px 0; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #1c222b; font-size: 13px; }
  th { color: #8a96a6; font-weight: 500; }
  .mono { font-family: ui-monospace, "JetBrains Mono", Consolas, monospace; }
  #chart { background: #11151b; border: 1px solid #1c222b; border-radius: 8px; padding: 8px; height: 460px; }
  a { color: #a0c4ff; }
</style>
</head>
<body>
  <h1>${escapeHtml(report.token.name || '')} (${escapeHtml(symbol)}) — <span class="mono" style="font-size:14px">${escapeHtml(report.token.address)}</span></h1>
  <div>Base mainnet · generated ${new Date(report.generatedAt).toISOString()}</div>

  <div class="disclaimer">⚠ NOT FINANCIAL ADVICE — automated heuristic output for research only. Verify independently. You assume all trading risk.</div>

  <h2>Signal</h2>
  <div class="card">
    <div class="signal ${sig.state || 'NO_DATA'}">${sig.state || 'NO_DATA'}</div>
    <div class="kv" style="margin-top:12px">
      <div class="k">Current price</div><div class="mono">${fmtPrice(sig.current)} WETH</div>
      ${sig.buyZone ? `<div class="k">Buy zone</div><div class="mono">${fmtPrice(sig.buyZone[0])} – ${fmtPrice(sig.buyZone[1])} WETH</div>` : ''}
      ${sig.takeProfit ? `<div class="k">Take profit ladder</div><div class="mono">TP1 ${fmtPrice(sig.takeProfit.tp1)} · TP2 ${fmtPrice(sig.takeProfit.tp2)} · TP3 ${fmtPrice(sig.takeProfit.tp3)} WETH</div>` : ''}
      ${sig.stop != null ? `<div class="k">Stop loss</div><div class="mono">${fmtPrice(sig.stop)} WETH</div>` : ''}
      ${sig.minEdgePrice != null ? `<div class="k">Break-even exit</div><div class="mono">${fmtPrice(sig.minEdgePrice)} WETH (entry @ current)</div>` : ''}
      <div class="k">7-day range</div><div class="mono">${fmtPrice(sig.weeklyLow)} → ${fmtPrice(sig.weeklyHigh)}</div>
      <div class="k">Volume POC</div><div class="mono">${fmtPrice(sig.poc)}</div>
      <div class="k">Pool fee</div><div class="mono">${(sig.poolFeeBps / 10000).toFixed(3)}%</div>
    </div>
    <h3 style="margin-top:14px">Round-trip cost (entry + exit, % of trade size)</h3>
    <table>
      <tr><th>Trade size</th><th>Total</th><th>Pool fee</th><th>Slippage</th><th>Gas</th></tr>
      ${sig.roundTrip ? Object.entries(sig.roundTrip).map(([k, r]) => {
        const size = k === 'trade100' ? '$100' : k === 'trade500' ? '$500' : '$1000';
        return `<tr><td>${size}</td><td class="mono">${fmtPct(r.totalPct)}</td><td class="mono">${fmtPct(r.feePct)}</td><td class="mono">${fmtPct(r.slippagePct)}</td><td class="mono">${fmtPct(r.gasPct)}</td></tr>`;
      }).join('') : ''}
    </table>
    <h3 style="margin-top:14px">Reasoning</h3>
    <ul class="reasons">${reasonsHtml}</ul>
  </div>

  <h2>Price chart</h2>
  <div id="chart"></div>

  <div class="grid">
    <div class="card">
      <h2 style="margin-top:0">Token</h2>
      <div class="kv">
        <div class="k">Name</div><div>${escapeHtml(report.token.name || '')}</div>
        <div class="k">Symbol</div><div>${escapeHtml(report.token.symbol || '')}</div>
        <div class="k">Decimals</div><div>${report.token.decimals}</div>
        <div class="k">Total supply</div><div class="mono">${escapeHtml(report.token.totalSupplyFmt)}</div>
        <div class="k">Owner</div><div class="mono">${escapeHtml(report.token.owner || '(none)')}</div>
      </div>
    </div>
    <div class="card">
      <h2 style="margin-top:0">DexScreener live</h2>
      <div class="kv">
        <div class="k">Price (USD)</div><div class="mono">${fmtUsd(ds.priceUsd)}</div>
        <div class="k">Price (native)</div><div class="mono">${fmtPrice(ds.priceNative)} WETH</div>
        <div class="k">Liquidity</div><div class="mono">${fmtUsd(ds.liquidityUsd)}</div>
        <div class="k">Volume 24h</div><div class="mono">${fmtUsd(ds.volume24h)}</div>
        <div class="k">FDV / MC</div><div class="mono">${fmtUsd(ds.fdv)} / ${fmtUsd(ds.marketCap)}</div>
        <div class="k">Δ 24h</div><div class="mono">${fmtPct(ds.priceChange?.h24)}</div>
        <div class="k">DexScreener</div><div><a href="${escapeHtml(ds.url || '#')}" target="_blank">open</a></div>
      </div>
    </div>
  </div>

  <h2>Holders — top 25</h2>
  <div class="card">
    <table>
      <tr><th>#</th><th>Address</th><th>Balance</th></tr>
      ${(report.holders.holders.slice(0, 25)).map((h, i) =>
        `<tr><td>${i + 1}</td><td class="mono"><a href="https://basescan.org/address/${escapeHtml(h.address)}" target="_blank">${escapeHtml(h.address)}</a></td><td class="mono">${escapeHtml(h.balanceFmt)}</td></tr>`
      ).join('')}
    </table>
    <div style="margin-top:8px; color:#8a96a6">
      Top10 ${fmtPct(report.holders.concentration.top10Pct)} · Top50 ${fmtPct(report.holders.concentration.top50Pct)} · Top100 ${fmtPct(report.holders.concentration.top100Pct)} of supply
    </div>
  </div>

<script src="https://unpkg.com/lightweight-charts@4.1.7/dist/lightweight-charts.standalone.production.js"></script>
<script>
  const candles = ${candlesJson};
  const el = document.getElementById('chart');
  const chart = LightweightCharts.createChart(el, {
    layout: { background: { color: '#11151b' }, textColor: '#e6e6e6' },
    grid: { vertLines: { color: '#1c222b' }, horzLines: { color: '#1c222b' } },
    timeScale: { timeVisible: true, secondsVisible: false },
    rightPriceScale: { scaleMargins: { top: 0.1, bottom: 0.25 } },
  });
  const series = chart.addCandlestickSeries({
    upColor: '#6fffaa', downColor: '#ff7a7a', borderVisible: false,
    wickUpColor: '#6fffaa', wickDownColor: '#ff7a7a',
  });
  series.setData(candles);
  const vol = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: '', scaleMargins: { top: 0.8, bottom: 0 } });
  vol.setData(candles.map(c => ({ time: c.time, value: c.volume, color: c.close >= c.open ? '#2a5a3a' : '#5a2a2a' })));
  chart.timeScale().fitContent();
</script>

</body>
</html>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function writeReport(outDir, report, candles) {
  fs.mkdirSync(outDir, { recursive: true });
  const slug = (report.token.symbol || report.token.address).replace(/[^a-zA-Z0-9_-]/g, '_');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(outDir, `${slug}-${ts}.json`);
  const htmlPath = path.join(outDir, `${slug}-${ts}.html`);
  // Stringify with BigInt safety
  fs.writeFileSync(jsonPath, JSON.stringify(report, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
  fs.writeFileSync(htmlPath, htmlReport(report, candles));
  return { jsonPath, htmlPath };
}

module.exports = { consoleSummary, htmlReport, writeReport };
