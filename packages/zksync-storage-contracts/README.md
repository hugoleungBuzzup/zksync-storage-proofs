# ZKsync Storage Contracts

## Deployment

From `packages/zksync-storage-contracts`:

```bash
forge build
# Deploy SparseMerkleTree + StorageProofVerifier with your L1 zkSync diamond address (e.g. Sepolia).
# Deploy ClaveResolver from src/ens/ClaveResolver.sol with constructor:
#   (url, domainOwner, l2Registry, storageProofVerifier, multichainLayout)
```

- **`multichainLayout = true`**, **`mappingSlot = 0`**: use [`MultichainNameRegistry`](./src/ens/MultichainNameRegistry.sol) on L2 (per-label + per–coin-type `bytes32` records).
- **`multichainLayout = false`**, **`mappingSlot = 2`**: legacy layout (one slot per first label), matching older demos; `addr(node, coinType)` only supports zkSync coin type until you switch layout.

## ENS: wiring `*.abc123.eth` (checklist)

1. **L2**: Deploy `MultichainNameRegistry`, call `setRecord(label, coinType, value)` (see [`ClaveResolver`](./src/ens/ClaveResolver.sol) for supported `coinType` constants: ETH 60, SOL 501, BNB 714, Base, zkSync).
2. **L1**: Deploy `SparseMerkleTree`, `StorageProofVerifier`, `ClaveResolver` against the zkSync diamond on that L1.
3. **ENS**: As owner of `abc123.eth`, set the name’s **resolver** to `ClaveResolver` and configure **wildcard / ENSIP-10** so clients resolve `hahah222.abc123.eth` via `resolve(bytes name, bytes data)` (DNS-encoded **three** labels: `sub.dom.eth`).
4. **Gateway**: HTTP handler compatible with your CCIP client; response body = `abi.encode(StorageProof, bytes32)` as today. Use [`getMultichainStorageKey`](../zksync-storage-proofs/scripts/clave-ccip-bridge.cjs) in JS to match on-chain `getMultichainDomainSlot` when fetching proofs.

## CCIP-Read: Clave vs “signed gateway”

| Stack | Verification |
|-------|----------------|
| **This repo (`ClaveResolver`)** | Gateway returns a **storage proof**; `StorageProofVerifier` checks it against L1 `storedBatchHash` (~60M gas in view — clients simulate). |
| **[ensdomains/offchain-resolver](../../../offchain-resolver/README.md)** | Same **EIP-3668** flow; gateway returns **signed** records; resolver checks signer. Good to learn CCIP-Read / gateway HTTP shape; **not** a drop-in replacement for storage proofs. |

Use **viem** / **ethers** CCIP helpers and any EIP-3668-capable wallet with either pattern.

## Tests

```bash
forge test # Runs all tests
```

## Dependencies

This repo uses a slightly modified version of https://github.com/AlexNi245/blake2s-solidity
for the Solidity implementation of Blake2S hash.

## Usage

In order to verify a storage proof:

1. Get storage proof from @getclave/zksync-storage-proofs
2. Pass it to the `StorageProofVerifier#verify` function to verify

> This takes around 60M gas so only call it inside view functions

> Most of the time it will make sense to override `account`, `key`
> fields to make sure proof is proving the correct content.

```solidity
import {StorageProof, StorageProofVerifier} from "./StorageProofVerifier.sol";

contract MyProofVerifier {
    StorageProofVerifier verifier;

    constructor(StorageProofVerifier _verifier) {
        verifier = _verifier;
    }

    function checkProof(
        address account,
        uint256 key,
        StorageProof memory proof
    ) external view returns (bool) {
        proof.account = account;
        proof.key = key;

        return verifier.verify(proof);
    }
}
```

You can also check out the [demo](./src/demo/) for an example implementation
