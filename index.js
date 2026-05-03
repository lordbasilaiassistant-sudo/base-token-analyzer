#!/usr/bin/env node
// THRYX Token Checks — full-history analyzer + chart + buy/sell signal engine
// for any Base mainnet token. Read-only. NOT FINANCIAL ADVICE.

const path = require('path');
const { RpcAgg, BASE_CHAIN_ID } = require('./src/rpc');
const { readMetadata } = require('./src/token');
const { crawlTransfers, buildHolderMap, concentration } = require('./src/transfers');
const { findInitialize, crawlSwaps } = require('./src/v4');
const { fetchToken, pickBestPair, summarizePair } = require('./src/dexscreener');
const { fetchBlockTimestamps, swapsToTrades, buildCandles, findPivots, volumeProfile } = require('./src/ohlc');
const { generateSignals } = require('./src/signal');
const { consoleSummary, writeReport } = require('./src/report');

// Defaults: THRYX on Base, V4 pool vs WETH (per drlor 2026-05-03)
const DEFAULTS = {
  token:  '0xc07E889e1816De2708BF718683e52150C20F3BA3',
  poolId: '0x5a86f04dbd3e6b532e4397eb605a4c23136dc913e0a60b65547842d2ce7876e8',
};

function isAddress(s)  { return typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s); }
function isPoolId(s)   { return typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s); }

function parseArgs(argv) {
  const args = { token: null, poolId: null, fromBlock: null, candleInterval: 3600, outDir: 'reports' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--token')      args.token = argv[++i];
    else if (a === '--pool')  args.poolId = argv[++i];
    else if (a === '--from-block') args.fromBlock = parseInt(argv[++i], 10);
    else if (a === '--candle-seconds') args.candleInterval = parseInt(argv[++i], 10);
    else if (a === '--out')   args.outDir = argv[++i];
    else if (a === '-h' || a === '--help') { args.help = true; }
    else if (!args.token && isAddress(a))  args.token = a;
    else if (!args.poolId && isPoolId(a))  args.poolId = a;
    else if (!args.token) args.token = a; // will fail validation below
    else if (!args.poolId) args.poolId = a;
  }
  return args;
}

