export PRIVATE_KEY="你的私鑰(不要0x)"
export RPC_URL="https://eth-sepolia.g.alchemy.com/v2/BViqld61MeSIZzHJG8dJc"

export ETHERSCAN_API_KEY="SJX2SU7E95WHJP2GC7WBP3RF2BPHDAGRGZ"

# root folder = /Users/hugo/Documents/Calve/zksync-storage-proofs/packages/zksync-storage-contracts


forge create --broadcast ./src/clave-ens-resolver/AnchorResolver.sol:AnchorResolver \
  --rpc-url "$RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --constructor-args \
    "https://ccip-v3.ens.xyz" \
    "0xAF79440D36C4851691839d030652D4e90c1f19ae" \
    "0x802be667439aB31d9d914B76c6Ab14F6962FEbf9" \
    "0xf08d17d547C752187D3E13efD4E2F1ED778d696a" \
    true

#build json file for AnchorResolver
forge verify-contract --show-standard-json-input \
  0x0000000000000000000000000000000000000000 \
  ./src/clave-ens-resolver/AnchorResolver.sol:AnchorResolver \
  > AnchorResolver.json

CONSTRUCTOR_ARGS=$(cast abi-encode "constructor(string,address,address,address,bool)" \
  "https://ccip-v3.ens.xyz" \
  "0xAF79440D36C4851691839d030652D4e90c1f19ae" \
  "0x802be667439aB31d9d914B76c6Ab14F6962FEbf9" \
  "0xf08d17d547C752187D3E13efD4E2F1ED778d696a" \
  true)