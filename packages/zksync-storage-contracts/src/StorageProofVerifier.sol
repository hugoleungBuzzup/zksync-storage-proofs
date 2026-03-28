// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import { SparseMerkleTree, TreeEntry } from "./SparseMerkleTree.sol";

/// @notice Interface for the zkSync's contract
interface IZkSyncDiamond {
    /// @notice Returns the hash of the stored batch
    function storedBatchHash(uint256) external view returns (bytes32);
}

/// @dev Matches matter-labs `IExecutor.StoredBatchInfo` (encoding used by `storedBatchHash` on current zkSync L1).
/// @dev See `LegacyStoredBatchInfo` for batches committed before `dependencyRootsRollingHash` existed.
struct StoredBatchInfo {
    uint64 batchNumber;
    bytes32 batchHash;
    uint64 indexRepeatedStorageChanges;
    uint256 numberOfLayer1Txs;
    bytes32 priorityOperationsHash;
    bytes32 dependencyRootsRollingHash;
    bytes32 l2LogsTreeRoot;
    uint256 timestamp;
    bytes32 commitment;
}

/// @notice Legacy layout (no `dependencyRootsRollingHash`); Diamond may still store `keccak256(abi.encode(LegacyStoredBatchInfo))` for older batches.
struct LegacyStoredBatchInfo {
    uint64 batchNumber;
    bytes32 batchHash;
    uint64 indexRepeatedStorageChanges;
    uint256 numberOfLayer1Txs;
    bytes32 priorityOperationsHash;
    bytes32 l2LogsTreeRoot;
    uint256 timestamp;
    bytes32 commitment;
}

/// @notice Metadata of the batch provided by the offchain resolver / gateway (`batchHash` omitted; filled from SMT).
struct BatchMetadata {
    uint64 batchNumber;
    uint64 indexRepeatedStorageChanges;
    uint256 numberOfLayer1Txs;
    bytes32 priorityOperationsHash;
    bytes32 dependencyRootsRollingHash;
    bytes32 l2LogsTreeRoot;
    uint256 timestamp;
    bytes32 commitment;
}

/// @notice Storage proof that proves a storage key-value pair is included in the batch
struct StorageProof {
    BatchMetadata metadata;
    address account;
    uint256 key;
    bytes32 value;
    bytes32[] path;
    uint64 index;
}

contract StorageProofVerifier {
    IZkSyncDiamond immutable public zksyncDiamondAddress;
    SparseMerkleTree public smt;

    constructor(IZkSyncDiamond _zksyncDiamondAddress, SparseMerkleTree _smt) {
        zksyncDiamondAddress = _zksyncDiamondAddress;
        smt = _smt;
    }

    /// @notice Verifies the storage proof against L1 `storedBatchHash`.
    /// @dev Accepts either current `StoredBatchInfo` encoding or `LegacyStoredBatchInfo` (same as matter-labs Executor).
    function verify(StorageProof memory _proof) external view returns (bool valid) {
        bytes32 l2BatchHash = smt.getRootHash(
            _proof.path,
            TreeEntry({
                key: _proof.key,
                value: _proof.value,
                leafIndex: _proof.index
            }),
            _proof.account
        );

        StoredBatchInfo memory batchV1 = StoredBatchInfo({
            batchNumber: _proof.metadata.batchNumber,
            batchHash: l2BatchHash,
            indexRepeatedStorageChanges: _proof.metadata.indexRepeatedStorageChanges,
            numberOfLayer1Txs: _proof.metadata.numberOfLayer1Txs,
            priorityOperationsHash: _proof.metadata.priorityOperationsHash,
            dependencyRootsRollingHash: _proof.metadata.dependencyRootsRollingHash,
            l2LogsTreeRoot: _proof.metadata.l2LogsTreeRoot,
            timestamp: _proof.metadata.timestamp,
            commitment: _proof.metadata.commitment
        });

        LegacyStoredBatchInfo memory batchLegacy = LegacyStoredBatchInfo({
            batchNumber: _proof.metadata.batchNumber,
            batchHash: l2BatchHash,
            indexRepeatedStorageChanges: _proof.metadata.indexRepeatedStorageChanges,
            numberOfLayer1Txs: _proof.metadata.numberOfLayer1Txs,
            priorityOperationsHash: _proof.metadata.priorityOperationsHash,
            l2LogsTreeRoot: _proof.metadata.l2LogsTreeRoot,
            timestamp: _proof.metadata.timestamp,
            commitment: _proof.metadata.commitment
        });

        bytes32 l1BatchHash = zksyncDiamondAddress.storedBatchHash(_proof.metadata.batchNumber);
        valid =
            (keccak256(abi.encode(batchV1)) == l1BatchHash) ||
            (keccak256(abi.encode(batchLegacy)) == l1BatchHash);
    }
}
