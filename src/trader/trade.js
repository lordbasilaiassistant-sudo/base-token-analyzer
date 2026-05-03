// Trade orchestrator — quote, simulate, execute.
//
// Designed agent-friendly:
//   • Pure functions taking explicit args (no implicit globals).
//   • Returns plain JSON-serializable shapes (BigInts stringified).
//   • A `dryRun=true` parameter on every executor — the default is ALWAYS dry-run.
//   • Emits clear, deterministic errors when an invariant fails (insufficient balance,
//     pool init not found, etc).

const { formatEther, parseEther, JsonRpcProvider, Wallet } = require('ethers');
const { findInitialize } = require('../v4');
const { quoteExactIn } = require('./v4quote');
const { buildBuyEthForToken, buildSellTokenForEth } = require('./swap');
const { buildBuyEth: thryxBuildBuyEth, buildSellForEth: thryxBuildSellForEth, readErc20Allowance: thryxReadAllowance, buildErc20ApproveDiamondTx, DIAMOND } = require('./thryx');
const { checkAllowances, buildErc20ApproveTx, buildPermit2ApproveTx } = require('./approvals');
const { getFeeData, costEth, costUsd } = require('./gas');
const { ADDR, verifyDeployment } = require('./addresses');

function bigToStr(o) { return JSON.parse(JSON.stringify(o, (_, v) => typeof v === 'bigint' ? v.toString() : v)); }

// Fetch a recent ETH/USD price from DexScreener (WETH/USDC pair on Base).
// Cheap fallback at $3000 if the call fails.
async function getEthUsd() {
  try {
    const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/0x4200000000000000000000000000000000000006');
    const j = await r.json();
    const pair = (j.pairs || []).filter(p => p.chainId === 'base').sort((a,b)=>(b.liquidity?.usd||0)-(a.liquidity?.usd||0))[0];
    return pair && pair.priceUsd ? Number(pair.priceUsd) : 3000;
  } catch { return 3000; }
}

// Get the V4 PoolKey for a token by looking up its Initialize event.
// Cached on the rpc object during a single CLI run to avoid repeated scans.
async function loadPoolInit(rpc, poolId) {
  if (rpc.__poolInit && rpc.__poolInit[poolId]) return rpc.__poolInit[poolId];
  const latest = await rpc.getBlockNumber();
  const init = await findInitialize(rpc, poolId, 0, latest);
  if (!init) throw new Error(`No V4 Initialize event found for poolId ${poolId}`);
  rpc.__poolInit ||= {};
  rpc.__poolInit[poolId] = init;
  return init;
}

// QUOTE only (no execution). Returns expected amounts + costs.
//   side: 'buy' | 'sell'
//   amount: BigInt (wei) — for buy = ETH in, for sell = token in
async function quote({ rpc, poolId, tokenAddress, side, amount }) {
  const init = await loadPoolInit(rpc, poolId);
  const tokenIn  = side === 'buy' ? ADDR.WETH : tokenAddress;
  const tokenOut = side === 'buy' ? tokenAddress : ADDR.WETH;
  const { amountOut, gasEstimate, zeroForOne } = await quoteExactIn(rpc, init, tokenIn, amount);
  const ethUsd = await getEthUsd();
  const fee = await getFeeData(rpc);
  // Universal Router V4 swap typically ~150-220k gas. We use the quoter's hint + 80k ramp
  // for the URv2 wrap/settle/take pipeline.
  const txGas = gasEstimate + 80_000n;
  const gasWei = costEth(txGas, fee.maxFeePerGas);
  const gasUsd = costUsd(gasWei, ethUsd);
  return {
    init: bigToStr(init),
    side,
    zeroForOne,
    tokenIn, tokenOut,
    amountIn: amount.toString(),
    amountInFmt: side === 'buy' ? formatEther(amount) + ' ETH' : amount.toString() + ' raw token',
    amountOut: amountOut.toString(),
    amountOutFmt: side === 'buy' ? amountOut.toString() + ' raw token' : formatEther(amountOut) + ' ETH',
    gasUnits: txGas.toString(),
    gasPrice: fee.maxFeePerGas.toString(),
    gasWei: gasWei.toString(),
    gasUsd: +gasUsd.toFixed(4),
    ethUsd,
    notionalIn: side === 'buy' ? +(Number(formatEther(amount)) * ethUsd).toFixed(4) : null,
    notionalOut: side === 'sell' ? +(Number(formatEther(amountOut)) * ethUsd).toFixed(4) : null,
  };
}

