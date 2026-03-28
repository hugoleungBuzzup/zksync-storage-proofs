export PRIVATE_KEY="你的私鑰(不要0x)"
  export RPC_URL="https://eth-sepolia.g.alchemy.com/v2/BViqld61MeSIZzHJG8dJc"

export ETHERSCAN_API_KEY="SJX2SU7E95WHJP2GC7WBP3RF2BPHDAGRGZ"

# root folder = /Users/hugo/Documents/Calve/zksync-storage-proofs/packages/zksync-storage-contracts


/*
_url	string	你的 CCIP-Read（EIP-3668）gateway 完整 URL（客戶端會依此發 HTTP 請求拿證明），例如 https://你的網域/...。之後可用 setUrl 改。
_domainOwner	address	在 Sepolia ENS 上擁有該二級域名的地址（例如你擁有 abc123.eth 的錢包）。合約會用來校驗解析到的域名是否屬於這個 owner。
_registry	address	L2（zkSync Sepolia） 上已部署的 MultichainNameRegistry 合約地址（儲存 setRecord 的 registry）。不是 L1 地址。
_verifier	StorageProofVerifier	Sepolia L1 上已部署的 StorageProofVerifier 合約地址（你 c_Resolver.bash 裡 forge create StorageProofVerifier 那顆；constructor 要帶 zkSync L1 diamond + SparseMerkleTree）。
_multichainLayout	bool	若用 MultichainNameRegistry 多鏈槽位布局，填 true；舊版「每 label 一槽」示範填 false。
*/


forge create --broadcast ./src/clave-ens-resolver/AnchorResolver.sol:AnchorResolver \
  --rpc-url "$RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --constructor-args \
    "https://e065-203-186-77-177.ngrok-free.app" \
    "0xAF79440D36C4851691839d030652D4e90c1f19ae" \
    "0x802be667439aB31d9d914B76c6Ab14F6962FEbf9" \
    "0x0AaA65f3E2F0235693c892f544AC949f767752A6" \
    true


#mainnet
forge create --broadcast ./src/clave-ens-resolver/AnchorResolver.sol:AnchorResolver \
  --rpc-url "$RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --constructor-args \
    "https://e065-203-186-77-177.ngrok-free.app" \
    "0xAF79440D36C4851691839d030652D4e90c1f19ae" \
    "0x802be667439aB31d9d914B76c6Ab14F6962FEbf9" \
    "0xaEDF4C9183A186B5228889988B18d6ADE8f3f452" \
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