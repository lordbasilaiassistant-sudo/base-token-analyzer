# ThryxTokenChecks

Read-only full-history analyzer + interactive chart + buy/sell signal engine for any
ERC-20 on **Base mainnet**, with first-class support for **Uniswap V4** pools.

> ⚠ **NOT FINANCIAL ADVICE.** This tool is automated heuristic research output only.
> Verify everything independently. You assume all trading risk.

It piggybacks on the same RPC aggregation pattern as
[`RPCagg`](../RPCagg) — round-robins across 21 Base public RPCs with weighted
latency selection, 429-cooldown, and an `eth_getLogs` auto-bisecter that adapts
to whatever range cap each provider enforces.

## What it tells you

For any token + V4 poolId, it produces a JSON + interactive HTML report containing:

- **Token metadata** — name, symbol, decimals, total supply, owner (or "renounced")
- **Holders** — full crawl of every `Transfer` event ever, top-N table, top-10 / top-50 / top-100 concentration ratios
- **Mints / burns** — total supply minted vs burned across history
- **V4 pool** — `Initialize` decoded (currency0, currency1, fee, tickSpacing, hooks)
- **Swap history** — every `Swap` event since pool creation, decoded into trade rows with side (buy/sell), token amount, WETH amount, price
- **OHLC candles** — bucketable 1m / 5m / 1h / 1d
- **Pivot S/R** — swing-low / swing-high pivots from candles
- **Volume profile** — POC (point-of-control)
- **DexScreener live snapshot** — current price, liquidity, FDV, MC, m5/h1/h6/h24 volume, txn counts, %change
- **Round-trip cost model** — pool fee × 2 + slippage × 2 + Base gas × 2, computed for $100 / $500 / $1000 trade sizes
- **Buy / sell signal**:
  - State: `BUY` · `WATCH` · `HOLD` · `TAKE_PROFIT` · `SELL` · `AVOID`
  - Recommended buy zone (price range)
  - TP1 / TP2 / TP3 ladder
  - Stop loss
  - Break-even exit price (price needed to net zero on round-trip)
  - Reason bullets

## Install

```bash
npm install
```

Requires Node.js ≥ 18 (uses native `fetch` + `BigInt`). Only dependency is `ethers ^6.13.4`.

## Usage

```bash
# Defaults to THRYX (0xc07E…3BA3) ↔ WETH on V4
npm start

# Or any token + V4 poolId
node index.js 0xYourToken 0xYourV4PoolId

# Options
node index.js --token 0x... --pool 0x... --candle-seconds 3600 --out reports

# 5-minute candles, 24h window
node index.js --candle-seconds 300 --from-block 14000000
```

Reports land in `./reports/<symbol>-<timestamp>.{json,html}`. Open the HTML in a
browser for the interactive candle chart.

## Architecture

```
src/
  providers.js     21 Base RPC endpoints (mirror of RPCagg, weighted by tier)
  rpc.js           Aggregator: round-robin, 429 backoff, eth_getLogs auto-bisect
  multicall.js     Multicall3 helper
  token.js         ERC20 metadata, deployment lookup
  transfers.js     Transfer log crawler + holder map + concentration
  v4.js            Uniswap V4 PoolManager event decoder (Initialize, Swap, ModifyLiquidity)
  dexscreener.js   DexScreener public API client
  ohlc.js          Block timestamps · trades · candles · pivots · volume profile
  signal.js        Round-trip cost model + buy/sell signal engine
  report.js        Console summary + HTML chart renderer (lightweight-charts)
index.js           CLI
```

## What the signal engine does (and doesn't)

It's a **mechanical** signal — not predictive AI, not edge. It looks at:

1. The most recent pivot lows below current price → support
2. The most recent pivot highs above current price → resistance
3. Volume profile point-of-control
4. 7-day high / low extremes
5. Round-trip cost (pool fee × 2 + slippage × 2 + gas × 2)

…and outputs the kind of plan a careful manual trader would write down before
opening a position: where to buy, where to scale out, where to stop, and the
**minimum exit price that beats the round-trip cost**.

It does **not** account for:

- Token unlocks / cliffs
- Whale wallets dumping (you can spot these in the holders table)
- Hooks rugging / blacklisting (V4-specific risk — check `init.hooks`)
- News, narrative, momentum
- Your tax situation

If the holders table shows top-10 owning 90%+ and there's a non-zero hooks
address, the math says nothing useful and you should walk away.

## Trader CLI (live swaps)

The repo also ships an agent-friendly trader at `trade.js` for buying/selling tokens.
The trader's private key lives in `~/.claude/secrets/thryxtokenchecks.env` (off-OneDrive,
never committed). Default route is the THRYX Diamond at
`0x2F77b40c124645d25782CfBdfB1f54C1d76f2cCe` — works for THRYX itself and any token
launched on the THRYX protocol. For non-THRYX V4 pools, pass `--route universal`
(Uniswap Universal Router path; not supported for THRYX-launched tokens because
their V4 hook only allows the Diamond).

```bash
# Verify all V4/UR/Permit2 contracts are deployed
node trade.js verify

# Read-only quote (V4 Quoter call, no signer needed)
node trade.js quote   --side buy  --amount-eth 0.001

# Full plan: encode the swap, eth_call simulate, gas estimate, approval check
node trade.js plan    --side buy  --amount-eth 0.001 --slippage-bps 200

# Sign + broadcast (default refuses unless --execute is passed AND simulation passes)
node trade.js execute --side buy  --amount-eth 0.001 --slippage-bps 200 --execute

# One-time ERC20 approval to Diamond (sell-side prerequisite)
node trade.js approve --execute

# Sell back to ETH
node trade.js execute --side sell --amount-token 4535689000000000000000000 --slippage-bps 300 --execute
```

Output is JSON. Exit codes: `0` ok · `2` input error · `3` simulation reverted (refused)
· `4` approval missing · `5` RPC failure. Designed for both humans and AI agents to
drive the same way.

## License

MIT — see [LICENSE](./LICENSE).

## Provenance

Provider list and aggregation pattern adapted from
[`RPCagg`](../RPCagg) (also by Anthony Snider). No private code, no API keys,
no dependency on private infrastructure.
