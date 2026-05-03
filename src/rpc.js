// Aggregated JSON-RPC client for Base mainnet.
// - round-robin across PROVIDERS, weighted
// - on 429 / 5xx / "rate limited" / -32005 / -32602: cool down provider, retry on next
// - eth_getLogs auto-bisects on "result set too large" / "block range too large" errors
// - falls back gracefully when a provider returns null/empty

const { PROVIDERS, BASE_CHAIN_ID } = require('./providers');

const RATE_LIMIT_KEYWORDS = [
  'rate limit', 'too many requests', '429', 'limit exceeded',
  'request rate', 'throttle', 'capacity',
];
const RANGE_TOO_LARGE_KEYWORDS = [
  'block range', 'range is too large', 'log response size', 'too many logs',
  'result set too large', 'response size', 'query returned more', 'exceeds max',
  'larger than the max', 'too wide', 'span', 'eth_getLogs',
];

class ProviderState {
  constructor(p) {
    this.name = p.name;
    this.url = p.url;
    this.weight = p.weight;
    this.cooldownUntil = 0;
    this.consecutiveFails = 0;
    this.latencyMs = 200;
    this.requests = 0;
  }
  isHealthy(now = Date.now()) { return now >= this.cooldownUntil; }
  cool(now = Date.now()) {
    this.consecutiveFails = Math.min(this.consecutiveFails + 1, 5);
    const ms = Math.min(30_000 * 2 ** (this.consecutiveFails - 1), 5 * 60_000);
    this.cooldownUntil = now + ms;
  }
  recover(latencyMs) {
    this.consecutiveFails = 0;
    this.cooldownUntil = 0;
    this.latencyMs = this.latencyMs * 0.7 + latencyMs * 0.3;
  }
}

class RpcAgg {
  constructor() {
    this.states = PROVIDERS.map(p => new ProviderState(p));
    this.cursor = 0;
    this.id = 1;
  }

  // Pick the healthiest provider not in `excluded`, preferring lower latency and weight.
  pick(excluded = new Set()) {
    const now = Date.now();
    const candidates = this.states.filter(s => s.isHealthy(now) && !excluded.has(s.name));
    if (candidates.length === 0) {
      // Force-pick anyone (cooldowns may have expired) — last resort
      const any = this.states.filter(s => !excluded.has(s.name));
      if (any.length === 0) return null;
      return any[Math.floor(Math.random() * any.length)];
    }
    candidates.sort((a, b) => (a.latencyMs / a.weight) - (b.latencyMs / b.weight));
    // Slight rotation to spread load — pick from top 3 round-robin
    const top = candidates.slice(0, Math.min(3, candidates.length));
    const choice = top[this.cursor % top.length];
    this.cursor++;
    return choice;
  }

