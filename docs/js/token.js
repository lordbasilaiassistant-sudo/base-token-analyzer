import { Interface, formatUnits } from 'https://cdn.jsdelivr.net/npm/ethers@6.13.4/+esm';
import { aggregate3, decodeOne } from './multicall.js';

const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function owner() view returns (address)',
];
export const erc20 = new Interface(ERC20_ABI);

export async function readMetadata(rpc, address) {
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
