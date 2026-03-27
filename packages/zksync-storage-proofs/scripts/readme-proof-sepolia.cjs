/**
 * Phase 1: reproduce README storage proof on zkSync Sepolia + Ethereum Sepolia.
 *
 * Usage:
 *   node scripts/readme-proof-sepolia.cjs [batchNumber]
 *   VERIFY=1 node scripts/readme-proof-sepolia.cjs [batchNumber]
 */
const { SepoliaStorageProofProvider } = require('../build/cjs/index.js');

const batchArg = process.argv[2];
const batchNumber = batchArg !== undefined ? parseInt(batchArg, 10) : undefined;

const account = '0x0000000000000000000000000000000000008003';
const storageKey =
    '0x8b65c0cf1012ea9f393197eb24619fd814379b298b238285649e14f936a5eb12';

async function main() {
    console.log('Fetching proof for', { account, storageKey, batchNumber });
    const proof = await SepoliaStorageProofProvider.getProof(
        account,
        storageKey,
        batchNumber,
    );
    console.log(
        'StorageProof:',
        JSON.stringify(proof, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
    );

    if (process.env.VERIFY === '1') {
        const verified = await SepoliaStorageProofProvider.verifyOnChain(proof);
        console.log('verifyOnChain:', verified);
    } else {
        console.log(
            'Skip on-chain verify (set VERIFY=1 to run; needs RPC that allows ~60M gas eth_call)',
        );
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
