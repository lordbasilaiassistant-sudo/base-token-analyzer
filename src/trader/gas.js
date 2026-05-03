// Live Base gas snapshot + cost helpers.

const { formatEther } = require('ethers');

async function getGasPrice(rpc) {
  const hex = await rpc.call('eth_gasPrice');
  return BigInt(hex);
}

// EIP-1559 fee data: returns { gasPrice, maxFeePerGas, maxPriorityFeePerGas }.
async function getFeeData(rpc) {
  const [gasPriceHex, blockHex] = await Promise.all([
    rpc.call('eth_gasPrice'),
    rpc.call('eth_getBlockByNumber', ['latest', false]),
  ]);
  const gasPrice = BigInt(gasPriceHex);
  const baseFee = blockHex && blockHex.baseFeePerGas ? BigInt(blockHex.baseFeePerGas) : 0n;
  const priority = baseFee > 0n ? 1_000_000n : gasPrice; // 0.001 gwei priority on Base
  const maxFeePerGas = baseFee > 0n ? baseFee * 2n + priority : gasPrice;
  return { gasPrice, baseFee, maxFeePerGas, maxPriorityFeePerGas: priority };
}

// Cost of `gasUnits` at `wei/gas`, converted to USD using `ethUsd` (number).
function costEth(gasUnits, weiPerGas) {
  return BigInt(gasUnits) * BigInt(weiPerGas);
}
function costUsd(weiCost, ethUsd) {
  const eth = Number(formatEther(weiCost));
  return eth * ethUsd;
}

module.exports = { getGasPrice, getFeeData, costEth, costUsd };