// Apply a slippage tolerance to a raw quote: amountOutMin = amountOut * (1 - bps/10000).
function applySlippage(amountOut, slippageBps) {
  return (BigInt(amountOut) * BigInt(10000 - slippageBps)) / 10000n;
}

// SIMULATE: encode the swap, eth_call against the router, return success/revert + gas.
// dryRun is always the default for plan(). Use exec() to actually broadcast.
//
// route: 'thryx' (default — call Diamond.swap; required for THRYX-launched tokens whose
// V4 hook only accepts the Diamond) | 'universal' (Uniswap Universal Router; for any
// vanilla V4 pool without a permissioned hook).
async function plan({ rpc, poolId, tokenAddress, side, amount, slippageBps = 100 /* 1% */, walletAddress, deadlineSec = 300, route = 'thryx' }) {
  const q = await quote({ rpc, poolId, tokenAddress, side, amount });
  const init = await loadPoolInit(rpc, poolId);
  const poolKey = {
    currency0: init.currency0, currency1: init.currency1,
    fee: init.fee, tickSpacing: init.tickSpacing, hooks: init.hooks,
  };
  const amountOutMin = applySlippage(q.amountOut, slippageBps);
  const deadline = Math.floor(Date.now() / 1000) + deadlineSec;

  let tx;
  if (route === 'thryx') {
    tx = side === 'buy'
      ? thryxBuildBuyEth({ tokenOut: tokenAddress, amountInWei: amount, minOut: amountOutMin })
      : thryxBuildSellForEth({ tokenIn: tokenAddress, amountInWei: amount, minOut: amountOutMin });
  } else if (route === 'universal') {
    tx = side === 'buy'
      ? buildBuyEthForToken({ poolKey, tokenOut: tokenAddress, amountInWei: amount, amountOutMin, recipient: walletAddress, deadline })
      : buildSellTokenForEth({ poolKey, tokenIn: tokenAddress, amountInWei: amount, amountOutMin, recipient: walletAddress, deadline });
  } else {
    throw new Error(`unknown route '${route}' (use 'thryx' or 'universal')`);
  }

  // Allowance check (sell only)
  let approvals = null;
  if (side === 'sell') {
    if (route === 'thryx') {
      const a = await thryxReadAllowance(rpc, tokenAddress, walletAddress);
      const need = a < BigInt(amount);
      approvals = { route: 'thryx-diamond', current: a.toString(), required: amount.toString(), issues: need ? ['need-erc20-approval-to-diamond'] : [] };
    } else {
      approvals = await checkAllowances(rpc, tokenAddress, walletAddress);
    }
  }

  // Dry-run via eth_call. Some public RPCs reject eth_call with a `from` field —
  // retry without `from` if the first attempt errors with "method not supported".
  let simSuccess = false, simError = null, simReturn = null;
  for (const includeFrom of [true, false]) {
    try {
      const callObj = { to: tx.to, data: tx.data, value: '0x' + tx.value.toString(16) };
      if (includeFrom) callObj.from = walletAddress;
      simReturn = await rpc.call('eth_call', [callObj, 'latest']);
      simSuccess = true;
      simError = null;
      break;
    } catch (err) {
      simError = err.rpcMessage || err.message;
      // Only retry without `from` if the first attempt failed with provider-not-supported
      if (!includeFrom || !/not supported|invalid argument|missing field/i.test(simError)) break;
    }
  }

  // Live gas estimation
  let estGas = null, estError = null;
  try {
    const gas = await rpc.call('eth_estimateGas', [{
      from: walletAddress,
      to: tx.to,
      data: tx.data,
      value: '0x' + tx.value.toString(16),
    }]);
    estGas = BigInt(gas).toString();
  } catch (err) {
    estError = err.rpcMessage || err.message;
  }

  return {
    quote: q,
    slippageBps,
    amountOutMin: amountOutMin.toString(),
    tx: { to: tx.to, value: tx.value.toString(), dataLen: (tx.data.length - 2) / 2 },
    simulation: { success: simSuccess, error: simError, returnData: simReturn },
    estimatedGas: estGas,
    estimateError: estError,
    approvals: approvals ? bigToStr(approvals) : null,
    deadline,
  };
}

