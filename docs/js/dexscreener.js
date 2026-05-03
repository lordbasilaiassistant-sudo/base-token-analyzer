function assertAddress(a) {
  if (typeof a !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a)) {
    throw new Error(`invalid address: ${a}`);
  }
}

export async function fetchToken(address) {
  assertAddress(address);
  const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(address)}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`DexScreener ${res.status}`);
  return res.json();
}

export function pickBestPair(json, opts = {}) {
  const pairs = (json && json.pairs) || [];
  const onBase = pairs.filter(p => p.chainId === 'base');
  if (opts.pairAddress) {
    const want = opts.pairAddress.toLowerCase();
    const exact = onBase.find(p => p.pairAddress && p.pairAddress.toLowerCase() === want);
    if (exact) return exact;
  }
  const sorted = [...onBase].sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  return sorted[0] || null;
}

export function summarizePair(p) {
  if (!p) return null;
  return {
    pairAddress: p.pairAddress,
    dex: p.dexId,
    base: p.baseToken,
    quote: p.quoteToken,
    priceUsd: p.priceUsd ? Number(p.priceUsd) : null,
    priceNative: p.priceNative ? Number(p.priceNative) : null,
    liquidityUsd: p.liquidity?.usd || 0,
    fdv: p.fdv,
    marketCap: p.marketCap,
    volume24h: p.volume?.h24 || 0,
    volume6h:  p.volume?.h6  || 0,
    volume1h:  p.volume?.h1  || 0,
    volume5m:  p.volume?.m5  || 0,
    txns24h:   p.txns?.h24,
    txns1h:    p.txns?.h1,
    priceChange: p.priceChange,
    pairCreatedAt: p.pairCreatedAt,
    url: p.url,
  };
}
