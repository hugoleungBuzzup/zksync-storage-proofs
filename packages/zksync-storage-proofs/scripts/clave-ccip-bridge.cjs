/**
 * Phase 3 — ClaveResolver / CCIP-Read bridge (reference only)
 *
 * ClaveResolver.resolve() reverts with EIP-3668 OffchainLookup; the gateway must return
 * bytes that resolveWithProof decodes as:
 *   (StorageProof proof, bytes32 fallbackValue)
 *
 * OffchainLookup `extraData` (encoded by the resolver, echoed by the client) is:
 *   abi.encode(l2RegistryAddress, storageKeyUint256, queryCoinTypeUint256)
 * queryCoinType: SLIP-44 / ENSIP-11 (e.g. 60 ETH, 714 BNB, 501 SOL, Base 2147492101, zkSync 2147483972).
 *
 * On-chain, proof.account and proof.key are overwritten from extraData before verify().
 *
 * ---------------------------------------------------------------------------
 * Deployment / integration checklist (Sepolia 演練)
 * ---------------------------------------------------------------------------
 * 步 | 在哪做 | 做什麼 | 點為之完成（成功標準）
 * --|--------|--------|------------------
 * 1 | L1 Sepolia：`packages/zksync-storage-contracts` | `forge build` 後部署 `SparseMerkleTree`、`StorageProofVerifier`（constructor 帶該 L1 的 zkSync Diamond） | `cast call` 或腳本能對 Verifier 做 `verify`（或至少合約已驗證部署、地址已記低）
 * 2 | L2 zkSync Sepolia | 部署 `MultichainNameRegistry`（或 demo `Registry.sol` 若走 legacy）| L2 上 `setRecord` / `register` 後，`eth_getStorageAt(registry, slot)` 與 `getMultichainStorageKey(label,coinType,0)`（本檔）算出的 key 一致
 * 3 | L1 Sepolia：同上 forge 專案 | 部署 `ClaveResolver(url, domainOwner, l2Registry, verifier, multichainLayout)`；`setRegistry` / `setUrl` 校好；multichain 時 `mappingSlot=0` + `multichainLayout=true` | `cast call` `url()`、`registry()`、`multichainLayout()` 與預期一致
 * 4 | 你自己部署的 HTTP Gateway（任何 host） | 實作 EIP-3668 gateway：收 OffchainLookup 所指的 request，用 `@getclave/zksync-storage-proofs` 取 `StorageProof`，用 `encodeClaveGatewayResponse` 回傳 body（hex 或 raw bytes） | 用本檔 `demo` 或單元測試驗證 encode；再用 curl/Postman 打 gateway 得到合法 ABI 編碼
 * 5 | ENS on L1（Sepolia 測試網 ENS） | `abc123.eth` 設 resolver = ClaveResolver；開 wildcard / ENSIP-10，名要三標籤 DNS 編碼 | 支援 CCIP 嘅 client 解析 `sub.abc123.eth` 時會打你 gateway，最終得到 addr 與 L2 `setRecord` 一致
 * 6 | （選修）`offchain-resolver` repo | 跑簽名版 CCIP 學流程，對照 Clave 是「驗 storage proof」不是「驗 signer」 | 本地 `yarn start:node` + client 能走完 OffchainLookup
 * 
 * Test cases（建議順序）：
 * - `cd packages/zksync-storage-contracts && forge test`
 *   → `MultichainNameRegistry.t.sol`（slot 與 `vm.load`）、`SparseMerkleTree.t.sol`
 * - `cd packages/zksync-storage-proofs && npm run build && npm run proof:clave-encode`
 *   → 驗證 `encodeClaveGatewayResponse` 同 `SepoliaStorageProofProvider.getProof` 可串
 * - `node -e "const m=require('./scripts/clave-ccip-bridge.cjs'); console.log(m.getMultichainStorageKey('hugol',8453,0).toString())"`
 *   → 與鏈上 `MultichainNameRegistry` / `ClaveResolver.getMultichainDomainSlot` 比對（同一 label+coinType+slot）
 * - `node scripts/clave-ccip-bridge.cjs encode path/to/proof.json [fallbackBytes32]`（或 `encode -` 由 stdin 讀 JSON）
 *   → 輸出完整 hex，等同 gateway 回傳俾 `resolveWithProof` 嘅 `(StorageProof,bytes32)` ABI 編碼
 * - `node scripts/clave-ccip-bridge.cjs decode - < gw-response.hex` 或 `decode path/to/hexfile` 或 `decode 0x...`
 *   → 用同 `resolveWithProof` 一致嘅 ABI **解碼**；成功即係合法 `(StorageProof,bytes32)`；stdout 印 JSON（檢查 `proof.account` / `proof.key` 等）
 * - `node scripts/clave-ccip-bridge.cjs storage-key hugol 8453 0` → 同上 `getMultichainStorageKey` 十進位 key
 * - （可選）`VERIFY=1` + 可承受 ~60M gas 嘅 Sepolia RPC：`readme-proof-sepolia.cjs` / `balance-proof-sepolia.cjs` 內 `verifyOnChain`
 * - （整合）viem/ethers `eth_call`：模擬 `resolve` → 餵 gateway 回傳 bytes → `resolveWithProof`；成功則返回 20-byte（EVM）或 32-byte（SOL）addr bytes
 *
 * Standard CCIP-Read flow (offchain-resolver monorepo):
 *   yarn && yarn build && yarn start:node  (local Hardhat + resolver)
 *   yarn start:client --registry <addr> test.eth
 */

