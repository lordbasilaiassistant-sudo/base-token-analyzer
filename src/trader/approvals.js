// Approval helpers for the SELL path:
//   1. Token → Permit2: standard ERC20 approve. Set MAX_UINT once and forget.
//   2. Permit2 → Universal Router: Permit2.approve(token, spender, amount, expiration).
//      We default to a 30-day allowance with MAX_UINT160 amount.
//
// BUY path needs no approvals — we use native ETH which the router wraps internally.

const { Interface, MaxUint256 } = require('ethers');
const { ADDR } = require('./addresses');

const ERC20 = new Interface([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

const PERMIT2 = new Interface([
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);

const MAX_UINT160 = (1n << 160n) - 1n;

async function readErc20Allowance(rpc, token, owner, spender) {
  const data = ERC20.encodeFunctionData('allowance', [owner, spender]);
  const ret = await rpc.ethCall(token, data);
  const [v] = ERC20.decodeFunctionResult('allowance', ret);
  return BigInt(v);
}

async function readPermit2Allowance(rpc, owner, token, spender) {
  const data = PERMIT2.encodeFunctionData('allowance', [owner, token, spender]);
  const ret = await rpc.ethCall(ADDR.PERMIT2, data);
  const [amount, expiration, nonce] = PERMIT2.decodeFunctionResult('allowance', ret);
  return { amount: BigInt(amount), expiration: Number(expiration), nonce: Number(nonce) };
}

function buildErc20ApproveTx(token, spender, amount = MaxUint256) {
  return { to: token, data: ERC20.encodeFunctionData('approve', [spender, amount]), value: 0n };
}

function buildPermit2ApproveTx(token, spender, amount = MAX_UINT160, expirationSeconds = 30 * 24 * 60 * 60) {
  const expiration = Math.floor(Date.now() / 1000) + expirationSeconds;
  return {
    to: ADDR.PERMIT2,
    data: PERMIT2.encodeFunctionData('approve', [token, spender, amount, expiration]),
    value: 0n,
  };
}

// Returns ['need-erc20-approval', 'need-permit2-approval'] or [] if all good.
async function checkAllowances(rpc, token, owner) {
  const out = [];
  const erc = await readErc20Allowance(rpc, token, owner, ADDR.PERMIT2);
  if (erc < MaxUint256 / 2n) out.push('need-erc20-approval');
  const p2 = await readPermit2Allowance(rpc, owner, token, ADDR.UNIVERSAL_ROUTER);
  if (p2.amount === 0n || p2.expiration < Math.floor(Date.now() / 1000)) out.push('need-permit2-approval');
  return { issues: out, erc20: erc, permit2: p2 };
}

module.exports = {
  ERC20, PERMIT2, MAX_UINT160,
  readErc20Allowance, readPermit2Allowance,
  buildErc20ApproveTx, buildPermit2ApproveTx,
  checkAllowances,
};
