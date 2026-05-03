// THRYX Diamond router — for buying/selling tokens via the THRYX protocol.
//
// IMPORTANT: This router only works for tokens launched by THRYX (or THRYX itself).
// Other Base tokens use the standard Universal Router path (--route universal).
//
// Three flows are exposed by the Diamond:
//
//   1. ThryxSwapFacet.buyThryxWithEth(uint256 minThryxOut) payable
//      ETH → THRYX directly via the V4 Doppler pool. Use this for the protocol token.
//
//   2. ThryxSwapFacet.sellThryxForEth(uint256 thryxAmount, uint256 minEthOut)
//      THRYX → ETH. Caller must approve(Diamond, thryxAmount) on THRYX first.
//
//   3. SwapFacet.swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut) payable
//      Generic swap for OTHER launched tokens (those with bonding curves or graduated).
//      ETH → launched token, THRYX → launched token, launched token → ETH/THRYX.
//
// We auto-pick the right one based on tokenIn/tokenOut. The user-facing API is
// `buildBuyEth({ tokenOut, amountInWei, minOut })` and `buildSellForEth(...)`.

const { Interface } = require('ethers');

const DIAMOND = '0x2F77b40c124645d25782CfBdfB1f54C1d76f2cCe';
const THRYX_TOKEN = '0xc07E889e1816De2708BF718683e52150C20F3BA3';
const NATIVE = '0x0000000000000000000000000000000000000000';

// ABIs for the three facets we need.
const swapFacet = new Interface([
  'function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut) payable returns (uint256 amountOut)',
]);
const thryxSwapFacet = new Interface([
  'function buyThryxWithEth(uint256 minThryxOut) payable returns (uint256 thryxOut)',
  'function sellThryxForEth(uint256 thryxAmount, uint256 minEthOut) returns (uint256 ethOut)',
]);

// Build a tx that BUYS `tokenOut` with native ETH.
// If tokenOut == THRYX, route to ThryxSwapFacet.buyThryxWithEth.
// Otherwise route to SwapFacet.swap(NATIVE, tokenOut, ...).
function buildBuyEth({ tokenOut, amountInWei, minOut }) {
  if (tokenOut.toLowerCase() === THRYX_TOKEN.toLowerCase()) {
    return {
      to: DIAMOND,
      data: thryxSwapFacet.encodeFunctionData('buyThryxWithEth', [minOut]),
      value: amountInWei,
    };
  }
  return {
    to: DIAMOND,
    data: swapFacet.encodeFunctionData('swap', [NATIVE, tokenOut, 0, minOut]),
    value: amountInWei,
  };
}

// Build a tx that SELLS `tokenIn` for native ETH. Caller must pre-approve Diamond.
// If tokenIn == THRYX, route to ThryxSwapFacet.sellThryxForEth.
function buildSellForEth({ tokenIn, amountInWei, minOut }) {
  if (tokenIn.toLowerCase() === THRYX_TOKEN.toLowerCase()) {
    return {
      to: DIAMOND,
      data: thryxSwapFacet.encodeFunctionData('sellThryxForEth', [amountInWei, minOut]),
      value: 0n,
    };
  }
  return {
    to: DIAMOND,
    data: swapFacet.encodeFunctionData('swap', [tokenIn, NATIVE, amountInWei, minOut]),
    value: 0n,
  };
}

const ERC20 = new Interface([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

async function readErc20Allowance(rpc, token, owner) {
  const ret = await rpc.ethCall(token, ERC20.encodeFunctionData('allowance', [owner, DIAMOND]));
  const [v] = ERC20.decodeFunctionResult('allowance', ret);
  return BigInt(v);
}

function buildErc20ApproveDiamondTx(token, amount = (1n << 256n) - 1n) {
  return {
    to: token,
    data: ERC20.encodeFunctionData('approve', [DIAMOND, amount]),
    value: 0n,
  };
}

module.exports = {
  DIAMOND, THRYX_TOKEN, NATIVE,
  buildBuyEth, buildSellForEth,
  readErc20Allowance, buildErc20ApproveDiamondTx,
};