const { AbiCoder, ZeroHash, keccak256, toUtf8Bytes } = require('ethers');

const STORAGE_PROOF_ABI =
    'tuple(tuple(uint64 batchNumber,uint64 indexRepeatedStorageChanges,uint256 numberOfLayer1Txs,bytes32 priorityOperationsHash,bytes32 l2LogsTreeRoot,uint256 timestamp,bytes32 commitment) metadata,address account,uint256 key,bytes32 value,bytes32[] path,uint64 index)';

/**
 * @param {object} proof - Same shape as {@link SepoliaStorageProofProvider.getProof} JSON (bigint fields as string or number)
 * @param {string} [fallback] - bytes32 hex, default 0
 * @example CLI: node scripts/clave-ccip-bridge.cjs encode proof.json
 * @example One-liner: node -e "const fs=require('fs');const m=require('./scripts/clave-ccip-bridge.cjs');console.log(m.encodeClaveGatewayResponse(JSON.parse(fs.readFileSync('proof.json','utf8'))))"
 */
function encodeClaveGatewayResponse(proof, fallback = ZeroHash) {
    const md = proof.metadata;
    const metadataTuple = [
        BigInt(md.batchNumber),
        BigInt(md.indexRepeatedStorageChanges),
        BigInt(md.numberOfLayer1Txs),
        md.priorityOperationsHash,
        md.l2LogsTreeRoot,
        BigInt(md.timestamp),
        md.commitment,
    ];
    const tuple = [
        metadataTuple,
        proof.account,
        BigInt(proof.key),
        proof.value,
        proof.path,
        BigInt(proof.index),
    ];
    return AbiCoder.defaultAbiCoder().encode(
        [`${STORAGE_PROOF_ABI}`, 'bytes32'],
        [tuple, fallback],
    );
}

/**
 * Decode gateway / `resolveWithProof` response bytes (same types as {@link encodeClaveGatewayResponse}).
 * @param {string} hex - 0x-prefixed ABI blob
 * @returns {{ proof: object, fallback: string }}
 */
