import { id, AbiCoder } from 'https://cdn.jsdelivr.net/npm/ethers@6.13.4/+esm';

export const POOL_MANAGER = '0x498581fF718922c3f8e6A244956aF099B2652b2b';
export const V4_MIN_BLOCK = 25_300_000;
export const DYNAMIC_FEE_FLAG = 0x800000;
export function isDynamicFee(fee) { return (Number(fee) & DYNAMIC_FEE_FLAG) !== 0; }

const SIG_INIT = 'Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)';
const SIG_SWAP = 'Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)';
const SIG_MOD  = 'ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)';

export const TOPIC_INIT = id(SIG_INIT);
export const TOPIC_SWAP = id(SIG_SWAP);
export const TOPIC_MOD  = id(SIG_MOD);

const coder = AbiCoder.defaultAbiCoder();

function addrFromTopic(t) { return '0x' + t.slice(26).toLowerCase(); }

export async function findInitialize(rpc, poolId, fromBlock, toBlock) {
  const start = Math.max(fromBlock || 0, V4_MIN_BLOCK);
  const logs = await rpc.getLogs({
    address: POOL_MANAGER,
    topics: [TOPIC_INIT, poolId],
    fromBlock: start,
    toBlock,
  });
  if (logs.length === 0) return null;
  const l = logs[0];
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

export async function crawlSwaps(rpc, poolId, fromBlock, toBlock, onProgress) {
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
      amount0: a0,
      amount1: a1,
      sqrtPriceX96,
      liquidity,
      tick: Number(tick),
      fee: Number(fee),
    };
  });
}

export function rawPriceFromSqrtX96(sqrtPriceX96) {
  const sp = BigInt(sqrtPriceX96);
  const num = sp * sp;
  const numShifted = num >> 64n;
  return Number(numShifted) / 2 ** 128;
}

export function priceWethPerToken(rawPrice, orientation, decimalsToken, decimalsWeth = 18) {
  if (orientation === 'token0') return rawPrice * 10 ** (decimalsToken - decimalsWeth);
  return (1 / rawPrice) * 10 ** (decimalsWeth - decimalsToken);
}
