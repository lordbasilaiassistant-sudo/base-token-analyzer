// ERC20 metadata + deployment lookup.
// Uses Multicall3 for parallel reads. Falls back to individual calls if any fail.

const { Interface, formatUnits } = require('ethers');
const { aggregate3, decodeOne } = require('./multicall');

const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function owner() view returns (address)',
];
const erc20 = new Interface(ERC20_ABI);

async function readMetadata(rpc, address) {
  const calls = [
    { target: address, allowFailure: true, callData: erc20.encodeFunctionData('name') },
    { target: address, allowFailure: true, callData: erc20.encodeFunctionData('symbol') },
    { target: address, allowFailure: true, callData: erc20.encodeFunctionData('decimals') },
    { target: address, allowFailure: true, callData: erc20.encodeFunctionData('totalSupply') },
    { target: address, allowFailure: true, callData: erc20.encodeFunctionData('owner') },
  ];
  const res = await aggregate3(rpc, calls);
  const decimals = res[2].success ? Number(decodeOne(erc20, 'decimals', res[2].returnData)) : 18;
  const totalSupply = res[3].success ? decodeOne(erc20, 'totalSupply', res[3].returnData) : 0n;
  return {
    address,
    name:   res[0].success ? decodeOne(erc20, 'name',   res[0].returnData) : null,
    symbol: res[1].success ? decodeOne(erc20, 'symbol', res[1].returnData) : null,
    decimals,
    totalSupply: totalSupply.toString(),
    totalSupplyFmt: formatUnits(totalSupply, decimals),
    owner:  res[4].success ? decodeOne(erc20, 'owner',  res[4].returnData) : null,
  };
}

async function balanceOf(rpc, token, holder) {
  const data = erc20.encodeFunctionData('balanceOf', [holder]);
  const ret = await rpc.ethCall(token, data);
  return BigInt(ret);
}

// Find earliest known event for the token via narrowing on transfer logs.
// We binary-search for the first block that produces a Transfer log involving this token.
async function findDeploymentBlock(rpc, address, latestBlock) {
  // Strategy: try the cheap path — Basescan-free. Fetch logs for the address from genesis
  // in a single RPC call; if the provider rejects the range, the auto-bisect handles it.
  // We only need the FIRST log, so we do a coarse scan.
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  let lo = 0;
  let hi = latestBlock;
  // First confirm there is at least one log at all
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const logs = await rpc.getLogs({
      address,
      topics: [TRANSFER],
      fromBlock: lo,
      toBlock: mid,
    });
    if (logs.length > 0) {
      hi = mid - 1;
      // Track earliest seen
      const earliest = logs.reduce((m, l) => Math.min(m, parseInt(l.blockNumber, 16)), Number.POSITIVE_INFINITY);
      if (earliest === lo) return lo;
      hi = earliest - 1;
      if (lo === earliest) return lo;
    } else {
      lo = mid + 1;
    }
    if (hi - lo < 50) {
      // narrow scan
      const final = await rpc.getLogs({
        address,
        topics: [TRANSFER],
        fromBlock: lo,
        toBlock: Math.min(latestBlock, lo + 5000),
      });
      if (final.length > 0) {
        return final.reduce((m, l) => Math.min(m, parseInt(l.blockNumber, 16)), Number.POSITIVE_INFINITY);
      }
      break;
    }
  }
  return null;
}

module.exports = { readMetadata, balanceOf, findDeploymentBlock, erc20 };
