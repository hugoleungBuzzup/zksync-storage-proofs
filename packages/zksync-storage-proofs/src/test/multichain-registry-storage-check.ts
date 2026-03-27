/**
 * Step-1 checklist: verify L2 `eth_getStorageAt(registry, slot)` matches
 * `getMultichainStorageKey(label, coinType, mappingSlot)` (same layout as
 * `scripts/clave-ccip-bridge.cjs`) and matches `MultichainNameRegistry.getRecord`.
 *
 * Flow (similar to buzzup-wallet-check.ts): load .env → validate CLI → RPC checks → summary → exit code.
 *
 * Usage:
 *   npm run check:multichain-storage -- <REGISTRY_ADDRESS> <LABEL> <COIN_TYPE>
 *   npx ts-node --transpile-only -P tsconfig.scripts.json test/multichain-registry-storage-check.ts <ADDR> <LABEL> <COIN>
 *
 * Env:
 *   L2_RPC_URL or ZKSYNC_SEPOLIA_RPC_URL (required)
 *   MAPPING_SLOT (optional, default 0) — outer mapping slot for MultichainNameRegistry.records
 *
 * Optional .env next to this file: packages/zksync-storage-proofs/test/.env
 */

import dotenv from 'dotenv';
import { resolve } from 'path';
import {
  AbiCoder,
  Contract,
  JsonRpcProvider,
  getAddress,
  isAddress,
  keccak256,
  toUtf8Bytes,
  zeroPadValue,
  toBeHex,
} from 'ethers';
import { type Address } from 'viem/accounts';

const MULTICHAIN_REGISTRY_ABI = [
  'function getRecord(string label, uint256 coinType) view returns (bytes32)',
  'function labelTokenId(string label) pure returns (uint256)',
] as const;

dotenv.config({ path: resolve(__dirname, '.env') });

const L2_RPC_URL =
  process.env.L2_RPC_URL || process.env.ZKSYNC_SEPOLIA_RPC_URL || '';
const MAPPING_SLOT_DEFAULT = 0n;
const mappingSlotArg = process.env.MAPPING_SLOT;
const MAPPING_SLOT = mappingSlotArg !== undefined && mappingSlotArg !== ''
  ? BigInt(mappingSlotArg)
  : MAPPING_SLOT_DEFAULT;

const REGISTRY_ARG = process.argv[2];
const LABEL_ARG = process.argv[3];
const COIN_TYPE_ARG = process.argv[4];

function labelTokenId(label: string): bigint {
  const lower = label.toLowerCase();
  return BigInt(keccak256(toUtf8Bytes(lower)));
}

/** Same as `getMultichainStorageKey` in scripts/clave-ccip-bridge.cjs */
function getMultichainStorageKey(
  label: string,
  coinType: bigint,
  mappingSlot: bigint,
): bigint {
  const coder = AbiCoder.defaultAbiCoder();
  const tid = labelTokenId(label);
  const inner = keccak256(
    coder.encode(['uint256', 'uint256'], [tid, mappingSlot]),
  );
  return BigInt(
    keccak256(
      coder.encode(['uint256', 'bytes32'], [coinType, inner]),
    ),
  );
}

function slotToStorageIndexHex(slot: bigint): `0x${string}` {
  return zeroPadValue(toBeHex(slot), 32) as `0x${string}`;
}

interface CheckResult {
  registryIsContract: boolean;
  expectedSlot: bigint;
  storageRaw: string | null;
  getRecordValue: string | null;
  labelTokenIdOnChain: bigint | null;
  storageMatchesGetRecord: boolean;
  details: { error?: string };
}

function printUsageAndExit(code: number): never {
  console.error('❌ Error: missing or invalid arguments');
  console.error(
    'Usage: npm run check:multichain-storage -- <REGISTRY_ADDRESS> <LABEL> <COIN_TYPE>',
  );
  console.error(
    'Example: npm run check:multichain-storage -- 0x802be667439aB31d9d914B76c6Ab14F6962FEbf9 hahah222 60',
  );
  console.error(
    'Env: L2_RPC_URL or ZKSYNC_SEPOLIA_RPC_URL (required); MAPPING_SLOT optional (default 0)',
  );
  process.exit(code);
}

function parseCoinType(raw: string | undefined): bigint {
  if (raw === undefined || raw.trim() === '') {
    printUsageAndExit(1);
  }
  try {
    return BigInt(raw.trim());
  } catch {
    console.error('❌ Error: COIN_TYPE must be an integer (e.g. 60 for ETH)');
    process.exit(1);
  }
}