function help() {
  console.log(`
THRYX Token Checks — read-only Base token analyzer

Usage:
  node index.js [TOKEN_ADDRESS] [V4_POOL_ID] [options]

  Both args are optional — defaults to THRYX/${DEFAULTS.token.slice(0, 10)}…
  paired against WETH on V4 poolId ${DEFAULTS.poolId.slice(0, 10)}…

Options:
  --token 0x...           ERC20 token address (40-hex)
  --pool 0x...            Uniswap V4 poolId (64-hex). Omit to skip swap crawl.
  --from-block N          Earliest block to scan. Default: deployment block.
  --candle-seconds N      OHLC interval. Default 3600 (1h). 60/300/3600/86400.
  --out DIR               Report output dir. Default ./reports
  -h, --help              Show this message.

NOT FINANCIAL ADVICE. This tool is heuristic research output only.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return help();

  const token  = args.token  || DEFAULTS.token;
  const poolId = args.poolId || DEFAULTS.poolId;

  if (!isAddress(token))  { console.error(`ERROR: invalid token address: ${token}`);  process.exit(1); }
  if (poolId && !isPoolId(poolId)) { console.error(`ERROR: invalid V4 poolId: ${poolId}`); process.exit(1); }

  const rpc = new RpcAgg();
  const chainId = await rpc.getChainId();
  if (chainId !== BASE_CHAIN_ID) {
    console.error(`ERROR: connected to chain ${chainId}, expected Base (${BASE_CHAIN_ID})`);
    process.exit(1);
  }

  const latestBlock = await rpc.getBlockNumber();
  console.log(`[*] Base latest block: ${latestBlock}`);

  // 1. Token metadata
  console.log(`[*] Reading metadata for ${token}…`);
  const meta = await readMetadata(rpc, token);
  console.log(`    ${meta.symbol || '?'} (${meta.name || '?'}) · decimals ${meta.decimals} · supply ${meta.totalSupplyFmt}`);

  // 2. Transfer history + holders
  const fromBlock = args.fromBlock != null ? args.fromBlock : 0;
  console.log(`[*] Crawling ERC20 Transfer logs blocks ${fromBlock} → ${latestBlock}…`);
  const transfers = await crawlTransfers(rpc, token, fromBlock, latestBlock, ({ from, to, total }) => {
    if (total % 1000 === 0 && total > 0) process.stdout.write(`    ${total} transfers · @ block ${to}\r`);
  });
  process.stdout.write('\n');
  console.log(`    Got ${transfers.length} transfers`);
  const holderMap = buildHolderMap(transfers, meta.decimals);
  const conc = concentration(holderMap.holders, meta.totalSupply);

  // 3. V4 pool data
  let init = null;
  let swaps = [];
  let trades = [];
  let blockTs = new Map();
  let candles = [];
  let pivots = { highs: [], lows: [] };
  let profile = null;
  let signal = null;
  if (poolId) {
    console.log(`[*] Looking up V4 Initialize for poolId ${poolId.slice(0, 18)}…`);
    init = await findInitialize(rpc, poolId, fromBlock, latestBlock);
    if (init) {
      console.log(`    init at block ${init.block}, currency0 ${init.currency0.slice(0, 8)}… currency1 ${init.currency1.slice(0, 8)}… fee ${init.fee}`);
      console.log(`[*] Crawling V4 Swap logs…`);
      swaps = await crawlSwaps(rpc, poolId, init.block, latestBlock, ({ from, to, total }) => {
        if (total % 500 === 0 && total > 0) process.stdout.write(`    ${total} swaps · @ block ${to}\r`);
      });
      process.stdout.write('\n');
      console.log(`    Got ${swaps.length} swaps`);
      console.log(`[*] Fetching block timestamps for ${new Set(swaps.map(s => s.block)).size} unique blocks…`);
      blockTs = await fetchBlockTimestamps(rpc, swaps.map(s => s.block), 8);
      trades = swapsToTrades(swaps, init, token, meta.decimals, blockTs);
      candles = buildCandles(trades, args.candleInterval);
      pivots = findPivots(candles, 3);
      profile = volumeProfile(candles, 30);
    } else {
      console.log(`    No Initialize event found — pool may not be V4 or block range too narrow`);
    }
  }

  // 4. DexScreener live snapshot
  console.log(`[*] Fetching DexScreener snapshot…`);
  let dsSummary = null;
  try {
    const ds = await fetchToken(token);
    const pair = pickBestPair(ds, { pairAddress: poolId });
    dsSummary = summarizePair(pair);
    if (dsSummary) console.log(`    ${dsSummary.dex} · liq ${dsSummary.liquidityUsd} · price $${dsSummary.priceUsd}`);
  } catch (e) {
    console.log(`    DexScreener unavailable: ${e.message}`);
  }

  // 5. Signal
  const lastCandle = candles[candles.length - 1];
  const currentPriceWeth = dsSummary?.priceNative || (lastCandle ? lastCandle.close : null);
  // For dynamic-fee V4 pools the Initialize fee is the dynamic flag; use median per-swap fee from the last 200 swaps as the effective fee.
  let effectiveFeeBps = null;
  if (swaps.length > 0) {
    const recent = swaps.slice(-Math.min(200, swaps.length)).map(s => s.fee).filter(f => f > 0 && (f & 0x800000) === 0);
    if (recent.length > 0) {
      const sorted = recent.sort((a, b) => a - b);
      effectiveFeeBps = sorted[Math.floor(sorted.length / 2)];
    }
  }
  signal = generateSignals({
    candles, pivots, profile,
    currentPriceWeth,
    dexscreener: dsSummary,
    init,
    decimalsToken: meta.decimals,
    effectiveFeeBps,
  });

  // 6. Report
  const report = {
    generatedAt: new Date().toISOString(),
    chainId,
    latestBlock,
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
    tradeSampleFirst: trades.slice(0, 20),
    tradeSampleLast: trades.slice(-20),
    dexscreener: dsSummary,
    signal,
    rpcStats: rpc.stats(),
  };

  console.log('\n' + consoleSummary(report));

  const outDir = path.resolve(args.outDir);
  const { jsonPath, htmlPath } = writeReport(outDir, report, candles);
  console.log(`\n[+] JSON written: ${jsonPath}`);
  console.log(`[+] HTML written: ${htmlPath}`);
}

main().catch(err => {
  console.error('FATAL:', err.stack || err.message);
  process.exit(1);
});
