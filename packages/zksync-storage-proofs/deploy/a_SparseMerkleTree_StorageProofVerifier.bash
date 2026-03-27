export PRIVATE_KEY="你的私鑰(不要0x)"
export RPC_URL="https://eth-sepolia.g.alchemy.com/v2/BViqld61MeSIZzHJG8dJc"

export ETHERSCAN_API_KEY="SJX2SU7E95WHJP2GC7WBP3RF2BPHDAGRGZ"

# root folder = packages/zksync-storage-contracts

#create contract social recovery
forge create --broadcast src/SparseMerkleTree.sol:SparseMerkleTree \
 --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY"

#build json file for SparseMerkleTree
forge verify-contract --show-standard-json-input \
  0x0000000000000000000000000000000000000000 \
  src/SparseMerkleTree.sol:SparseMerkleTree \
  > SparseMerkleTree.json

##https://docs.zksync.io/zksync-network/environment/l1-contracts
## diamond proxy at L1 sepolia= 0x9A6DE0f62Aa270A8bCB1e2610078650D539B1Ef9
forge create --broadcast src/StorageProofVerifier.sol:StorageProofVerifier \
  --rpc-url "$RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --constructor-args "0x9A6DE0f62Aa270A8bCB1e2610078650D539B1Ef9" "0xA568BF11bcAA9441c246B81b8fb5C0c3b6B8A97b"

#build json file for StorageProofVerifier
forge verify-contract --show-standard-json-input \
  0x0000000000000000000000000000000000000000 \
  src/StorageProofVerifier.sol:StorageProofVerifier \
  > StorageProofVerifier.json

CONSTRUCTOR_ARGS=$(cast abi-encode "constructor(address,address)" \
  0x9A6DE0f62Aa270A8bCB1e2610078650D539B1Ef9 \
  0xA568BF11bcAA9441c246B81b8fb5C0c3b6B8A97b)