async function runChecks(
  registry: Address,
  label: string,
  coinType: bigint,
  mappingSlot: bigint,
  rpcUrl: string,
): Promise<CheckResult> {
  const result: CheckResult = {
    registryIsContract: false,
    expectedSlot: 0n,
    storageRaw: null,
    getRecordValue: null,
    labelTokenIdOnChain: null,
    storageMatchesGetRecord: false,
    details: {},
  };

  const provider = new JsonRpcProvider(rpcUrl);
  const expectedSlot = getMultichainStorageKey(label, coinType, mappingSlot);
  result.expectedSlot = expectedSlot;

  try {
    console.log('📋 Checking registry contract code...');
    const code = await provider.getCode(registry);
    result.registryIsContract = code !== undefined && code !== '0x' && code.length > 2;
    if (!result.registryIsContract) {
      result.details.error = 'Registry address has no contract code';
      console.log('  ❌ No code at registry address\n');
      return result;
    }
    console.log(`  ✅ Contract code present (${(code.length - 2) / 2} bytes)\n`);

    const reg = new Contract(registry, MULTICHAIN_REGISTRY_ABI, provider);

    console.log('🔍 Reading labelTokenId on-chain...');
    const tid = BigInt(
      await reg.getFunction('labelTokenId').staticCall(label),
    );
    result.labelTokenIdOnChain = tid;
    const tidLocal = labelTokenId(label);
    if (tid === tidLocal) {
      console.log(`  ✅ labelTokenId matches local keccak(lower(label)): ${tid.toString()}\n`);
    } else {
      console.log(`  ❌ labelTokenId mismatch: chain=${tid.toString()} local=${tidLocal.toString()}\n`);
    }

    console.log('🔍 Reading getRecord(label, coinType)...');
    const record = (await reg
      .getFunction('getRecord')
      .staticCall(label, coinType)) as string;
    result.getRecordValue = record;
    console.log(`  📝 getRecord: ${record}\n`);

    const slotHex = slotToStorageIndexHex(expectedSlot);
    console.log('🔍 eth_getStorageAt(registry, computedSlot)...');
    console.log(`  Computed storage slot (uint256): ${expectedSlot.toString()}`);
    console.log(`  Slot index (hex): ${slotHex}`);
    const raw = await provider.getStorage(registry, slotHex);
    result.storageRaw = raw;
    console.log(`  📝 storage word: ${raw}\n`);

    const norm = (h: string) => h.toLowerCase();
    result.storageMatchesGetRecord =
      result.getRecordValue !== null &&
      result.storageRaw !== null &&
      norm(result.getRecordValue) === norm(result.storageRaw);

    if (result.labelTokenIdOnChain !== tidLocal) {
      result.storageMatchesGetRecord = false;
    }
  } catch (e: unknown) {
    const msg =
      e instanceof Error ? e.message : typeof e === 'string' ? e : String(e);
    result.details.error = msg;
    console.error(`  ❌ Error during checks: ${msg}\n`);
  }

  return result;
}

async function main(): Promise<void> {
  console.log('🔍 MultichainNameRegistry storage slot check (L2)\n');

  if (!REGISTRY_ARG || !LABEL_ARG || COIN_TYPE_ARG === undefined) {
    printUsageAndExit(1);
  }

  if (!L2_RPC_URL) {
    console.error('❌ Error: set L2_RPC_URL or ZKSYNC_SEPOLIA_RPC_URL');
    process.exit(1);
  }

  if (!isAddress(REGISTRY_ARG)) {
    console.error('❌ Error: invalid REGISTRY_ADDRESS');
    printUsageAndExit(1);
  }

  let registry: string;
  try {
    registry = getAddress(REGISTRY_ARG);
  } catch {
    console.error('❌ Error: could not checksum registry address');
    process.exit(1);
  }

  const coinType = parseCoinType(COIN_TYPE_ARG);
  const label = LABEL_ARG;

  console.log('Configuration:');
  console.log(`  Registry:     ${registry}`);
  console.log(`  Label:        ${label}`);
  console.log(`  Coin type:    ${coinType.toString()}`);
  console.log(`  Mapping slot: ${MAPPING_SLOT.toString()}`);
  console.log(`  L2 RPC:       ${L2_RPC_URL}`);
  console.log('');

  const expectedSlot = getMultichainStorageKey(label, coinType, MAPPING_SLOT);
  console.log('Expected slot (preview, matches clave-ccip-bridge.cjs):');
  console.log(`  ${expectedSlot.toString(16)} (hex)`);
  console.log('');


  const r = await runChecks(registry as `0x${string}`, label, coinType, MAPPING_SLOT, L2_RPC_URL);

  console.log('📊 Results:');
  console.log('─'.repeat(50));
  console.log(`  Registry is contract:     ${r.registryIsContract ? '✅ Yes' : '❌ No'}`);
  console.log(`  labelTokenId (local):     ${labelTokenId(label).toString()}`);
  if (r.labelTokenIdOnChain !== null) {
    console.log(`  labelTokenId (on-chain):  ${r.labelTokenIdOnChain.toString()}`);
  }
  console.log(`  Computed storage slot:    ${r.expectedSlot.toString()}`);
  console.log(`  getRecord:                ${r.getRecordValue ?? '(n/a)'}`);
  console.log(`  getStorageAt:             ${r.storageRaw ?? '(n/a)'}`);
  console.log(
    `  Storage vs getRecord:     ${r.storageMatchesGetRecord ? '✅ Match' : '❌ Mismatch or incomplete'}`,
  );
  if (r.details.error) {
    console.log(`  ⚠️  ${r.details.error}`);
  }
  console.log('─'.repeat(50));

  const tidOk =
    r.labelTokenIdOnChain !== null &&
    r.labelTokenIdOnChain === labelTokenId(label);
  const success =
    r.registryIsContract && tidOk && r.storageMatchesGetRecord;

  if (success) {
    console.log('\n🎉 Step-1 OK: slot layout matches JS helper and on-chain getRecord.');
    process.exit(0);
  }

  console.log(
    '\n⚠️  Check failed. After setRecord on L2, getRecord and getStorageAt should match.',
  );
  if (!tidOk) {
    console.log('   Hint: label must use same casing rules as the contract (ASCII lower).');
  }
  process.exit(1);
}

main().catch((e) => {
  console.error('❌ Fatal:', e);
  process.exit(1);
});
