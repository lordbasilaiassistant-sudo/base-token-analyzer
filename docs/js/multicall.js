// Multicall3 helper — browser ESM, ethers v6 via CDN.

import { Interface } from 'https://cdn.jsdelivr.net/npm/ethers@6.13.4/+esm';

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

const ABI = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)',
];
const iface = new Interface(ABI);

export async function aggregate3(rpc, calls) {
  const data = iface.encodeFunctionData('aggregate3', [calls]);
  const ret = await rpc.ethCall(MULTICALL3, data);
  const [decoded] = iface.decodeFunctionResult('aggregate3', ret);
  return decoded.map(d => ({ success: d.success, returnData: d.returnData }));
}

export function decodeOne(itf, fn, returnData) {
  if (!returnData || returnData === '0x') return null;
  try {
    const r = itf.decodeFunctionResult(fn, returnData);
    return r.length === 1 ? r[0] : r;
  } catch {
    return null;
  }
}