function decodeClaveGatewayResponse(hex) {
    const raw = String(hex).trim().replace(/^["']|["']$/g, '');
    const h = raw.startsWith('0x') ? raw : `0x${raw}`;
    const decoded = AbiCoder.defaultAbiCoder().decode(
        [STORAGE_PROOF_ABI, 'bytes32'],
        h,
    );
    return { proof: decoded[0], fallback: decoded[1] };
}

/** @param {object} proof decoded StorageProof tuple @param {string} fallback */
function formatDecodedForJson(proof, fallback) {
    const md = proof.metadata;
    return {
        proof: {
            metadata: {
                batchNumber: md.batchNumber.toString(),
                indexRepeatedStorageChanges:
                    md.indexRepeatedStorageChanges.toString(),
                numberOfLayer1Txs: md.numberOfLayer1Txs.toString(),
                priorityOperationsHash: md.priorityOperationsHash,
                l2LogsTreeRoot: md.l2LogsTreeRoot,
                timestamp: md.timestamp.toString(),
                commitment: md.commitment,
            },
            account: proof.account,
            key: proof.key.toString(),
            value: proof.value,
            path: [...proof.path],
            index: proof.index.toString(),
        },
        fallback,
    };
}

async function demo() {
    const { SepoliaStorageProofProvider } = require('../build/cjs/index.js');
    const proof = await SepoliaStorageProofProvider.getProof(
        '0x0000000000000000000000000000000000008003',
        '0x8b65c0cf1012ea9f393197eb24619fd814379b298b238285649e14f936a5eb12',
        1000,
    );
    const hex = encodeClaveGatewayResponse(proof);
    console.log('Sample CCIP response payload (hex, first 200 chars):');
    console.log(hex.slice(0, 200) + '...');
}

function readProofJsonFromPathOrStdin(jsonPath) {
    const fs = require('fs');
    const path = require('path');
    if (jsonPath === '-') {
        return fs.readFileSync(0, 'utf8');
    }
    const abs = path.isAbsolute(jsonPath)
        ? jsonPath
        : path.join(process.cwd(), jsonPath);
    return fs.readFileSync(abs, 'utf8');
}

function cmdEncode(argv) {
    const jsonPath = argv[0];
    const fallbackArg = argv[1];
    if (!jsonPath) {
        console.error(
            'Usage: node scripts/clave-ccip-bridge.cjs encode <proof.json|-> [fallbackBytes32]',
        );
        process.exit(1);
    }
    const raw = readProofJsonFromPathOrStdin(jsonPath);
    const proof = JSON.parse(raw);
    const fallback =
        fallbackArg === undefined || fallbackArg === ''
            ? ZeroHash
            : fallbackArg.startsWith('0x')
              ? fallbackArg
              : `0x${fallbackArg}`;
    const hex = encodeClaveGatewayResponse(proof, fallback);
    console.log(hex);
}

function cmdStorageKey(argv) {
    const [label, coinType, mappingSlot = '0'] = argv;
    if (label === undefined || coinType === undefined) {
        console.error(
            'Usage: node scripts/clave-ccip-bridge.cjs storage-key <label> <coinType> [mappingSlot]',
        );
        process.exit(1);
    }
    const key = getMultichainStorageKey(
        label,
        BigInt(coinType),
        BigInt(mappingSlot),
    );
    console.log(key.toString());
}

function readHexPayload(arg) {
    const fs = require('fs');
    const path = require('path');
    if (arg === undefined || arg === '') {
        return null;
    }
    if (arg === '-') {
        return fs
            .readFileSync(0, 'utf8')
            .trim()
            .replace(/^["']|["']$/g, '');
    }
    const maybePath = path.isAbsolute(arg) ? arg : path.join(process.cwd(), arg);
    if (fs.existsSync(maybePath)) {
        return fs
            .readFileSync(maybePath, 'utf8')
            .trim()
            .replace(/^["']|["']$/g, '');
    }
    return String(arg).trim().replace(/^["']|["']$/g, '');
}

function cmdDecode(argv) {
    const payload = readHexPayload(argv[0]);
    if (!payload) {
        console.error(
            'Usage: node scripts/clave-ccip-bridge.cjs decode <0x...|path/to.hex|->',
        );
        console.error(
            '  (長 hex 建議放檔案或用 stdin: decode - < response.hex)',
        );
        process.exit(1);
    }
    try {
        const { proof, fallback } = decodeClaveGatewayResponse(payload);
        console.log(
            JSON.stringify(formatDecodedForJson(proof, fallback), null, 2),
        );
        console.error('OK: valid ABI (StorageProof, bytes32) for resolveWithProof');
    } catch (e) {
        console.error('Decode failed — not this ABI shape or truncated data:');
        console.error(e.message || e);
        process.exit(1);
    }
}

async function main() {
    const [, , cmd, ...rest] = process.argv;
    if (!cmd || cmd === 'demo') {
        await demo();
        return;
    }
    if (cmd === 'encode') {
        cmdEncode(rest);
        return;
    }
    if (cmd === 'storage-key') {
        cmdStorageKey(rest);
        return;
    }
    if (cmd === 'decode') {
        cmdDecode(rest);
        return;
    }
    if (cmd === '-h' || cmd === '--help') {
        console.log(`Usage:
  node scripts/clave-ccip-bridge.cjs [demo]     SepoliaStorageProofProvider sample → encode preview
  node scripts/clave-ccip-bridge.cjs encode <proof.json|-> [fallbackBytes32]
  node scripts/clave-ccip-bridge.cjs decode <0x...|file.hex|->   verify gateway payload ABI
  node scripts/clave-ccip-bridge.cjs storage-key <label> <coinType> [mappingSlot]`);
        return;
    }
    console.error('Unknown command:', cmd, '(try --help)');
    process.exit(1);
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}

/**
 * Matches MultichainNameRegistry.labelTokenId / ClaveResolver toLower(sub) + keccak256(abi.encodePacked).
 * @param {string} label first DNS label, e.g. "hahah222"
 */
function labelTokenId(label) {
  const lower = label.toLowerCase();
  return BigInt(keccak256(toUtf8Bytes(lower)));
}

/**
 * Storage key for MultichainNameRegistry (outer mapping at `mappingSlot`, usually 0).
 * @param {string} label
 * @param {bigint|number} coinType
 * @param {bigint|number} [mappingSlot=0]
 */
function getMultichainStorageKey(label, coinType, mappingSlot = 0n) {
  const coder = AbiCoder.defaultAbiCoder();
  const tid = labelTokenId(label);
  const inner = keccak256(
    coder.encode(['uint256', 'uint256'], [tid, BigInt(mappingSlot)]),
  );
  return BigInt(
    keccak256(
      coder.encode(['uint256', 'bytes32'], [BigInt(coinType), inner]),
    ),
  );
}

module.exports = {
  encodeClaveGatewayResponse,
  decodeClaveGatewayResponse,
  STORAGE_PROOF_ABI,
  labelTokenId,
  getMultichainStorageKey,
};
