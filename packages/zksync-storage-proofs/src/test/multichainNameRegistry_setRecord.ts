/**
 * Send MultichainNameRegistry.setRecord on Base Sepolia or Arbitrum Sepolia.
 *
 * Usage:
 *   npm run set-record:multichain -- <base-sepolia|arb-sepolia> <LABEL> <COIN_TYPE> <EVM_ADDR_OR_BYTES32>
 *
 * Aliases: base, basesep → Base Sepolia; arb-sepolia, arb1, arb → Arbitrum Sepolia
 *
 * Examples:
 *   npm run set-record:multichain -- base-sepolia mylabel 60 0x1234...7890
 *   npm run set-record:multichain -- arb-sepolia mylabel 60 0xabcd...0000
 *
 * Env (test/.env or cwd):
 *   PRIVATE_KEY — hex key, with or without 0x (required)
 *   MULTICHAIN_REGISTRY_BASE_SEPOLIA — registry on Base Sepolia (84532)
 *   MULTICHAIN_REGISTRY_ARBITRUM_SEPOLIA — registry on Arbitrum Sepolia (421614)
 *   Fallback if chain-specific unset: MULTICHAIN_REGISTRY
 *   BASE_SEPOLIA_RPC_URL — optional; default https://sepolia.base.org
 *   ARBITRUM_SEPOLIA_RPC_URL — optional; default https://sepolia-rollup.arbitrum.io/rpc
 *
 * Value arg: 20-byte EVM address (padded to bytes32 per contract) or full 32-byte hex.
 */

import dotenv from 'dotenv';
import { resolve } from 'path';
import {
  Contract,
  JsonRpcProvider,
  Wallet,
  getAddress,
  isAddress,
  isHexString,
  zeroPadValue,
} from 'ethers';

dotenv.config({ path: resolve(__dirname, '.env') });

const ABI = [
  'function setRecord(string label, uint256 coinType, bytes32 value) external',
] as const;

type ChainKey = 'baseSepolia' | 'arbSepolia';

const CHAINS: Record<
  ChainKey,
  { chainId: number; name: string; defaultRpc: string; registryEnv: string }
> = {
  baseSepolia: {
    chainId: 84532,
    name: 'Base Sepolia',
    defaultRpc: 'https://sepolia.base.org',
    registryEnv: 'MULTICHAIN_REGISTRY_BASE_SEPOLIA',
  },
  arbSepolia: {
    chainId: 421614,
    name: 'Arbitrum Sepolia',
    defaultRpc: 'https://sepolia-rollup.arbitrum.io/rpc',
    registryEnv: 'MULTICHAIN_REGISTRY_ARBITRUM_SEPOLIA',
  },
};

function printUsageAndExit(code: number): never {
  console.error(
    'Usage: npm run set-record:multichain -- <base-sepolia|arb-sepolia> <LABEL> <COIN_TYPE> <ADDR_OR_BYTES32>',
  );
  console.error(
    'Env: PRIVATE_KEY; MULTICHAIN_REGISTRY_BASE_SEPOLIA / MULTICHAIN_REGISTRY_ARBITRUM_SEPOLIA (or MULTICHAIN_REGISTRY)',
  );
  process.exit(code);
}

function parseChainKey(raw: string | undefined): ChainKey {
  if (!raw) printUsageAndExit(1);
  const k = raw.trim().toLowerCase().replace(/_/g, '-');
  if (
    k === 'base-sepolia' ||
    k === 'basesep' ||
    k === 'base' ||
    k === 'base-sep'
  ) {
    return 'baseSepolia';
  }
  if (
    k === 'arb-sepolia' ||
    k === 'arbitrum-sepolia' ||
    k === 'arbsep' ||
    k === 'arb1' ||
    k === 'arb' ||
    k === 'arbitrum' ||
    k === 'arbitrum-one-sepolia'
  ) {
    return 'arbSepolia';
  }
  console.error(
    `❌ Unknown chain "${raw}". Use base-sepolia (or base) / arb-sepolia (or arb1).`,
  );
  process.exit(1);
}

