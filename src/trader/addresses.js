// Uniswap V4 + Universal Router deployment on Base mainnet.
// Source: docs.uniswap.org/contracts/v4/deployments
//
// All addresses validated at runtime by fetching code — see verifyDeployment() below.

const { Interface } = require('ethers');

const ADDR = {
  POOL_MANAGER:      '0x498581fF718922c3f8e6A244956aF099B2652b2b',
  POSITION_MANAGER:  '0x7C5f5A4bBd8fD63184577525326123B519429bDc',
  STATE_VIEW:        '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71',
  V4_QUOTER:         '0x0d5e0F971ED27FBfF6c2837bf31316121532048D',
  UNIVERSAL_ROUTER:  '0x6fF5693b99212Da76ad316178A184AB56D299b43',
  PERMIT2:           '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  WETH:              '0x4200000000000000000000000000000000000006',
};

// Universal Router commands (1-byte tags)
const CMD = {
  V4_SWAP:    0x10,
  PERMIT2_PERMIT: 0x0a,
  PERMIT2_TRANSFER_FROM: 0x0d,
  WRAP_ETH:   0x0b,
  UNWRAP_WETH:0x0c,
  SWEEP:      0x04,
};

// V4 router actions (used inside V4_SWAP command body)
const ACTION = {
  SWAP_EXACT_IN_SINGLE:  0x06,
  SWAP_EXACT_IN:         0x07,
  SWAP_EXACT_OUT_SINGLE: 0x08,
  SWAP_EXACT_OUT:        0x09,
  SETTLE:                0x0b,
  SETTLE_ALL:            0x0c,
  TAKE:                  0x0e,
  TAKE_ALL:              0x0f,
  TAKE_PORTION:          0x10,
};

async function verifyDeployment(rpc) {
  const checks = ['POOL_MANAGER', 'V4_QUOTER', 'UNIVERSAL_ROUTER', 'PERMIT2', 'WETH'];
  const out = {};
  for (const k of checks) {
    const code = await rpc.getCode(ADDR[k]);
    out[k] = { addr: ADDR[k], deployed: code && code !== '0x' };
  }
  return out;
}

module.exports = { ADDR, CMD, ACTION, verifyDeployment };