  async _rawCall(state, method, params, timeoutMs = 30_000) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: this.id++, method, params });
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(state.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const latency = Date.now() - t0;
    state.requests++;
    if (res.status === 429) { state.cool(); throw new Error(`429 rate limited (${state.name})`); }
    if (!res.ok) { state.cool(); throw new Error(`HTTP ${res.status} from ${state.name}`); }
    const json = await res.json();
    if (json.error) {
      const msg = (json.error.message || '').toLowerCase();
      if (RATE_LIMIT_KEYWORDS.some(k => msg.includes(k))) state.cool();
      const e = new Error(`${state.name}: ${json.error.message}`);
      e.code = json.error.code;
      e.rpcMessage = json.error.message;
      throw e;
    }
    state.recover(latency);
    return json.result;
  }

  async call(method, params = [], { maxAttempts = 12 } = {}) {
    let excluded = new Set();
    let lastErr;
    for (let i = 0; i < maxAttempts; i++) {
      let state = this.pick(excluded);
      if (!state) {
        // Every healthy provider exhausted this round — wait for the soonest cooldown,
        // reset the exclusion set, and try again.
        const now = Date.now();
        const soonest = this.states.reduce((m, s) => Math.min(m, s.cooldownUntil || Infinity), Infinity);
        const waitMs = Math.min(Math.max(soonest - now, 250), 5_000);
        await new Promise(r => setTimeout(r, waitMs));
        excluded = new Set();
        state = this.pick(excluded);
        if (!state) break;
      }
      try {
        return await this._rawCall(state, method, params);
      } catch (err) {
        lastErr = err;
        excluded.add(state.name);
      }
    }
    throw lastErr || new Error(`all providers failed for ${method}`);
  }

  // High-level helpers
  async getBlockNumber() {
    const hex = await this.call('eth_blockNumber');
    return parseInt(hex, 16);
  }
  async getChainId() {
    const hex = await this.call('eth_chainId');
    return parseInt(hex, 16);
  }
  async getBlock(numberOrHash, includeTx = false) {
    const tag = typeof numberOrHash === 'number' ? '0x' + numberOrHash.toString(16) : numberOrHash;
    return this.call('eth_getBlockByNumber', [tag, includeTx]);
  }
  async getCode(address) {
    return this.call('eth_getCode', [address, 'latest']);
  }
  async ethCall(to, data, blockTag = 'latest') {
    return this.call('eth_call', [{ to, data }, blockTag]);
  }
  async getTransaction(hash) {
    return this.call('eth_getTransactionByHash', [hash]);
  }
  async getReceipt(hash) {
    return this.call('eth_getTransactionReceipt', [hash]);
  }

  // eth_getLogs with auto-bisect on range/size errors.
  async getLogs(filter, { onProgress } = {}) {
    const fromBlock = typeof filter.fromBlock === 'string' ? parseInt(filter.fromBlock, 16) : filter.fromBlock;
    const toBlock   = typeof filter.toBlock   === 'string' ? parseInt(filter.toBlock,   16) : filter.toBlock;
    return this._getLogsRange({ ...filter, fromBlock, toBlock }, onProgress);
  }

  async _getLogsRange(filter, onProgress) {
    const out = [];
    const MAX_LOGS = 500_000; // DoS guard — abort scans on attacker-spammed tokens
    const queue = [[filter.fromBlock, filter.toBlock]];
    while (queue.length) {
      const [from, to] = queue.shift();
      if (from > to) continue;
      if (out.length > MAX_LOGS) {
        throw new Error(`getLogs aborted: ${out.length} logs exceeds cap ${MAX_LOGS}. Narrow the block range with --from-block.`);
      }
      const f = {
        ...filter,
        fromBlock: '0x' + from.toString(16),
        toBlock: '0x' + to.toString(16),
      };
      try {
        const logs = await this.call('eth_getLogs', [f]);
        if (Array.isArray(logs)) out.push(...logs);
        if (onProgress) onProgress({ from, to, total: out.length });
      } catch (err) {
        const msg = (err.rpcMessage || err.message || '').toLowerCase();
        const tooLarge = RANGE_TOO_LARGE_KEYWORDS.some(k => msg.includes(k))
          || (err.code === -32602)
          || (err.code === -32005)
          || msg.includes('result set');
        if (tooLarge && from < to) {
          const mid = Math.floor((from + to) / 2);
          // Push back-to-front so we drain low-block first
          queue.unshift([mid + 1, to]);
          queue.unshift([from, mid]);
        } else if (tooLarge && from === to) {
          // Single block emits more logs than provider cap. Skip with warning.
          console.warn(`[rpc] block ${from} exceeds single-block log cap; skipping`);
        } else {
          throw err;
        }
      }
    }
    return out;
  }

  stats() {
    return this.states
      .map(s => ({ name: s.name, requests: s.requests, latency: Math.round(s.latencyMs), fails: s.consecutiveFails, cooldownMs: Math.max(0, s.cooldownUntil - Date.now()) }))
      .sort((a, b) => b.requests - a.requests);
  }
}

module.exports = { RpcAgg, BASE_CHAIN_ID };
