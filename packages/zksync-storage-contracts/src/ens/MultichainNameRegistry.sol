// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MultichainNameRegistry
/// @notice L2 demo registry: one bytes32 record per (label, SLIP-44 / ENSIP-11 coin type).
/// @dev First state variable is `records` at storage slot 0. ClaveResolver must use
///      `mappingSlot == 0` and `multichainLayout == true` so `getMultichainDomainSlot` matches layout:
///      keccak256(abi.encode(coinType, keccak256(abi.encode(tokenId, 0)))).
///      EVM addresses: store as uint256(uint160(addr)) in the word (ERC-2304 20-byte form padded).
///      Solana: store 32-byte pubkey in the word.
contract MultichainNameRegistry {
    mapping(uint256 tokenId => mapping(uint256 coinType => bytes32)) public records;

    event RecordSet(uint256 indexed tokenId, uint256 indexed coinType, bytes32 value);

    function _asciiLowerInPlace(bytes memory b) private pure {
        for (uint256 i = 0; i < b.length; i++) {
            uint8 c = uint8(b[i]);
            if (c >= 65 && c <= 90) {
                b[i] = bytes1(c + 32);
            }
        }
    }

    /// @notice Token id for the first DNS label (e.g. "hahah222" for hahah222.abc123.eth).
    function labelTokenId(string calldata label) public pure returns (uint256) {
        bytes memory b = bytes(label);
        _asciiLowerInPlace(b);
        return uint256(keccak256(b));
    }

    /// @notice Unauthenticated demo setter (same trust model as demo Registry.sol).
    function setRecord(string calldata label, uint256 coinType, bytes32 value) external {
        uint256 tid = labelTokenId(label);
        records[tid][coinType] = value;
        emit RecordSet(tid, coinType, value);
    }

    function getRecord(string calldata label, uint256 coinType) external view returns (bytes32) {
        return records[labelTokenId(label)][coinType];
    }
}
