// V4 Quoter wrapper.
//
// V4's Quoter exposes `quoteExactInputSingle(QuoteExactSingleParams)` returning
// (uint256 amountOut, uint256 gasEstimate). It works over `eth_call` — no signer needed.
//
// PoolKey is the canonical {currency0, currency1, fee, tickSpacing, hooks}.

const { Interface } = require('ethers');
const { ADDR } = require('./addresses');

const QUOTER_ABI = [
  // QuoteExactSingleParams: (PoolKey poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData)
  // PoolKey: (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)
  'function quoteExactInputSingle((( address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks ) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)',
  'function quoteExactOutputSingle((( address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks ) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountIn, uint256 gasEstimate)',
];
const iface = new Interface(QUOTER_ABI);

// Build the PoolKey object for the canonical V4 (currency0 < currency1 by address sort).
function buildPoolKey(init) {
  return {
    currency0: init.currency0,
    currency1: init.currency1,
    fee: init.fee,
    tickSpacing: init.tickSpacing,
    hooks: init.hooks,
  };
}

// Quote an exact-input swap. tokenIn = address you're spending. amountIn in wei (BigInt).
// Returns { amountOut: BigInt, gasEstimate: BigInt, zeroForOne: bool }.
async function quoteExactIn(rpc, init, tokenIn, amountIn, hookData = '0x') {
  const poolKey = buildPoolKey(init);
  const zeroForOne = tokenIn.toLowerCase() === init.currency0.toLowerCase();
  const params = { poolKey, zeroForOne, exactAmount: amountIn, hookData };
  const data = iface.encodeFunctionData('quoteExactInputSingle', [params]);
  const ret = await rpc.ethCall(ADDR.V4_QUOTER, data);
  const [amountOut, gasEstimate] = iface.decodeFunctionResult('quoteExactInputSingle', ret);
  return { amountOut: BigInt(amountOut), gasEstimate: BigInt(gasEstimate), zeroForOne };
}

// Quote an exact-output swap. tokenOut = address you want. amountOut in wei (BigInt).
// Returns { amountIn: BigInt, gasEstimate: BigInt, zeroForOne: bool }.
async function quoteExactOut(rpc, init, tokenOut, amountOut, hookData = '0x') {
  const poolKey = buildPoolKey(init);
  // exactOutput: zeroForOne means we're taking currency1 out (wanting tokenOut = currency1)
  const zeroForOne = tokenOut.toLowerCase() === init.currency1.toLowerCase();
  const params = { poolKey, zeroForOne, exactAmount: amountOut, hookData };
  const data = iface.encodeFunctionData('quoteExactOutputSingle', [params]);
  const ret = await rpc.ethCall(ADDR.V4_QUOTER, data);
  const [amountIn, gasEstimate] = iface.decodeFunctionResult('quoteExactOutputSingle', ret);
  return { amountIn: BigInt(amountIn), gasEstimate: BigInt(gasEstimate), zeroForOne };
}

module.exports = { quoteExactIn, quoteExactOut, buildPoolKey };
