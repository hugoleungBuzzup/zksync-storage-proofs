# zksync-storage

Typescript library to generate and verify ZKsync storage proofs

## Install

```bash
yarn
```

## Usage

> Verify operation is a very gas-exhaustive function (around 60M gas) and not
> every provider allows us to run it, code is tested to be working on Infura
> providers

### Runnable scripts (after `npm run build`)

| Script | Command |
|--------|---------|
| README storage slot proof | `node scripts/readme-proof-sepolia.cjs [batchNumber]` |
| L2 ETH balance proof (`0x800a`, slot `p=0`) | `node scripts/balance-proof-sepolia.cjs <userAddress> [batchNumber]` |
| Encode ClaveResolver CCIP response | `node scripts/clave-ccip-bridge.cjs` |

The same module exports `getMultichainStorageKey` / `labelTokenId` for L2 [`MultichainNameRegistry`](../zksync-storage-contracts/src/ens/MultichainNameRegistry.sol) slot math (aligns with on-chain `ClaveResolver.getMultichainDomainSlot`).

Optional: `VERIFY=1` calls `verifyOnChain` (needs an L1 RPC that accepts ~60M gas `eth_call`).

Sepolia uses `SepoliaStorageProofProvider.blockQueryOffset = 5200` so default `batchNumber` works with public L1 RPCs that omit very recent commit txs.

### In code

```js
import { SepoliaStorageProofProvider } from '@getclave/zksync-storage-proofs';

async function main() {
    const batchNumber = process.argv[2] ? parseInt(process.argv[2]) : undefined;

    const proof = await SepoliaStorageProofProvider.getProof(
        '0x0000000000000000000000000000000000008003',
        '0x8b65c0cf1012ea9f393197eb24619fd814379b298b238285649e14f936a5eb12',
        batchNumber,
    );
    console.log('Storage Proof', proof);

    const verified = await SepoliaStorageProofProvider.verifyOnChain(proof);
    console.log('Verified:', verified);
}

main();
```
