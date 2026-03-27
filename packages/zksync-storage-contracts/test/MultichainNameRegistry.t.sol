// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {MultichainNameRegistry} from "../src/ens/MultichainNameRegistry.sol";

contract MultichainNameRegistryTest is Test {
    MultichainNameRegistry internal reg;

    function setUp() public {
        reg = new MultichainNameRegistry();
    }

    /// @dev Internal helper to manually calculate the expected storage slot location.
    /// This must match the logic in the ClaveResolver for cross-contract data reading.    function _expectedSlot(string memory label, uint256 coinType) internal view returns (bytes32) {
    function _expectedSlot(string memory label, uint256 coinType) internal view returns (bytes32) {
        uint256 tid = reg.labelTokenId(label);

        // Step 1: Find the first level slot (mapping key for Token ID)
        bytes32 inner = keccak256(abi.encode(tid, uint256(0))); 
        
        // Step 2: Find the second level slot (nested mapping key for coinType)
        return keccak256(abi.encode(coinType, inner));
    }

    /**
     * @notice Test Case 1: Storage Slot Validation
     * Verifies that the data stored via setRecord() is physically located at the 
     * specific storage slot we expect. This is critical for systems that use 
     * low-level calls or off-chain proofs to read contract state.
     */
    function test_storage_slot_roundtrip() public {
        string memory label = "hahah222";
        uint256 coin = 60; // ETH SLIP-0044
        address a = address(0x1234567890123456789012345678901234567890);
        bytes32 val = bytes32(uint256(uint160(a)));

        // Write the data normally
        reg.setRecord(label, coin, val);

        // Read directly from raw storage using Foundry's VM cheatcode
        bytes32 loaded = vm.load(address(reg), _expectedSlot(label, coin));
        
        // Ensure the raw storage matches the value we set
        assertEq(loaded, val);
    }

    /**
     * @notice Test Case 2: Case Insensitivity Validation
     * Ensures that the registry treats uppercase (e.g., "ABC") and lowercase (e.g., "abc") 
     * inputs as the same domain. This prevents users from accidentally registering 
     * confusingly similar names.
     */
    function test_label_case_insensitive() public {
        // Store using uppercase
        reg.setRecord("ABC", 714, bytes32(uint256(1)));
        
        // Retrieve using lowercase and expect the same data
        assertEq(reg.getRecord("abc", 714), bytes32(uint256(1)));
    }

    /**
     * @notice Test Case 3: Multi-chain Data Isolation
     * Verifies that storing an address for one chain (e.g., ETH) does not 
     * overwrite or interfere with an address for another chain (e.g., Solana) 
     * under the same username.
     */
    function test_multichain_separate_slots() public {
        // Set an address for ETH (60)
        reg.setRecord("user", 60, bytes32(uint256(2)));
        // Set an address for Solana (501)
        reg.setRecord("user", 501, bytes32(uint256(3)));
        
        // Confirm both values exist independently and correctly
        assertEq(reg.getRecord("user", 60), bytes32(uint256(2)));
        assertEq(reg.getRecord("user", 501), bytes32(uint256(3)));
    }
}
