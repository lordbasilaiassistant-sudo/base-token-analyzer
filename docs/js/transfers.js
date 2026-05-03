import { AbiCoder, formatUnits } from 'https://cdn.jsdelivr.net/npm/ethers@6.13.4/+esm';

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000';
const coder = AbiCoder.defaultAbiCoder();

function topicToAddress(t) { return '0x' + t.slice(26).toLowerCase(); }

export async function crawlTransfers(rpc, address, fromBlock, toBlock, onProgress) {
  const logs = await rpc.getLogs({ address, topics: [TRANSFER_TOPIC], fromBlock, toBlock }, { onProgress });
  return logs.map(l => {
    const [value] = coder.decode(['uint256'], l.data);
    return {
      block: parseInt(l.blockNumber, 16),
      tx: l.transactionHash,
      logIndex: parseInt(l.logIndex, 16),
      from: topicToAddress(l.topics[1]),
      to:   topicToAddress(l.topics[2]),
      value,
    };
  });
}

export function buildHolderMap(transfers, decimals) {
  const balances = new Map();
  let mints = 0n, burns = 0n;
  for (const t of transfers) {
    if (t.from === ZERO) mints += t.value;
    else balances.set(t.from, (balances.get(t.from) || 0n) - t.value);
    if (t.to === ZERO) burns += t.value;
    else balances.set(t.to, (balances.get(t.to) || 0n) + t.value);
  }
  const holders = [...balances.entries()]
    .filter(([, v]) => v > 0n)
    .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
    .map(([address, balance]) => ({ address, balance: balance.toString(), balanceFmt: formatUnits(balance, decimals) }));
  return {
    holders,
    holderCount: holders.length,
    mintsFmt: formatUnits(mints, decimals),
    burnsFmt: formatUnits(burns, decimals),
    transferCount: transfers.length,
  };
}

export function concentration(holders, totalSupplyRaw) {
  const total = BigInt(totalSupplyRaw);
  if (total === 0n) return { top10Pct: 0, top50Pct: 0, top100Pct: 0 };
  const sumTop = (n) => holders.slice(0, n).reduce((s, h) => s + BigInt(h.balance), 0n);
  const pct = (n) => Number((sumTop(n) * 10000n) / total) / 100;
  return { top10Pct: pct(10), top50Pct: pct(50), top100Pct: pct(100) };
}
