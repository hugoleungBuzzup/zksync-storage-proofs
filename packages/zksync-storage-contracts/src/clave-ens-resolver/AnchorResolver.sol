// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ClaveResolver as ClaveResolverBase} from "../ens/ClaveResolver.sol";
import {StorageProofVerifier} from "../StorageProofVerifier.sol";

/// @dev Canonical implementation and tests live under `zksync-storage-contracts/src/ens/`.
///      Compile with: `cd ../zksync-storage-contracts && forge build` (see that package's README).
contract AnchorResolver is ClaveResolverBase {
    constructor(
        string memory _url,
        address _domainOwner,
        address _registry,
        StorageProofVerifier _verifier,
        bool _multichainLayout
    ) ClaveResolverBase(_url, _domainOwner, _registry, _verifier, _multichainLayout) {}
}
