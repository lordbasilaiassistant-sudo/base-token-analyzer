#!/usr/bin/env node
// THRYX Token Checks — trader CLI.
//
// Designed for both humans and AI agents. Default mode is QUOTE (read-only).
// To actually broadcast a transaction you must pass --execute, and the secret
// key file at ~/.claude/secrets/thryxtokenchecks.env must be present.
//
// EXIT CODES:
//   0 — success (quote returned, simulation passed, or tx broadcast)
//   2 — input validation error
//   3 — simulation reverted (refused to broadcast)
//   4 — missing approvals (refused to broadcast)
//   5 — RPC / network failure
//
// USAGE:
//   node trade.js quote   --side buy  --amount-eth 0.001
//   node trade.js plan    --side buy  --amount-eth 0.001 --slippage-bps 100
//   node trade.js execute --side buy  --amount-eth 0.001 --slippage-bps 100 --execute
//
//   --token   (default THRYX 0xc07E…3BA3)
//   --pool    (default THRYX V4 pool)
//   --route   thryx | universal  (default thryx — see ROUTING note below)
//   --json    (force JSON output, default for non-tty)
//   --raw     (skip BigInt stringification — internal debugging)
//
// ROUTING — important caveat:
// THRYX-launched tokens use a custom V4 hook that whitelists the THRYX Diamond as the
// only valid swap caller. Universal Router will fail with ExecutionFailed. So for any
// token launched by THRYX (default), we route through the Diamond at
// 0x2F77b40c124645d25782CfBdfB1f54C1d76f2cCe (calling its swap() facet).
// For ANY OTHER V4 pool (vanilla / different hook), pass --route universal.
// Future work: auto-detect by querying the Diamond's launch registry.

const { parseEther, formatEther } = require('ethers');
const { RpcAgg, BASE_CHAIN_ID } = require('./src/rpc');
const { quote, plan, exec, verifyDeployment } = require('./src/trader/trade');
const { loadWallet } = require('./src/trader/wallet');
const { buildErc20ApproveDiamondTx, readErc20Allowance, DIAMOND } = require('./src/trader/thryx');
const { getFeeData } = require('./src/trader/gas');

const DEFAULT_TOKEN = '0xc07E889e1816De2708BF718683e52150C20F3BA3';
const DEFAULT_POOL  = '0x5a86f04dbd3e6b532e4397eb605a4c23136dc913e0a60b65547842d2ce7876e8';

const isAddr = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);
const isPool = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s);

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { a[key] = true; }
      else { a[key] = next; i++; }
    } else {
      a._.push(t);
    }
  }
  return a;
}