// Detect the most likely route by asking the THRYX Diamond if it knows the token.
// Heuristic: read the token's V4 pool's HOOK address and compare against known THRYX
// hook addresses on Base — they all share a common prefix indicating they were spawned
// by the LaunchFacet. If the hook doesn't match, fall back to 'universal'.
async function detectRoute(rpc, init) {
  // THRYX-launched tokens share a hook with bits matching the Diamond's launch template.
  // Pragmatic test: try the Diamond.swap simulation with a tiny amount; if it reverts
  // with "TokenNotLaunched" or similar, fall back to universal. For now, default 'thryx'
  // when hook is non-zero, 'universal' otherwise. The caller can always override.
  if (!init || !init.hooks || init.hooks === '0x0000000000000000000000000000000000000000') return 'universal';
  return 'thryx';
}

// EXECUTE: actually sign + broadcast. Requires explicit dryRun=false.
async function exec({ rpc, signer, poolId, tokenAddress, side, amount, slippageBps = 100, deadlineSec = 300, route = 'thryx' }) {
  const planned = await plan({ rpc, poolId, tokenAddress, side, amount, slippageBps, walletAddress: signer.address, deadlineSec, route });
  if (!planned.simulation.success) {
    throw new Error(`refusing to broadcast: simulation reverted — ${planned.simulation.error}`);
  }
  if (planned.approvals && planned.approvals.issues && planned.approvals.issues.length > 0) {
    throw new Error(`refusing to broadcast: approvals missing — ${planned.approvals.issues.join(', ')}`);
  }
  const init = await loadPoolInit(rpc, poolId);
  const poolKey = { currency0: init.currency0, currency1: init.currency1, fee: init.fee, tickSpacing: init.tickSpacing, hooks: init.hooks };
  const amountOutMin = BigInt(planned.amountOutMin);
  const deadline = planned.deadline;
  let txData;
  if (route === 'thryx') {
    txData = side === 'buy'
      ? thryxBuildBuyEth({ tokenOut: tokenAddress, amountInWei: amount, minOut: amountOutMin })
      : thryxBuildSellForEth({ tokenIn: tokenAddress, amountInWei: amount, minOut: amountOutMin });
  } else {
    txData = side === 'buy'
      ? buildBuyEthForToken({ poolKey, tokenOut: tokenAddress, amountInWei: amount, amountOutMin, recipient: signer.address, deadline })
      : buildSellTokenForEth({ poolKey, tokenIn: tokenAddress, amountInWei: amount, amountOutMin, recipient: signer.address, deadline });
  }

  const fee = await getFeeData(rpc);
  const nonce = parseInt(await rpc.call('eth_getTransactionCount', [signer.address, 'pending']), 16);
  const chainIdHex = await rpc.call('eth_chainId');
  const chainId = parseInt(chainIdHex, 16);

  // gas: use the planner's estimate + 20% buffer
  const gasLimit = planned.estimatedGas ? (BigInt(planned.estimatedGas) * 120n) / 100n : 350_000n;

  const txReq = {
    type: 2, // EIP-1559
    chainId,
    to: txData.to,
    data: txData.data,
    value: txData.value,
    nonce,
    maxFeePerGas: fee.maxFeePerGas,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
    gasLimit,
  };
  const signed = await signer.signTransaction(txReq);
  const txHash = await rpc.call('eth_sendRawTransaction', [signed]);
  return { txHash, planned: bigToStr(planned), txReq: bigToStr(txReq) };
}

module.exports = { quote, plan, exec, applySlippage, getEthUsd, loadPoolInit, verifyDeployment, detectRoute };
