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
 * - `fullEnsResolveOffchainLookupEthCall` / `all(resolver, fullName, rpc)`：DNS wire + namehash + `addr(bytes32)` data + `resolve(bytes,bytes)` calldata + `eth_call`（預期 OffchainLookup）；CLI：`resolve-probe <resolver> <full.name.eth> <rpcUrl>`
 * - （可選）`VERIFY=1` + 可承受 ~60M gas 嘅 Sepolia RPC：`readme-proof-sepolia.cjs` / `balance-proof-sepolia.cjs` 內 `verifyOnChain`
 * - （整合）viem/ethers `eth_call`：模擬 `resolve` → 餵 gateway 回傳 bytes → `resolveWithProof`；成功則返回 20-byte（EVM）或 32-byte（SOL）addr bytes
 * - `resolve-diagnose <response> <extraData> [l2Rpc] [l1Verifier] [l1Rpc]` → 步驟 4：解 proof/fallback/extraData，可選 L2 `getStorageAt` 與 L1 `StorageProofVerifier.verify`
 *
 * Standard CCIP-Read flow (offchain-resolver monorepo):
 *   yarn && yarn build && yarn start:node  (local Hardhat + resolver)
 *   yarn start:client --registry <addr> test.eth
 */

const {
    AbiCoder,
    Contract,
    ZeroHash,
    keccak256,
    toUtf8Bytes,
    concat,
    dnsEncode,
    id,
    Interface,
    JsonRpcProvider,
    isError,
    namehash,
    toBeHex,
} = require('ethers');

/** ENS `addr(bytes32)` — 4-byte selector（同 `cast sig "addr(bytes32)"`） */
const ADDR_BYTES32_SELECTOR = id('addr(bytes32)').slice(0, 10);
/** ENS `addr(bytes32,uint256)` — 同 `ClaveResolver.ADDR_MULTICHAIN_SELECTOR` `0xf1cb7e06` */
const ADDR_MULTICHAIN_SELECTOR = id('addr(bytes32,uint256)').slice(0, 10);

const ADDR_MULTICHAIN_IFACE = new Interface([
    'function addr(bytes32 node, uint256 coinType) view returns (bytes)',
]);

/** `resolve(bytes,bytes)` — ENSIP-10；selector `0x9061b923` */
const RESOLVE_BYTES_BYTES_IFACE = new Interface([
    'function resolve(bytes name, bytes data) view returns (bytes)',
]);

/** L1 callback：gateway 回傳 bytes 餵入 */
const RESOLVE_WITH_PROOF_IFACE = new Interface([
    'function resolveWithProof(bytes memory _response, bytes memory _extraData) view returns (bytes memory)',
]);

const OFFCHAIN_LOOKUP_IFACE = new Interface([
    'error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)',
]);

const STORAGE_PROOF_ABI =
    'tuple(tuple(uint64 batchNumber,uint64 indexRepeatedStorageChanges,uint256 numberOfLayer1Txs,bytes32 priorityOperationsHash,bytes32 dependencyRootsRollingHash,bytes32 l2LogsTreeRoot,uint256 timestamp,bytes32 commitment) metadata,address account,uint256 key,bytes32 value,bytes32[] path,uint64 index)';

/** 同 `StorageProofVerifier.verify(StorageProof)` */
const STORAGE_PROOF_VERIFIER_IFACE = new Interface([
    `function verify(${STORAGE_PROOF_ABI} _proof) external view returns (bool valid)`,
]);

const STORAGE_VERIFIER_VIEW_ABI = [
    'function zksyncDiamondAddress() view returns (address)',
    'function smt() view returns (address)',
];

const ZKSYNC_DIAMOND_STORED_BATCH_ABI = [
    'function storedBatchHash(uint256 batchNumber) view returns (bytes32)',
];

/** 同鏈上 `LegacyStoredBatchInfo` */
const LEGACY_STORED_BATCH_INFO_TUPLE_ABI =
    'tuple(uint64 batchNumber, bytes32 batchHash, uint64 indexRepeatedStorageChanges, uint256 numberOfLayer1Txs, bytes32 priorityOperationsHash, bytes32 l2LogsTreeRoot, uint256 timestamp, bytes32 commitment)';

/** 同 matter-labs `IExecutor.StoredBatchInfo`（v1，有 dependencyRootsRollingHash） */
const V1_STORED_BATCH_INFO_TUPLE_ABI =
    'tuple(uint64 batchNumber, bytes32 batchHash, uint64 indexRepeatedStorageChanges, uint256 numberOfLayer1Txs, bytes32 priorityOperationsHash, bytes32 dependencyRootsRollingHash, bytes32 l2LogsTreeRoot, uint256 timestamp, bytes32 commitment)';

const SMT_GET_ROOT_IFACE = new Interface([
    'function getRootHash(bytes32[] proof, tuple(uint256 key, bytes32 value, uint64 leafIndex) entry, address account) view returns (bytes32)',
]);

/**
 * 讀 L1 StorageProofVerifier 綁定嘅 Diamond / SMT（方便對照 gateway .env）。
 * @param {string|import('ethers').Provider} providerOrRpcUrl
 * @param {string} verifierAddress
 */
