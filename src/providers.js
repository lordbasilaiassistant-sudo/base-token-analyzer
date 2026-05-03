// Base mainnet RPC endpoints — borrowed from ../RPCagg/src/providers.js (kept in sync manually).
// Higher weight = preferred. Each provider tracks latency and 429 cooldown locally.

const BASE_CHAIN_ID = 8453;

const PROVIDERS = [
  { name: 'base-official',  url: 'https://mainnet.base.org',                                  weight: 10 },
  { name: 'publicnode',     url: 'https://base-rpc.publicnode.com',                            weight: 8 },
  { name: 'blast-api',      url: 'https://base-mainnet.public.blastapi.io',                   weight: 8 },
  { name: 'llamanodes',     url: 'https://base.llamarpc.com',                                 weight: 8 },
  { name: 'drpc',           url: 'https://base.drpc.org',                                     weight: 7 },
  { name: 'base-dev',       url: 'https://developer-access-mainnet.base.org',                 weight: 8 },
  { name: 'tenderly-pub',   url: 'https://gateway.tenderly.co/public/base',                   weight: 8 },
  { name: 'blockpi',        url: 'https://base.public.blockpi.network/v1/rpc/public',        weight: 7 },
  { name: '1rpc',           url: 'https://1rpc.io/base',                                      weight: 6 },
  { name: 'lavanet',        url: 'https://base.lava.build',                                   weight: 6 },
  { name: 'meowrpc',        url: 'https://base.meowrpc.com',                                  weight: 5 },
  { name: 'thirdweb',       url: 'https://base.rpc.thirdweb.com',                             weight: 5 },
  { name: 'tenderly',       url: 'https://base.gateway.tenderly.co',                          weight: 5 },
  { name: 'onfinality',     url: 'https://base.api.onfinality.io/public',                     weight: 6 },
  { name: 'sequence',       url: 'https://nodes.sequence.app/base',                           weight: 7 },
  { name: 'merkle',         url: 'https://base.merkle.io',                                    weight: 6 },
  { name: 'sentio',         url: 'https://rpc.sentio.xyz/base',                               weight: 5 },
  { name: 'nodies-public',  url: 'https://base-public.nodies.app',                            weight: 6 },
  { name: 'nodies-pokt',    url: 'https://base-pokt.nodies.app',                              weight: 6 },
  { name: 'bloxroute',      url: 'https://base.rpc.blxrbdn.com',                              weight: 6 },
  { name: 'publicnode-alt', url: 'https://base.publicnode.com',                               weight: 5 },
];

module.exports = { BASE_CHAIN_ID, PROVIDERS };
