// Uniswap V4 PoolManager log reader — Base mainnet.
// Pulls Initialize + Swap events for a given poolId and decodes them into trades.

const { id, AbiCoder } = require('ethers');

// Base mainnet V4 PoolManager
const POOL_MANAGER = '0x498581fF718922c3f8e6A244956aF099B2652b2b';
// PoolManager went live Jan 21, 2025 — block ~25,355,400. Use a slightly earlier floor to be safe.
// Searching from this floor instead of genesis cuts the Initialize lookup by ~50%.
const V4_MIN_BLOCK = 25_300_000;
// V4 LPFeeLibrary flag — high bit of uint24 means the fee is set per-swap by the hook.
const DYNAMIC_FEE_FLAG = 0x800000;
function isDynamicFee(fee) { return (Number(fee) & DYNAMIC_FEE_FLAG) !== 0; }

const SIG_INIT = 'Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)';
const SIG_SWAP = 'Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)';
const SIG_MOD  = 'ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)';

const TOPIC_INIT = id(SIG_INIT);
const TOPIC_SWAP = id(SIG_SWAP);
const TOPIC_MOD  = id(SIG_MOD);

const coder = AbiCoder.defaultAbiCoder();

function addrFromTopic(t) { return '0x' + t.slice(26).toLowerCase(); }
function bytes32FromTopic(t) { return t.toLowerCase(); }

async function findInitialize(rpc, poolId, fromBlock, toBlock) {
  const start = Math.max(fromBlock || 0, V4_MIN_BLOCK);
  const logs = await rpc.getLogs({
    address: POOL_MANAGER,
    topics: [TOPIC_INIT, poolId],
    fromBlock: start,
    toBlock,
  });
  if (logs.length === 0) return null;
  const l = logs[0];
  // currency0 indexed (topic 2), currency1 indexed (topic 3)
  const [fee, tickSpacing, hooks, sqrtPriceX96, tick] =
    coder.decode(['uint24','int24','address','uint160','int24'], l.data);
  return {
    block: parseInt(l.blockNumber, 16),
    tx: l.transactionHash,
    poolId,
    currency0: addrFromTopic(l.topics[2]),
    currency1: addrFromTopic(l.topics[3]),
    fee: Number(fee),
    tickSpacing: Number(tickSpacing),
    hooks,
    sqrtPriceX96: sqrtPriceX96.toString(),
    tick: Number(tick),
  };
}

async function crawlSwaps(rpc, poolId, fromBlock, toBlock, onProgress) {
  const logs = await rpc.getLogs({
    address: POOL_MANAGER,
    topics: [TOPIC_SWAP, poolId],
    fromBlock,
    toBlock,
  }, { onProgress });
  return logs.map(l => {
    const [a0, a1, sqrtPriceX96, liquidity, tick, fee] =
      coder.decode(['int128','int128','uint160','uint128','int24','uint24'], l.data);
    return {
      block: parseInt(l.blockNumber, 16),
      tx: l.transactionHash,
      logIndex: parseInt(l.logIndex, 16),
      sender: addrFromTopic(l.topics[2]),
      amount0: a0,           // signed: + means pool gained token0, - means user took token0
      amount1: a1,
      sqrtPriceX96: sqrtPriceX96,
      liquidity: liquidity,
      tick: Number(tick),
      fee: Number(fee),
    };
  });
}

async function crawlModifyLiquidity(rpc, poolId, fromBlock, toBlock, onProgress) {
  const logs = await rpc.getLogs({
    address: POOL_MANAGER,
    topics: [TOPIC_MOD, poolId],
    fromBlock,
    toBlock,
  }, { onProgress });
  return logs.map(l => {
    const [tickLower, tickUpper, liquidityDelta, salt] =
      coder.decode(['int24','int24','int256','bytes32'], l.data);
    return {
      block: parseInt(l.blockNumber, 16),
      tx: l.transactionHash,
      sender: addrFromTopic(l.topics[2]),
      tickLower: Number(tickLower),
      tickUpper: Number(tickUpper),
      liquidityDelta,
      salt,
    };
  });
}

// price as token1 per token0 (raw, no decimal adjust). sqrtPriceX96^2 / 2^192.
// We use BigInt for the squaring so we don't lose precision, then convert to float
// only at the end with the smallest ratio possible.
function rawPriceFromSqrtX96(sqrtPriceX96) {
  const sp = BigInt(sqrtPriceX96);
  // sp can be up to ~2^160, so sp*sp can be up to ~2^320 — fine in BigInt.
  // We want (sp*sp) / 2^192 as a float.
  const num = sp * sp;            // sp^2
  // Reduce by 64 bits both num and denom (denom 2^192 → 2^128) to keep numbers small enough
  // for Number() without losing meaningful price bits.
  const numShifted = num >> 64n;  // sp^2 / 2^64
  const denomBits = 128;          // remaining 2^128 in the denominator
  return Number(numShifted) / 2 ** denomBits;
}

// Adjusted price in WETH per TOKEN, given which side is the token.
// orientation = 'token0' means TOKEN is currency0, so we want token1 (WETH) per token0 (TOKEN) = rawPrice
// orientation = 'token1' means TOKEN is currency1, so we want token0 (WETH) per token1 (TOKEN) = 1/rawPrice
function priceWethPerToken(rawPrice, orientation, decimalsToken, decimalsWeth = 18) {
  if (orientation === 'token0') {
    return rawPrice * 10 ** (decimalsToken - decimalsWeth);
  } else {
    return (1 / rawPrice) * 10 ** (decimalsWeth - decimalsToken);
  }
}

module.exports = {
  POOL_MANAGER, V4_MIN_BLOCK, DYNAMIC_FEE_FLAG, isDynamicFee,
  TOPIC_INIT, TOPIC_SWAP, TOPIC_MOD,
  findInitialize, crawlSwaps, crawlModifyLiquidity,
  rawPriceFromSqrtX96, priceWethPerToken,
};