async function fetchStorageVerifierLinkage(providerOrRpcUrl, verifierAddress) {
    const provider =
        typeof providerOrRpcUrl === 'string'
            ? new JsonRpcProvider(providerOrRpcUrl)
            : providerOrRpcUrl;
    const c = new Contract(verifierAddress, STORAGE_VERIFIER_VIEW_ABI, provider);
    const [zksyncDiamondAddress, smtAddress] = await Promise.all([
        c.zksyncDiamondAddress(),
        c.smt(),
    ]);
    return {
        zksyncDiamondAddress: String(zksyncDiamondAddress),
        smtAddress: String(smtAddress),
    };
}

/**
 * L1 zkSync Diamond `storedBatchHash(batchNumber)`（同 Verifier 內部比較用）。
 */
async function fetchDiamondStoredBatchHash(
    providerOrRpcUrl,
    diamondAddress,
    batchNumber,
) {
    const provider =
        typeof providerOrRpcUrl === 'string'
            ? new JsonRpcProvider(providerOrRpcUrl)
            : providerOrRpcUrl;
    const c = new Contract(diamondAddress, ZKSYNC_DIAMOND_STORED_BATCH_ABI, provider);
    const h = await c.storedBatchHash(BigInt(batchNumber));
    return String(h);
}

/**
 * 與鏈上 `StorageProofVerifier` 一致：`keccak256(abi.encode(legacy StoredBatchInfo))`，其中 `batchHash` = SMT root。
 * @param {string} smtRootHex - `SparseMerkleTree.getRootHash` 回傳嘅 bytes32
 * @param {object} metadata - `proof.metadata`（ethers decode 後，欄位為 bigint / bytes32）
 */
function hashStoredBatchInfoLegacy(smtRootHex, metadata) {
    const md = metadata;
    const tuple = [
        md.batchNumber,
        smtRootHex,
        md.indexRepeatedStorageChanges,
        md.numberOfLayer1Txs,
        md.priorityOperationsHash,
        md.l2LogsTreeRoot,
        md.timestamp,
        md.commitment,
    ];
    const encoded = AbiCoder.defaultAbiCoder().encode(
        [LEGACY_STORED_BATCH_INFO_TUPLE_ABI],
        [tuple],
    );
    return keccak256(encoded);
}

/**
 * 同鏈上 `StoredBatchInfo`（v1）`keccak256(abi.encode(...))`。
 * @param {string} smtRootHex
 * @param {object} metadata - 須有 `dependencyRootsRollingHash`（可為 ZeroHash）
 */
function hashStoredBatchInfoV1(smtRootHex, metadata) {
    const md = metadata;
    const dep =
        md.dependencyRootsRollingHash !== undefined &&
        md.dependencyRootsRollingHash !== null &&
        md.dependencyRootsRollingHash !== ''
            ? md.dependencyRootsRollingHash
            : ZeroHash;
    const tuple = [
        md.batchNumber,
        smtRootHex,
        md.indexRepeatedStorageChanges,
        md.numberOfLayer1Txs,
        md.priorityOperationsHash,
        dep,
        md.l2LogsTreeRoot,
        md.timestamp,
        md.commitment,
    ];
    const encoded = AbiCoder.defaultAbiCoder().encode(
        [V1_STORED_BATCH_INFO_TUPLE_ABI],
        [tuple],
    );
    return keccak256(encoded);
}

function metadataDependencyRootsOrZero(md) {
    if (
        md.dependencyRootsRollingHash === undefined ||
        md.dependencyRootsRollingHash === null ||
        md.dependencyRootsRollingHash === ''
    ) {
        return ZeroHash;
    }
    return md.dependencyRootsRollingHash;
}

/**
 * L1 `eth_call` `SparseMerkleTree.getRootHash`（account 必須同 `verify` 一樣用 extra 覆寫後嘅 registry）。
 */
async function ethCallSmtGetRootHash(
    provider,
    smtAddress,
    proofDecoded,
    account,
) {
    const entry = [proofDecoded.key, proofDecoded.value, proofDecoded.index];
    const data = SMT_GET_ROOT_IFACE.encodeFunctionData('getRootHash', [
        [...proofDecoded.path],
        entry,
        account,
    ]);
    const raw = await provider.call({
        to: smtAddress,
        data,
        enableCcipRead: false,
    });
    const out = AbiCoder.defaultAbiCoder().decode(['bytes32'], raw);
    return String(out[0]);
}

/**
 * zkSync L2 JSON-RPC `zks_getL1BatchDetails`（用嚟拎官方 `rootHash` 同 SMT root 比對）。
 */
async function zksGetL1BatchDetails(l2RpcUrl, batchNumber) {
    const res = await fetch(l2RpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'zks_getL1BatchDetails',
            params: [Number(batchNumber)],
        }),
    });
    const j = await res.json();
    if (j.error) {
        throw new Error(
            typeof j.error.message === 'string'
                ? j.error.message
                : JSON.stringify(j.error),
        );
    }
    return j.result;
}

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
        metadataDependencyRootsOrZero(md),
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
                dependencyRootsRollingHash: metadataDependencyRootsOrZero(md),
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

/**
 * 解 `ClaveResolver` OffchainLookup `extraData`：`abi.encode(registry, storageKey, coinType)`。
 * @param {string} extraDataHex
 * @returns {{ registry: string, storageKey: string, storageKeyHex: string, coinType: string }}
 */
