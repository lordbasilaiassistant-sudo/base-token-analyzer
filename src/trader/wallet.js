// Trader wallet loader — reads the trader EOA private key from the secure off-OneDrive
// store at ~/.claude/secrets/thryxtokenchecks.env. NEVER reads from project-local .env.
//
// Returns { address, signer } where `signer` is a no-provider Wallet — bind to a provider
// (or pass to a JsonRpcProvider) before calling sendTransaction.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Wallet } = require('ethers');

const SECRET_PATH = path.join(os.homedir(), '.claude', 'secrets', 'thryxtokenchecks.env');

function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 1) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

function loadWallet() {
  if (!fs.existsSync(SECRET_PATH)) {
    throw new Error(
      `Trader key not found at ${SECRET_PATH}.\n` +
      `Create it with two lines:\n` +
      `  TRADER_ADDRESS=0x...\n` +
      `  TRADER_PRIVATE_KEY=0x...\n` +
      `(Off-OneDrive location is mandatory — never put keys in this OneDrive-synced project.)`
    );
  }
  const env = parseEnv(fs.readFileSync(SECRET_PATH, 'utf8'));
  if (!env.TRADER_PRIVATE_KEY) throw new Error(`TRADER_PRIVATE_KEY missing from ${SECRET_PATH}`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(env.TRADER_PRIVATE_KEY)) throw new Error(`TRADER_PRIVATE_KEY malformed`);
  const w = new Wallet(env.TRADER_PRIVATE_KEY);
  if (env.TRADER_ADDRESS && w.address.toLowerCase() !== env.TRADER_ADDRESS.toLowerCase()) {
    throw new Error(`TRADER_ADDRESS mismatch: env says ${env.TRADER_ADDRESS}, key derives ${w.address}`);
  }
  return { address: w.address, signer: w };
}

module.exports = { loadWallet, SECRET_PATH };
