// Browser-safe Base RPC list. Filtered to providers that serve permissive CORS
// from arbitrary public origins (verified empirically — see the test loop in app.js).
// If one starts blocking CORS, drop it from this list.

export const BASE_CHAIN_ID = 8453;

export const PROVIDERS = [
  { name: 'base-official',  url: 'https://mainnet.base.org',                    weight: 10 },
  { name: 'llamanodes',     url: 'https://base.llamarpc.com',                    weight: 8 },
  { name: 'publicnode',     url: 'https://base-rpc.publicnode.com',              weight: 8 },
  { name: 'base-dev',       url: 'https://developer-access-mainnet.base.org',    weight: 8 },
  { name: 'tenderly-pub',   url: 'https://gateway.tenderly.co/public/base',     weight: 7 },
  { name: '1rpc',           url: 'https://1rpc.io/base',                         weight: 6 },
  { name: 'meowrpc',        url: 'https://base.meowrpc.com',                     weight: 5 },
  { name: 'drpc',           url: 'https://base.drpc.org',                        weight: 6 },
];