function decodeClaveExtraData(extraDataHex) {
    const s = String(extraDataHex).trim().replace(/^["']|["']$/g, '');
    const h = s.startsWith('0x') ? s : `0x${s}`;
    const decoded = AbiCoder.defaultAbiCoder().decode(
        ['address', 'uint256', 'uint256'],
        h,
    );
    const storageKey = decoded[1];
    return {
        registry: decoded[0],
        storageKey: storageKey.toString(),
        storageKeyHex: toBeHex(storageKey, 32),
        coinType: decoded[2].toString(),
    };
}

function isZeroBytes32(hex) {
    try {
        return BigInt(hex) === 0n;
    } catch {
        return false;
    }
}

/**
 * 組 `StorageProofVerifier.verify` 用嘅 tuple（同 on-chain 一樣可覆寫 account / key）。
 * @param {object} proof - {@link decodeClaveGatewayResponse} 嘅 proof
 * @param {string} accountOverride
 * @param {bigint} keyOverride
 */
function proofTupleForVerifier(proof, accountOverride, keyOverride) {
    const md = proof.metadata;
    return [
        [
            md.batchNumber,
            md.indexRepeatedStorageChanges,
            md.numberOfLayer1Txs,
            md.priorityOperationsHash,
            metadataDependencyRootsOrZero(md),
            md.l2LogsTreeRoot,
            md.timestamp,
            md.commitment,
        ],
        accountOverride,
        keyOverride,
        proof.value,
        [...proof.path],
        proof.index,
    ];
}

/**
 * L1 `eth_call` StorageProofVerifier.verify（與 Resolver 一樣先用 extraData 覆寫 account、key）。
 * @param {string|import('ethers').Provider} providerOrRpcUrl
 * @param {string} verifierAddress
 * @param {object} proofDecoded
 * @param {string} registryFromExtra
 * @param {bigint|string} storageKeyFromExtra
 */
async function ethCallStorageProofVerifierVerify(
    providerOrRpcUrl,
    verifierAddress,
    proofDecoded,
    registryFromExtra,
    storageKeyFromExtra,
) {
    const provider =
        typeof providerOrRpcUrl === 'string'
            ? new JsonRpcProvider(providerOrRpcUrl)
            : providerOrRpcUrl;
    const keyBi = BigInt(storageKeyFromExtra);
    const tuple = proofTupleForVerifier(
        proofDecoded,
        registryFromExtra,
        keyBi,
    );
    const data = STORAGE_PROOF_VERIFIER_IFACE.encodeFunctionData('verify', [
        tuple,
    ]);
    const raw = await provider.call({
        to: verifierAddress,
        data,
        enableCcipRead: false,
    });
    const out = AbiCoder.defaultAbiCoder().decode(['bool'], raw);
    return Boolean(out[0]);
}

/**
 * 步驟 4：解 response + extraData、比對欄位、可選 L2 getStorageAt 與 L1 verify。
 * @param {string} responseHex
 * @param {string} extraDataHex
 * @param {{ l2RpcUrl?: string, l1VerifierAddress?: string, l1RpcUrl?: string }} [options]
 */
async function runResolveDiagnose(responseHex, extraDataHex, options = {}) {
    const { l2RpcUrl, l1VerifierAddress, l1RpcUrl } = options;
    const { proof, fallback } = decodeClaveGatewayResponse(responseHex);
    const extra = decodeClaveExtraData(extraDataHex);
    const keyStr = proof.key.toString();
    const flags = {
        proofKeyMatchesExtraData: keyStr === extra.storageKey,
        proofAccountMatchesExtraRegistry:
            proof.account.toLowerCase() === extra.registry.toLowerCase(),
        proofValueIsZero: isZeroBytes32(proof.value),
        fallbackIsZero: isZeroBytes32(fallback),
    };
    const suggestedCastCommands = [
        `cast storage ${extra.registry} ${extra.storageKeyHex} --rpc-url "<L2_ZKSYNC_SEPOLIA_RPC>"`,
    ];
    const report = {
        extraData: extra,
        proof: formatDecodedForJson(proof, fallback).proof,
        fallback,
        flags,
        suggestedCastCommands,
        hints: {
            zeroAddressResolve:
                '若步驟 3 returnData 解出 20-byte 全零：多數係 proof.value 與 fallback 皆 0，或 verify 回 false 仍走 fallback。',
            keyMismatch:
                '若 proofKeyMatchesExtraData 為 false：gateway proof 嘅 key 與 extraData 唔一致，resolveWithProof 鏈上會用 extraData 覆寫 key。',
            l2Compare:
                'l2.getStorageAt 應與 proof.value 一致（同一 batch / 狀態下）；唔一致即 proof 過期或 slot 錯。',
        },
        l2: null,
        l1Verifier: null,
        l1Verify: null,
        l1VerifyDebug: null,
    };

    if (l2RpcUrl) {
        try {
            const l2p = new JsonRpcProvider(l2RpcUrl);
            const word = await l2p.getStorage(
                extra.registry,
                extra.storageKeyHex,
            );
            const match =
                word.toLowerCase() === String(proof.value).toLowerCase();
            report.l2 = {
                getStorageAt: word,
                matchesProofValue: match,
            };
        } catch (e) {
            report.l2 = { error: e?.message ?? String(e) };
        }
    }

    if (l1VerifierAddress && l1RpcUrl) {
        const provider = new JsonRpcProvider(l1RpcUrl);
        try {
            const linkage = await fetchStorageVerifierLinkage(
                provider,
                l1VerifierAddress,
            );
            report.l1Verifier = {
                address: l1VerifierAddress,
                zksyncDiamondAddress: linkage.zksyncDiamondAddress,
                smtAddress: linkage.smtAddress,
            };
            const valid = await ethCallStorageProofVerifierVerify(
                provider,
                l1VerifierAddress,
                proof,
                extra.registry,
                extra.storageKey,
            );
            report.l1Verify = { verifyReturned: valid };
            if (!valid) {
                const bn = proof.metadata.batchNumber;
                let l1StoredBatchHashAtProofBatch = null;
                let storedHashError = null;
                try {
                    l1StoredBatchHashAtProofBatch =
                        await fetchDiamondStoredBatchHash(
                            provider,
                            linkage.zksyncDiamondAddress,
                            bn,
                        );
                } catch (err) {
                    storedHashError = err?.message ?? String(err);
                }

                let smtRootFromProof = null;
                let smtRootError = null;
                try {
                    smtRootFromProof = await ethCallSmtGetRootHash(
                        provider,
                        linkage.smtAddress,
                        proof,
                        extra.registry,
                    );
                } catch (err) {
                    smtRootError = err?.message ?? String(err);
                }

                let computedL1BatchHashLegacy = null;
                let legacyHashError = null;
                let computedL1BatchHashV1 = null;
                let v1HashError = null;
                if (smtRootFromProof) {
                    try {
                        computedL1BatchHashLegacy = hashStoredBatchInfoLegacy(
                            smtRootFromProof,
                            proof.metadata,
                        );
                    } catch (err) {
                        legacyHashError = err?.message ?? String(err);
                    }
                    try {
                        computedL1BatchHashV1 = hashStoredBatchInfoV1(
                            smtRootFromProof,
                            proof.metadata,
                        );
                    } catch (err) {
                        v1HashError = err?.message ?? String(err);
                    }
                }

                const l1h = l1StoredBatchHashAtProofBatch;
                const legacyComputedMatchesL1StoredBatch =
                    Boolean(computedL1BatchHashLegacy && l1h) &&
                    computedL1BatchHashLegacy.toLowerCase() ===
                        l1h.toLowerCase();
                const v1ComputedMatchesL1StoredBatch =
                    Boolean(computedL1BatchHashV1 && l1h) &&
                    computedL1BatchHashV1.toLowerCase() === l1h.toLowerCase();

                let l2BatchRootHash = null;
                let l2BatchDetailsError = null;
                let smtRootMatchesL2BatchRoot = null;
                if (l2RpcUrl) {
                    try {
                        const details = await zksGetL1BatchDetails(
                            l2RpcUrl,
                            bn,
                        );
                        l2BatchRootHash =
                            details?.rootHash ??
                            details?.baseRootHash ??
                            null;
                        if (l2BatchRootHash && smtRootFromProof) {
                            smtRootMatchesL2BatchRoot =
                                String(l2BatchRootHash).toLowerCase() ===
                                smtRootFromProof.toLowerCase();
                        }
                    } catch (err) {
                        l2BatchDetailsError = err?.message ?? String(err);
                    }
                }

                const eitherHashMatches =
                    legacyComputedMatchesL1StoredBatch ||
                    v1ComputedMatchesL1StoredBatch;
                report.l1VerifyDebug = {
                    proofBatchNumber: bn.toString(),
                    l1StoredBatchHashAtProofBatch,
                    storedBatchHashReadError: storedHashError,
                    smtRootFromProof,
                    smtRootError,
                    computedL1BatchHashLegacy,
                    legacyHashEncodeError: legacyHashError,
                    legacyComputedMatchesL1StoredBatch,
                    computedL1BatchHashV1,
                    v1HashEncodeError: v1HashError,
                    v1ComputedMatchesL1StoredBatch,
                    l2BatchRootHash,
                    l2BatchDetailsError,
                    smtRootMatchesL2BatchRoot,
                    interpretationHint:
                        smtRootMatchesL2BatchRoot === true &&
                        !eitherHashMatches
                            ? 'SMT root 同 L2 rootHash 一致，但 legacy / v1 hash 都唔夾：好多時係 l2LogsTreeRoot 錯 — Executor 用 commit calldata 內 systemLogs（key 0），唔係 Diamond.l2LogsRootHash(batch)（後者可能長期係 0）。另檢查 commitment、dependencyRootsRollingHash（key 7，可為 0）、同 gateway 係咪用新版 @getclave/zksync-storage-proofs。'
                            : smtRootMatchesL2BatchRoot === true &&
                                eitherHashMatches
                              ? '本地計嘅 legacy 或 v1 hash 已等於 storedBatchHash，但 verify 仍 false：確認 L1 eth_call 指向嘅 StorageProofVerifier 係已部署新版（支援雙路徑），同 smt 地址一致。'
                              : smtRootMatchesL2BatchRoot === false
                                ? 'SMT root 同 L2 rootHash 唔一致：proof 過期、錯 batch、或 SparseMerkleTree / RPC proof 唔夾。'
                                : '見 computedL1BatchHashLegacy、computedL1BatchHashV1 與 l1StoredBatchHashAtProofBatch 逐項對照。',
                    explanation:
                        'Verifier：SMT root 填入 batchHash，再 keccak256(abi.encode) 同 diamond.storedBatchHash 比；新版合約接受 v1 StoredBatchInfo 或 LegacyStoredBatchInfo 兩種 encoding。',
                };
            }
        } catch (e) {
            report.l1Verify = { error: e?.message ?? String(e) };
        }
    }

    return report;
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
    if (cmd === 'resolve-probe') {
        await cmdResolveProbe(rest);
        return;
    }
    if (cmd === 'resolve-verify') {
        await cmdResolveVerify(rest);
        return;
    }
    if (cmd === 'resolve-diagnose') {
        await cmdResolveDiagnose(rest);
        return;
    }
    if (cmd === '-h' || cmd === '--help') {
        console.log(`Usage:
  node scripts/clave-ccip-bridge.cjs [demo]     SepoliaStorageProofProvider sample → encode preview
  node scripts/clave-ccip-bridge.cjs encode <proof.json|-> [fallbackBytes32]
  node scripts/clave-ccip-bridge.cjs decode <0x...|file.hex|->   verify gateway payload ABI
  node scripts/clave-ccip-bridge.cjs storage-key <label> <coinType> [mappingSlot]
  node scripts/clave-ccip-bridge.cjs resolve-probe <resolver> <full.name.eth> <rpcUrl> [queryCoinType]
      queryCoinType 可選：十進位 ENSIP-11（如 Base 2147492101）；省略 = addr(bytes32) → 60
  node scripts/clave-ccip-bridge.cjs resolve-verify <resolver> <response.hex|0x|-> <extraData 0x...> <l1RpcUrl>
      等同 test_record 步驟 3：resolveWithProof eth_call
  node scripts/clave-ccip-bridge.cjs resolve-diagnose <response> <extraData> [l2Rpc] [l1Verifier] [l1Rpc]
      步驟 4：proof / fallback / extraData / 可選 L2 槽位 / L1 verify(bool)`);
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

/**
 * DNS wire：`[len][ascii 每段]…` + `0x00`（唔係 UTF-8 淨字串）。
 * @param {string} fullName e.g. `"hugol.anchort.eth"`
 * @returns {string} `0x` hex
 */
function encodeEnsDnsWire(fullName) {
  return dnsEncode(fullName);
}

/**
 * ENS namehash（同 `cast namehash "<full>"`）。
 * @param {string} fullName
 * @returns {string} bytes32 hex
 */
function ensNamehash(fullName) {
  return namehash(fullName);
}

/**
 * `addr(bytes32)` 內層 calldata：`0x3b3b57de` + 32-byte namehash(FULL_NAME)。
 * @param {string} fullName
 * @returns {string} 36 bytes hex
 */
function encodeAddrBytes32Calldata(fullName) {
  return concat([ADDR_BYTES32_SELECTOR, namehash(fullName)]);
}

/**
 * `resolve(bytes,bytes)` calldata：selector `0x9061b923` + ABI 編碼 (dnsWire, addrCalldata)。
 * @param {string} fullName
 * @param {bigint|number|string} [queryCoinType] — 若提供，內層用 `addr(bytes32,uint256)`（ClaveResolver 會用此作 `queryCoinType` / extraData 第三欄）；省略則用 `addr(bytes32)`（固定當 ETH / 60）。
 * @returns {{ dnsWire: string, namehash: string, addrCalldata: string, resolveCalldata: string, queryCoinType: string|null }}
 */
function buildResolveCalldataParts(fullName, queryCoinType) {
  const dnsWire = dnsEncode(fullName);
  const nh = namehash(fullName);
  let addrCalldata;
  let coinTypeOut = null;
  if (queryCoinType === undefined || queryCoinType === null) {
    addrCalldata = concat([ADDR_BYTES32_SELECTOR, nh]);
  } else {
    const ct = BigInt(queryCoinType);
    coinTypeOut = ct.toString();
    addrCalldata = ADDR_MULTICHAIN_IFACE.encodeFunctionData('addr', [nh, ct]);
  }
  const resolveCalldata = RESOLVE_BYTES_BYTES_IFACE.encodeFunctionData(
    'resolve',
    [dnsWire, addrCalldata],
  );
  return {
    dnsWire,
    namehash: nh,
    addrCalldata,
    resolveCalldata,
    queryCoinType: coinTypeOut,
  };
}

/**
 * 步驟 3（對應 deploy/test_record.txt）：組 `resolveWithProof(bytes,bytes)` calldata。
 * `response` = gateway 完整 0x…（與 decode 用嘅同一串）；`extraData` = 同一次 OffchainLookup 第五參數。
 *
 * @param {string} responseHex
 * @param {string} extraDataHex
 * @returns {string} full tx calldata 0x…
 */
function encodeResolveWithProofCalldata(responseHex, extraDataHex) {
  const norm = (h) => {
    const s = String(h).trim().replace(/^["']|["']$/g, '');
    return s.startsWith('0x') ? s : `0x${s}`;
  };
  return RESOLVE_WITH_PROOF_IFACE.encodeFunctionData('resolveWithProof', [
    norm(responseHex),
    norm(extraDataHex),
  ]);
}

/**
 * 對 L1 Resolver `eth_call resolveWithProof`（唔發交易）。decode 成功唔代表 verify 一定過。
 *
 * @param {string} resolverAddress
 * @param {string} responseHex
 * @param {string} extraDataHex
 * @param {string|import('ethers').Provider} providerOrRpcUrl
 * @param {{ blockTag?: string }} [options]
 * @returns {Promise<{ ok: boolean, calldata: string, returnData: string|null, revertData: string|null, errorMessage: string|null }>}
 */
async function ethCallResolveWithProof(
  resolverAddress,
  responseHex,
  extraDataHex,
  providerOrRpcUrl,
  options = {},
) {
  const { blockTag = 'latest' } = options;
  const calldata = encodeResolveWithProofCalldata(responseHex, extraDataHex);
  const provider =
    typeof providerOrRpcUrl === 'string'
      ? new JsonRpcProvider(providerOrRpcUrl)
      : providerOrRpcUrl;
  try {
    const returnData = await provider.call({
      to: resolverAddress,
      data: calldata,
      blockTag,
      enableCcipRead: false,
    });
    return {
      ok: true,
      calldata,
      returnData,
      revertData: null,
      errorMessage: null,
    };
  } catch (err) {
    return {
      ok: false,
      calldata,
      returnData: null,
      revertData: extractEthCallRevertData(err),
      errorMessage: err?.message ?? String(err),
    };
  }
}

function extractEthCallRevertData(err) {
  if (err == null) return null;
  if (typeof err.data === 'string' && err.data.startsWith('0x')) {
    return err.data;
  }
  const nested = err.info?.error?.data ?? err.error?.data;
  if (typeof nested === 'string' && nested.startsWith('0x')) {
    return nested;
  }
  return null;
}

/**
 * 嘗試解 EIP-3668 `OffchainLookup`（revert data 開頭 `0x556f1830`）。
 * @param {string|null} revertData
 * @returns {object|null}
 */
function tryDecodeOffchainLookupRevert(revertData) {
  if (
    !revertData ||
    revertData.length < 10 ||
    revertData.slice(0, 10).toLowerCase() !== '0x556f1830'
  ) {
    return null;
  }
  try {
    const parsed = OFFCHAIN_LOOKUP_IFACE.parseError(revertData);
    return {
      sender: parsed.args.sender,
      urls: [...parsed.args.urls],
      callData: parsed.args.callData,
      callbackFunction: parsed.args.callbackFunction,
      extraData: parsed.args.extraData,
    };
  } catch {
    return { raw: revertData };
  }
}

/**
 * 一次過：DNS wire、namehash、內層 `addr` calldata、`resolve(bytes,bytes)` calldata、對 resolver `eth_call`。
 * 預期 ClaveResolver 會 revert 帶 `OffchainLookup`（關 `enableCcipRead: false` 唔跟 CCIP redirect）。
 *
 * @param {string} resolverAddress
 * @param {string} fullEnsName 完整名，如 `hugol.anchort.eth`
 * @param {string|import('ethers').Provider} providerOrRpcUrl
 * @param {{ blockTag?: string, coinType?: bigint|number|string }} [options] — `coinType` 有值時用 `addr(bytes32,uint256)`；否則 `addr(bytes32)`（60）
 * @returns {Promise<{
 *   dnsWire: string,
 *   namehash: string,
 *   addrCalldata: string,
 *   resolveCalldata: string,
 *   queryCoinType: string|null,
 *   ethCallSuccess: boolean,
 *   returnData: string|null,
 *   revertData: string|null,
 *   offchainLookup: object|null,
 *   callException: boolean,
 *   errorMessage: string|null
 * }>}
 */
async function fullEnsResolveOffchainLookupEthCall(
  resolverAddress,
  fullEnsName,
  providerOrRpcUrl,
  options = {},
) {
  const { blockTag = 'latest', coinType } = options;
  const parts = buildResolveCalldataParts(fullEnsName, coinType);
  const provider =
    typeof providerOrRpcUrl === 'string'
      ? new JsonRpcProvider(providerOrRpcUrl)
      : providerOrRpcUrl;

  try {
    const returnData = await provider.call({
      to: resolverAddress,
      data: parts.resolveCalldata,
      blockTag,
      enableCcipRead: false,
    });
    return {
      ...parts,
      ethCallSuccess: true,
      returnData,
      revertData: null,
      offchainLookup: null,
      callException: false,
      errorMessage: null,
    };
  } catch (err) {
    const revertData = extractEthCallRevertData(err);
    const callException = isError(err, 'CALL_EXCEPTION');
    return {
      ...parts,
      ethCallSuccess: false,
      returnData: null,
      revertData,
      offchainLookup: tryDecodeOffchainLookupRevert(revertData),
      callException,
      errorMessage: err?.message ?? String(err),
    };
  }
}

/** 同 {@link fullEnsResolveOffchainLookupEthCall}（「一條龍」別名） */
const all = fullEnsResolveOffchainLookupEthCall;

async function cmdResolveProbe(argv) {
  const [resolver, fullName, rpcUrl, queryCoinTypeArg] = argv;
  if (!resolver || !fullName || !rpcUrl) {
    console.error(
      'Usage: node scripts/clave-ccip-bridge.cjs resolve-probe <resolver> <full.name.eth> <rpcUrl> [queryCoinType]',
    );
    process.exit(1);
  }
  const coinTypeOpt =
    queryCoinTypeArg === undefined || queryCoinTypeArg === ''
      ? undefined
      : queryCoinTypeArg;
  const out = await fullEnsResolveOffchainLookupEthCall(
    resolver,
    fullName,
    rpcUrl,
    coinTypeOpt === undefined ? {} : { coinType: coinTypeOpt },
  );
  console.log(
    JSON.stringify(
      {
        dnsWire: out.dnsWire,
        namehash: out.namehash,
        addrCalldata: out.addrCalldata,
        resolveCalldata: out.resolveCalldata,
        queryCoinType: out.queryCoinType,
        ethCallSuccess: out.ethCallSuccess,
        returnData: out.returnData,
        revertData: out.revertData,
        offchainLookup: out.offchainLookup,
        callException: out.callException,
        errorMessage: out.errorMessage,
      },
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
      2,
    ),
  );
  if (out.ethCallSuccess) {
    console.error(
      'Note: call succeeded (no revert). Expected OffchainLookup revert for CCIP resolvers.',
    );
  } else if (out.offchainLookup) {
    console.error('OK: revert decodes as EIP-3668 OffchainLookup');
  } else if (out.revertData) {
    console.error(
      'Revert data present but not OffchainLookup (see revertData).',
    );
  }
}

/** resolve-verify：印用法說明（stderr） */
function printResolveVerifyHelp() {
    console.error(`resolve-verify — L1 eth_call resolveWithProof(bytes,bytes)
  用法：
    node scripts/clave-ccip-bridge.cjs resolve-verify <resolver> <response> <extraData> <l1RpcUrl>
  參數：
    resolver   L1 ClaveResolver 地址（同 resolve-probe 用嗰個）。
    response   Gateway 回傳嘅完整 0x…（即 decode 子命令驗過嗰串；abi.encode(StorageProof, bytes32)）。
               可：檔案路徑、stdin「-」、或字面 0x（好長建議放檔）。
    extraData  同一次 resolve 觸發嘅 OffchainLookup 第五個欄位（bytes），唔係成段 revert。
               用 cast decode-error --sig "OffchainLookup(address,string[],bytes,bytes4,bytes)" … 解出。
               內容係 abi.encode(l2Registry, storageKeyUint256, queryCoinTypeUint256)；
               必須同「產生呢份 response」嗰次 lookup 一對一。
    l1RpcUrl   L1 RPC（例如 eth-sepolia），唔好用 zkSync L2 URL。
  例子：
    node scripts/clave-ccip-bridge.cjs resolve-verify 0xYourResolver \\
      ./result/gw-response.hex \\
      0x000000000000000000000000802be667... \\
      "$RPC_URL_L1"
  `);
  }

async function cmdResolveDiagnose(argv) {
    const [responseArg, extraArg, l2Rpc, l1Verifier, l1Rpc] = argv;
    if (!responseArg || !extraArg) {
        console.error(`Usage:
  node scripts/clave-ccip-bridge.cjs resolve-diagnose <response> <extraData> [l2Rpc] [l1Verifier] [l1Rpc]

  response    gateway 完整 0x… 或檔案路徑或「-」stdin（同 decode / resolve-verify）
  extraData   OffchainLookup 第五欄 abi.encode(registry, storageKey, coinType)
  l2Rpc       （可選）zkSync L2 RPC → eth_getStorageAt(registry, slot) 同 proof.value 比對
  l1Verifier  （可選）L1 StorageProofVerifier 地址（會 print 綁定嘅 zksyncDiamondAddress、smt）
  l1Rpc       （可選）L1 RPC；必須同時俾 l1Verifier；verify=false 時會 print SMT root、legacy hash、同 storedBatchHash 對照（有 l2Rpc 會再對 zks_getL1BatchDetails.rootHash）

例子（只解碼）：
  node scripts/clave-ccip-bridge.cjs resolve-diagnose ./result/gw-response.hex 0x...extra...
例子（加 L2 + L1）：
  node scripts/clave-ccip-bridge.cjs resolve-diagnose ./gw.hex 0x... \\
    "$RPC_ZKSYNC_SEPOLIA" 0xf08d17d547C752187D3E13efD4E2F1ED778d696a "$RPC_ETH_SEPOLIA"`);
        process.exit(1);
    }
    const responseHex = readHexPayload(responseArg);
    if (!responseHex) {
        console.error('參數 1（response）讀唔到有效 hex。');
        process.exit(1);
    }
    const extraDataHex = String(extraArg).trim();
    try {
        const report = await runResolveDiagnose(responseHex, extraDataHex, {
            l2RpcUrl: l2Rpc || undefined,
            l1VerifierAddress: l1Verifier || undefined,
            l1RpcUrl: l1Rpc || undefined,
        });
        console.log(JSON.stringify(report, null, 2));
        console.error(
            'OK: 見 flags（proofValueIsZero / fallbackIsZero）、suggestedCastCommands；有俾 RPC 則睇 l2 / l1Verifier / l1Verify。',
        );
        if (report.l1Verifier) {
            console.error('[resolve-diagnose] L1 StorageProofVerifier 綁定：');
            console.error('  verifierAddress:', report.l1Verifier.address);
            console.error(
                '  zksyncDiamondAddress:',
                report.l1Verifier.zksyncDiamondAddress,
            );
            console.error('  smt (SparseMerkleTree):', report.l1Verifier.smtAddress);
        }
        if (report.l1Verify?.verifyReturned === false && report.l1VerifyDebug) {
            const d = report.l1VerifyDebug;
            console.error('\n[l1Verify=false] 對照用：');
            console.error('  proof.metadata.batchNumber:', d.proofBatchNumber);
            if (d.smtRootError) {
                console.error('  SMT getRootHash 失敗:', d.smtRootError);
            } else if (d.smtRootFromProof) {
                console.error('  SMT getRootHash（同 verify 用 extra.registry）:', d.smtRootFromProof);
            }
            if (d.legacyHashEncodeError) {
                console.error('  legacy StoredBatchInfo hash 計算失敗:', d.legacyHashEncodeError);
            } else if (d.computedL1BatchHashLegacy) {
                console.error(
                    '  keccak256(abi.encode legacy StoredBatchInfo)):',
                    d.computedL1BatchHashLegacy,
                );
            }
            console.error(
                '  legacy hash === L1 storedBatchHash ?',
                d.legacyComputedMatchesL1StoredBatch,
            );
            if (d.v1HashEncodeError) {
                console.error('  v1 StoredBatchInfo hash 計算失敗:', d.v1HashEncodeError);
            } else if (d.computedL1BatchHashV1) {
                console.error(
                    '  keccak256(abi.encode v1 StoredBatchInfo)):',
                    d.computedL1BatchHashV1,
                );
            }
            console.error(
                '  v1 hash === L1 storedBatchHash ?',
                d.v1ComputedMatchesL1StoredBatch,
            );
            if (d.l2BatchDetailsError) {
                console.error('  zks_getL1BatchDetails 失敗:', d.l2BatchDetailsError);
            } else if (d.l2BatchRootHash) {
                console.error('  L2 zks_getL1BatchDetails.rootHash:', d.l2BatchRootHash);
                console.error(
                    '  SMT root === L2 rootHash ?',
                    d.smtRootMatchesL2BatchRoot,
                );
            }
            if (d.storedBatchHashReadError) {
                console.error(
                    '  diamond.storedBatchHash 讀取失敗:',
                    d.storedBatchHashReadError,
                );
            } else {
                console.error(
                    '  L1 diamond.storedBatchHash(batch):',
                    d.l1StoredBatchHashAtProofBatch,
                );
            }
            if (d.interpretationHint) {
                console.error('  推斷:', d.interpretationHint);
            }
            console.error('  說明:', d.explanation);
        }
    } catch (e) {
        console.error('resolve-diagnose failed:', e?.message ?? e);
        process.exit(1);
    }
}

async function cmdResolveVerify(argv) {
  const [resolver, responseArg, extraDataHex, rpcUrl] = argv;
  if (!resolver || !responseArg || !extraDataHex || !rpcUrl) {
    console.error(
      'Usage: node scripts/clave-ccip-bridge.cjs resolve-verify <resolver> <response.hex|0x|-> <extraData 0x...> <l1RpcUrl>',
    );
    process.exit(1);
  }
  const responseHex = readHexPayload(responseArg);
  if (!responseHex) {
    console.error('Missing gateway response hex (arg 2).');
    process.exit(1);
  }
  const out = await ethCallResolveWithProof(
    resolver,
    responseHex,
    extraDataHex,
    rpcUrl,
  );
  console.log(
    JSON.stringify(
      {
        ok: out.ok,
        calldata: out.calldata,
        returnData: out.returnData,
        revertData: out.revertData,
        errorMessage: out.errorMessage,
      },
      null,
      2,
    ),
  );
  if (out.ok) {
    console.error('OK: resolveWithProof eth_call succeeded (see returnData).');
  } else {
    console.error('resolveWithProof eth_call failed (revert or RPC).');
    process.exit(1);
  }
}

module.exports = {
  encodeClaveGatewayResponse,
  decodeClaveGatewayResponse,
  decodeClaveExtraData,
  runResolveDiagnose,
  fetchStorageVerifierLinkage,
  fetchDiamondStoredBatchHash,
  hashStoredBatchInfoLegacy,
  hashStoredBatchInfoV1,
  metadataDependencyRootsOrZero,
  ethCallSmtGetRootHash,
  zksGetL1BatchDetails,
  ethCallStorageProofVerifierVerify,
  STORAGE_PROOF_ABI,
  labelTokenId,
  getMultichainStorageKey,
  ADDR_BYTES32_SELECTOR,
  ADDR_MULTICHAIN_SELECTOR,
  encodeEnsDnsWire,
  ensNamehash,
  encodeAddrBytes32Calldata,
  buildResolveCalldataParts,
  encodeResolveWithProofCalldata,
  ethCallResolveWithProof,
  tryDecodeOffchainLookupRevert,
  fullEnsResolveOffchainLookupEthCall,
  all,
};
