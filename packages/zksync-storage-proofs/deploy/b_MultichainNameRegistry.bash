export PRIVATE_KEY="你的私鑰(不要0x)"

export RPC_ZKSYNC="https://zksync-sepolia.g.alchemy.com/v2/BViqld61MeSIZzHJG8dJc"

export ETHERSCAN_API_KEY="SJX2SU7E95WHJP2GC7WBP3RF2BPHDAGRGZ"

#change solc version to 0.8.20

#create contract MultichainNameRegistry
forge create --broadcast src/ens/MultichainNameRegistry.sol:MultichainNameRegistry \
 --rpc-url "$RPC_ZKSYNC" --private-key "$PRIVATE_KEY"


#build json file for AnchorResolver
forge verify-contract --show-standard-json-input \
  0x0000000000000000000000000000000000000000 \
  src/ens/MultichainNameRegistry.sol:MultichainNameRegistry \
  > MultichainNameRegistry.json