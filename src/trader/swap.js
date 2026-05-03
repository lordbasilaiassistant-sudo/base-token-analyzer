// Universal Router V4 swap construction.
//
// Two swap shapes covered:
//   • BUY (native ETH → token via WETH/V4): WRAP_ETH → V4_SWAP(SWAP_EXACT_IN_SINGLE,SETTLE_ALL,TAKE_ALL)
//   • SELL (token → WETH → unwrap to ETH): permit2 transferFrom → V4_SWAP(...) → UNWRAP_WETH
//
// We don't issue Permit2 signatures here; for the SELL path the trader must have already
// approved Permit2 to spend the token AND issued a Permit2 allowance to the Universal
// Router. See approvals.js.

const { Interface, AbiCoder, getAddress, ZeroAddress } = require('ethers');
const { ADDR, CMD, ACTION } = require('./addresses');

// Universal Router internal-address sentinels (Dispatcher/Constants):
//   address(1) = MSG_SENDER (the EOA that called execute)
//   address(2) = ADDRESS_THIS (the router contract itself)
const MSG_SENDER   = '0x0000000000000000000000000000000000000001';
const ADDRESS_THIS = '0x0000000000000000000000000000000000000002';
// V4 currency convention: address(0) = native ETH (handled by router as msg.value)
const NATIVE_ETH   = '0x0000000000000000000000000000000000000000';

const URv2 = [
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
];
const ur = new Interface(URv2);
const coder = AbiCoder.defaultAbiCoder();

// Encode a `bytes` command sequence: just concatenated 1-byte tags.
function encodeCommands(tags) {
  return '0x' + tags.map(t => t.toString(16).padStart(2, '0')).join('');
}

// V4_SWAP body = abi.encode(bytes actions, bytes[] params) where actions is the same
// 1-byte concat trick.
function encodeV4SwapBody(actions, params) {
  const actionBytes = '0x' + actions.map(a => a.toString(16).padStart(2, '0')).join('');
  return coder.encode(['bytes', 'bytes[]'], [actionBytes, params]);
}

// Build SWAP_EXACT_IN_SINGLE params bytes. amountIn / amountOutMin in wei (BigInt).
function encodeExactInSingle(poolKey, zeroForOne, amountIn, amountOutMin, hookData = '0x') {
  const TUPLE = '((address,address,uint24,int24,address),bool,uint128,uint128,bytes)';
  return coder.encode([TUPLE], [[
    [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
    zeroForOne,
    amountIn,
    amountOutMin,
    hookData,
  ]]);
}

// SETTLE_ALL: (address currency, uint256 maxAmount)
function encodeSettleAll(currency, maxAmount) {
  return coder.encode(['address', 'uint256'], [currency, maxAmount]);
}
// TAKE_ALL: (address currency, uint256 minAmount)
function encodeTakeAll(currency, minAmount) {
  return coder.encode(['address', 'uint256'], [currency, minAmount]);
}

// SWEEP: (address token, address recipient, uint256 amountMin) — exits leftovers in router
function encodeSweep(token, recipient, amountMin) {
  return coder.encode(['address', 'address', 'uint256'], [token, recipient, amountMin]);
}

// Build a complete BUY tx: send `amountInEth` of native ETH, receive >= `amountOutMin` of token.
// Returns { to, data, value } ready for sendTransaction OR eth_call.
function buildBuyEthForToken({ poolKey, tokenOut, amountInWei, amountOutMin, recipient, hookData = '0x', deadline }) {
  // BUY = WRAP_ETH + V4_SWAP. The V4 actions: SWAP_EXACT_IN_SINGLE → SETTLE_ALL(WETH) → TAKE_ALL(token)
  // After WRAP_ETH the wrapped WETH sits in the router; V4 settles the input from the router's balance.
  const zeroForOne = poolKey.currency0.toLowerCase() === ADDR.WETH.toLowerCase();
  // sanity: V4_SWAP requires the token ordering of the pool. zeroForOne true = WETH (currency0) → token (currency1).
  const isWethToken0 = zeroForOne;
  if (isWethToken0 && poolKey.currency1.toLowerCase() !== tokenOut.toLowerCase())
    throw new Error('tokenOut does not match poolKey.currency1');
  if (!isWethToken0 && poolKey.currency0.toLowerCase() !== tokenOut.toLowerCase())
    throw new Error('tokenOut does not match poolKey.currency0');

  const wrapInput = coder.encode(['address', 'uint256'], [ADDR.UNIVERSAL_ROUTER, amountInWei]);
  const v4Body = encodeV4SwapBody(
    [ACTION.SWAP_EXACT_IN_SINGLE, ACTION.SETTLE_ALL, ACTION.TAKE_ALL],
    [
      encodeExactInSingle(poolKey, zeroForOne, amountInWei, amountOutMin, hookData),
      encodeSettleAll(ADDR.WETH, amountInWei),
      encodeTakeAll(tokenOut, amountOutMin),
    ]
  );
  const commands = encodeCommands([CMD.WRAP_ETH, CMD.V4_SWAP]);
  const data = ur.encodeFunctionData('execute', [commands, [wrapInput, v4Body], BigInt(deadline)]);
  return { to: ADDR.UNIVERSAL_ROUTER, data, value: amountInWei };
}

// Build a complete SELL tx: token → WETH → ETH, recipient receives ≥ `amountOutMin` of ETH.
// Caller must have approved Permit2 for the token AND given Permit2 allowance to the router.
function buildSellTokenForEth({ poolKey, tokenIn, amountInWei, amountOutMin, recipient, hookData = '0x', deadline }) {
  const zeroForOne = poolKey.currency0.toLowerCase() === tokenIn.toLowerCase();
  const v4Body = encodeV4SwapBody(
    [ACTION.SWAP_EXACT_IN_SINGLE, ACTION.SETTLE_ALL, ACTION.TAKE_ALL],
    [
      encodeExactInSingle(poolKey, zeroForOne, amountInWei, amountOutMin, hookData),
      encodeSettleAll(tokenIn, amountInWei),
      encodeTakeAll(ADDR.WETH, amountOutMin),
    ]
  );
  const unwrapInput = coder.encode(['address', 'uint256'], [recipient, amountOutMin]);
  const commands = encodeCommands([CMD.V4_SWAP, CMD.UNWRAP_WETH]);
  const data = ur.encodeFunctionData('execute', [commands, [v4Body, unwrapInput], BigInt(deadline)]);
  return { to: ADDR.UNIVERSAL_ROUTER, data, value: 0n };
}

module.exports = { buildBuyEthForToken, buildSellTokenForEth };