function parseCoinType(raw: string | undefined): bigint {
  if (raw === undefined || raw.trim() === '') printUsageAndExit(1);
  try {
    return BigInt(raw.trim());
  } catch {
    console.error('❌ COIN_TYPE must be an integer (e.g. 60 for ETH).');
    process.exit(1);
  }
}

/** ERC-2304-style: address zero-padded to 32 bytes, or raw 32-byte hex. */
function parseValueArg(raw: string | undefined): `0x${string}` {
  if (!raw || !raw.startsWith('0x')) {
    console.error('❌ Value must be 0x-prefixed address (42 chars) or bytes32 (66 chars).');
    process.exit(1);
  }
  const s = raw.trim() as `0x${string}`;
  if (!isHexString(s, true)) {
    console.error('❌ Value is not valid hex.');
    process.exit(1);
  }
  const len = (s.length - 2) / 2;
  if (len === 20) {
    try {
      return zeroPadValue(getAddress(s), 32) as `0x${string}`;
    } catch {
      console.error('❌ Invalid EVM address.');
      process.exit(1);
    }
  }
  if (len === 32) return s;
  console.error('❌ Value must be 20-byte address or 32-byte word.');
  process.exit(1);
}

function registryForChain(key: ChainKey): string {
  const cfg = CHAINS[key];
  const specific = process.env[cfg.registryEnv];
  const fallback = process.env.MULTICHAIN_REGISTRY;
  const addr = (specific || fallback || '').trim();
  if (!addr) {
    console.error(
      `❌ Set ${cfg.registryEnv} or MULTICHAIN_REGISTRY in .env for ${cfg.name}.`,
    );
    process.exit(1);
  }
  if (!isAddress(addr)) {
    console.error('❌ Registry address is invalid.');
    process.exit(1);
  }
  return getAddress(addr);
}

function rpcForChain(key: ChainKey): string {
  const cfg = CHAINS[key];
  if (key === 'baseSepolia') {
    return (
      process.env.BASE_SEPOLIA_RPC_URL?.trim() ||
      process.env.BASE_RPC_URL?.trim() ||
      cfg.defaultRpc
    );
  }
  return (
    process.env.ARBITRUM_SEPOLIA_RPC_URL?.trim() ||
    process.env.ARB_SEPOLIA_RPC_URL?.trim() ||
    process.env.ARB_RPC_URL?.trim() ||
    cfg.defaultRpc
  );
}

async function main(): Promise<void> {
  const chainArg = process.argv[2];
  const label = process.argv[3];
  const coinRaw = process.argv[4];
  const valueRaw = process.argv[5];

  if (!chainArg || !label || coinRaw === undefined || valueRaw === undefined) {
    printUsageAndExit(1);
  }

  const chainKey = parseChainKey(chainArg);
  const coinType = parseCoinType(coinRaw);
  const valueHex = parseValueArg(valueRaw);
  const cfg = CHAINS[chainKey];
  const pk = process.env.PRIVATE_KEY?.trim();
  if (!pk) {
    console.error('❌ PRIVATE_KEY is required in .env');
    process.exit(1);
  }
  const normalizedPk = pk.startsWith('0x') ? pk : `0x${pk}`;

  const registry = registryForChain(chainKey);
  const rpcUrl = rpcForChain(chainKey);

  console.log(`${cfg.name} (chainId ${cfg.chainId})`);
  console.log(`  RPC:      ${rpcUrl}`);
  console.log(`  Registry: ${registry}`);
  console.log(`  Label:    ${label}`);
  console.log(`  Coin:     ${coinType.toString()}`);
  console.log(`  Value:    ${valueHex}\n`);

  const provider = new JsonRpcProvider(rpcUrl, cfg.chainId);
  const wallet = new Wallet(normalizedPk, provider);
  const reg = new Contract(registry, ABI, wallet);

  const tx = await reg.getFunction('setRecord')(label, coinType, valueHex);
  console.log(`  Tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  Mined in block ${receipt?.blockNumber ?? '(unknown)'}`);
  console.log('✅ setRecord done.');
}

main().catch((e) => {
  console.error('❌', e instanceof Error ? e.message : e);
  process.exit(1);
});
