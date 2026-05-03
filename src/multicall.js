// Multicall3 batch reader. Address is canonical across all EVM chains.
const { Interface, AbiCoder } = require('ethers');

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

const ABI = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)',
];
const iface = new Interface(ABI);
const coder = AbiCoder.defaultAbiCoder();

async function aggregate3(rpc, calls) {
  const data = iface.encodeFunctionData('aggregate3', [calls]);
  const ret = await rpc.ethCall(MULTICALL3, data);
  const [decoded] = iface.decodeFunctionResult('aggregate3', ret);
  return decoded.map(d => ({ success: d.success, returnData: d.returnData }));
}

// Convenience: single-batch decode given parallel result types/iface
function decodeOne(itf, fn, returnData) {
  if (!returnData || returnData === '0x') return null;
  try {
    const r = itf.decodeFunctionResult(fn, returnData);
    return r.length === 1 ? r[0] : r;
  } catch {
    return null;
  }
}

module.exports = { aggregate3, decodeOne, MULTICALL3, coder };