function fail(code, msg, extra = {}) {
  console.error(JSON.stringify({ error: msg, code, ...extra }, null, 2));
  process.exit(code);
}
function ok(obj) {
  console.log(JSON.stringify(obj, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
  process.exit(0);
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const sub = args._[0] || 'quote';

  if (sub === 'help' || args.help) {
    console.log(`Usage: node trade.js <quote|plan|execute|verify> [options]

  --side buy|sell        (required for quote/plan/execute)
  --amount-eth 0.001     ETH amount for buy
  --amount-token 1000    raw token units (in token's decimals) for sell
  --token 0x...          (default THRYX ${DEFAULT_TOKEN.slice(0, 10)}…)
  --pool  0x...          (default THRYX V4 pool)
  --slippage-bps 100     1% (default 100)
  --deadline 300         seconds (default 300)
  --execute              REQUIRED to actually broadcast (otherwise: dry-run)

Subcommands:
  verify     check that the V4 router/quoter/permit2 are deployed at expected addresses
  quote      read-only: ask the V4 quoter for amountOut + gas hint
  plan       quote + simulate the actual swap tx via eth_call (no broadcast)
  execute    sign + broadcast (only if simulation passes; requires --execute flag)

Output is JSON; pipe through jq.`);
    process.exit(0);
  }

  // Build the RPC aggregator
  const rpc = new RpcAgg();
  let chainId;
  try { chainId = await rpc.getChainId(); }
  catch (e) { fail(5, `RPC connect failed: ${e.message}`); }
  if (chainId !== BASE_CHAIN_ID) fail(5, `Unexpected chain ${chainId}, expected Base (${BASE_CHAIN_ID})`);

  const token = args.token || DEFAULT_TOKEN;
  const poolId = args.pool || DEFAULT_POOL;
  if (!isAddr(token))  fail(2, `Invalid --token address: ${token}`);
  if (!isPool(poolId)) fail(2, `Invalid --pool poolId: ${poolId}`);

  if (sub === 'verify') {
    const v = await verifyDeployment(rpc);
    ok({ chainId, deployments: v });
  }

  if (sub === 'approve') {
    // Approve THRYX Diamond to spend the trader's tokenIn (sell-side prerequisite)
    const token = args.token || DEFAULT_TOKEN;
    if (!isAddr(token)) fail(2, `invalid --token`);
    let wallet;
    try { wallet = loadWallet(); } catch (e) { fail(2, e.message); }
    const allowance = await readErc20Allowance(rpc, token, wallet.address);
    if (!args.execute) {
      ok({ wallet: wallet.address, token, currentAllowance: allowance.toString(), requires: '--execute to broadcast approve' });
    }
    const fee = await getFeeData(rpc);
    const approveTx = buildErc20ApproveDiamondTx(token);
    const nonce = parseInt(await rpc.call('eth_getTransactionCount', [wallet.address, 'pending']), 16);
    const txReq = {
      type: 2, chainId,
      to: approveTx.to, data: approveTx.data, value: 0n,
      nonce, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
      gasLimit: 80_000n,
    };
    const signed = await wallet.signer.signTransaction(txReq);
    const txHash = await rpc.call('eth_sendRawTransaction', [signed]);
    ok({ wallet: wallet.address, token, broadcast: true, txHash });
  }

  // side / amount required for quote/plan/execute
  const side = args.side;
  if (!['buy', 'sell'].includes(side)) fail(2, `--side must be 'buy' or 'sell'`);

  let amount;
  if (side === 'buy') {
    if (!args['amount-eth']) fail(2, `--amount-eth required for buy`);
    try { amount = parseEther(String(args['amount-eth'])); }
    catch { fail(2, `--amount-eth not a valid ether amount: ${args['amount-eth']}`); }
  } else {
    if (!args['amount-token']) fail(2, `--amount-token required for sell (raw token units in token decimals)`);
    try { amount = BigInt(args['amount-token']); }
    catch { fail(2, `--amount-token not a valid integer: ${args['amount-token']}`); }
  }

  const slippageBps = parseInt(args['slippage-bps'] || '100', 10);
  const deadlineSec = parseInt(args.deadline || '300', 10);
  const route = args.route || 'thryx';
  if (!['thryx', 'universal'].includes(route)) fail(2, `--route must be 'thryx' or 'universal'`);

  if (sub === 'quote') {
    try { ok(await quote({ rpc, poolId, tokenAddress: token, side, amount })); }
    catch (e) { fail(5, e.message); }
  }

  if (sub === 'plan') {
    let walletAddr;
    try { walletAddr = loadWallet().address; } catch (e) {
      fail(2, `cannot load trader wallet: ${e.message}`);
    }
    try {
      const planned = await plan({ rpc, poolId, tokenAddress: token, side, amount, slippageBps, walletAddress: walletAddr, deadlineSec, route });
      if (!planned.simulation.success) process.exitCode = 3;
      ok({ wallet: walletAddr, route, ...planned });
    } catch (e) { fail(5, e.message); }
  }

  if (sub === 'execute') {
    if (!args.execute) fail(2, `refusing: 'execute' requires --execute flag (you'd actually broadcast)`);
    let wallet;
    try { wallet = loadWallet(); } catch (e) {
      fail(2, `cannot load trader wallet: ${e.message}`);
    }
    try {
      const r = await exec({ rpc, signer: wallet.signer, poolId, tokenAddress: token, side, amount, slippageBps, deadlineSec, route });
      ok({ wallet: wallet.address, route, broadcast: true, ...r });
    } catch (e) {
      if (e.message.startsWith('refusing to broadcast: simulation')) fail(3, e.message);
      if (e.message.startsWith('refusing to broadcast: approvals'))  fail(4, e.message);
      fail(5, e.message);
    }
  }

  fail(2, `unknown subcommand: ${sub}`);
}

main().catch(err => fail(5, err.message || String(err)));
