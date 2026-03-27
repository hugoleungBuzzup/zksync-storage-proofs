/**
 * Phase 2: L2 native ETH balance storage proof on zkSync Sepolia.
 *
 * L2BaseToken: balance mapping is first state var, base has no storage → slot p = 0.
 * Storage key: keccak256(abi.encode(userAddress, uint256(0))).
 *
 * Usage:
 *   node scripts/balance-proof-sepolia.cjs <l2UserAddress> [batchNumber]
 *   VERIFY=1 node scripts/balance-proof-sepolia.cjs <l2UserAddress> [batchNumber]
 *
 * Workflow diagram: ./balance-proof-sepolia-FLOW.md
 */
const { AbiCoder, keccak256, getAddress } = require('ethers');
const { Provider: L2Provider } = require('zksync-ethers');
const { SepoliaStorageProofProvider } = require('../build/cjs/index.js');

const L2_ETH_TOKEN = '0x000000000000000000000000000000000000800a';
const BALANCE_MAPPING_BASE_SLOT = 0n;

function ethBalanceStorageKey(userAddress) {
    const user = getAddress(userAddress);
    const encoded = AbiCoder.defaultAbiCoder().encode(
        ['address', 'uint256'],
        [user, BALANCE_MAPPING_BASE_SLOT],
    );
    return keccak256(encoded);
}

async function main() {
    const user = process.argv[2];
    if (!user) {
        console.error(
            'Usage: node scripts/balance-proof-sepolia.cjs <l2UserAddress> [batchNumber]',
        );
        process.exit(1);
    }
    const batchArg = process.argv[3];
    const batchNumber = batchArg !== undefined ? parseInt(batchArg, 10) : undefined;

    const storageKey = ethBalanceStorageKey(user);
    console.log('L2 ETH token:', L2_ETH_TOKEN);
    console.log('User:', getAddress(user));
    console.log('Balance storage key (slot):', storageKey);

    const l2 = new L2Provider('https://sepolia.era.zksync.dev');
    const proof = await SepoliaStorageProofProvider.getProof(
        L2_ETH_TOKEN,
        storageKey,
        batchNumber,
    );

    const valueHex = proof.value;
    const balanceFromProof = BigInt(valueHex);
    console.log('Proof value (wei):', balanceFromProof.toString());

    const batchNum = Number(proof.metadata.batchNumber);
    const range = await l2.getL1BatchBlockRange(batchNum);
    const blockTag = range ? range[1] : 'latest';
    const fromStorage = await l2.getStorage(L2_ETH_TOKEN, storageKey, blockTag);
    console.log('getStorage (eth_getStorageAt) at batch L2 block', blockTag, ':', fromStorage);
    if (fromStorage.toLowerCase() !== valueHex.toLowerCase()) {
        console.warn(
            'Warning: storage slot vs proof value mismatch (try an older batchNumber if batch boundary skew).',
        );
    }

    const balRpc = await l2.getBalance(getAddress(user), blockTag);
    console.log('getBalance same blockTag:', balRpc.toString());
    if (balRpc !== balanceFromProof) {
        console.warn(
            'Note: getBalance may differ from proof.value if blockTag does not match proof batch state.',
        );
    }

    console.log(
        'Full proof JSON:',
        JSON.stringify(proof, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
    );

    if (process.env.VERIFY === '1') {
        const verified = await SepoliaStorageProofProvider.verifyOnChain(proof);
        console.log('verifyOnChain:', verified);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
