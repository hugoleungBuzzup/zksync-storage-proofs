// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "./Ownable.sol";
import {StorageProof, StorageProofVerifier} from "../StorageProofVerifier.sol";

interface IOffchainResolver {
    function resolve(
        bytes calldata name,
        bytes calldata data
    ) external view returns (StorageProof memory proof, bytes32 fallbackValue);
}

/// @title IExtendedResolver
/// @notice ENSIP-10: Wildcard Resolution
interface IExtendedResolver {
    function resolve(
        bytes calldata name,
        bytes calldata data
    ) external view returns (bytes memory);
}

interface IClaveResolver is IExtendedResolver {
    function supportsInterface(bytes4 interfaceID) external pure returns (bool);
}

/// @title ClaveResolver
/// @notice ENSIP-10 resolver using EIP-3668 (CCIP Read) + zkSync L2 storage proofs.
/// @dev Wildcard names must be DNS-encoded with exactly three labels: sub.dom.eth (e.g. hahah222.abc123.eth).
contract ClaveResolver is IClaveResolver, Ownable {
    error InvalidDnsDomain();

    bytes4 private constant INTERFACE_META_ID = 0x01ffc9a7; // EIP-165
    bytes4 private constant EXTENDED_INTERFACE_ID = 0x9061b923; // ENSIP-10
    bytes4 public constant ADDR_SELECTOR = 0x3b3b57de; // addr(bytes32)
    bytes4 public constant ADDR_MULTICHAIN_SELECTOR = 0xf1cb7e06; // addr(bytes32,uint256)

    /// @notice SLIP-44 Ethereum mainnet
    uint256 public constant COIN_SLIP44_ETH = 60;
    /// @notice SLIP-44 Solana
    uint256 public constant COIN_SLIP44_SOL = 501;
    /// @notice SLIP-44 Binance Chain / BNB
    uint256 public constant COIN_SLIP44_BNB = 714;
    /// @notice zkSync Era (ENSIP-11 style)
    uint256 public constant ZKSYNC_MAINNET_COIN_TYPE = 2147483972;
    /// @notice Base (EIP-155 chainId 8453, ENSIP-11)
    uint256 public constant COIN_TYPE_BASE =
        uint256(uint32(0x80000000 | 8453));
    /// @notice Arbitrum ARB1 (path 0x80002329, coin type component 9001, ENSIP-11)
    uint256 public constant COIN_TYPE_ARBITRUM =
        uint256(uint32(0x80002329));

    error OffchainLookup(
        address sender,
        string[] urls,
        bytes callData,
        bytes4 callbackFunction,
        bytes extraData
    );
    error UnsupportedCoinType(uint256 coinType);
    error UnsupportedSelector(bytes4 selector);

    StorageProofVerifier public storageProofVerifier;
    string public url;
    address public registry;
    /// @notice Outer mapping slot for L2 registry (0 for MultichainNameRegistry.records)
    uint256 public mappingSlot = 2;
    address public domainOwner;
    bool public validateProofs = true;
    /// @notice If true, use nested mapping layout (MultichainNameRegistry). If false, legacy single slot per label.
    bool public multichainLayout;

    constructor(
        string memory _url,
        address _domainOwner,
        address _registry,
        StorageProofVerifier _storageProofVerifier,
        bool _multichainLayout
    ) Ownable(msg.sender) {
        url = _url;
        domainOwner = _domainOwner;
        registry = _registry;
        storageProofVerifier = _storageProofVerifier;
        multichainLayout = _multichainLayout;
    }

    function setValidate(bool _validate) external onlyOwner {
        validateProofs = _validate;
    }

    function setUrl(string memory _url) external onlyOwner {
        url = _url;
    }

    function setRegistry(
        address _registry,
        uint256 _mappingSlot
    ) external onlyOwner {
        registry = _registry;
        mappingSlot = _mappingSlot;
    }

    function setStorageProofVerifier(
        StorageProofVerifier _storageProofVerifier
    ) external onlyOwner {
        storageProofVerifier = _storageProofVerifier;
    }

    function setMultichainLayout(bool _multichainLayout) external onlyOwner {
        multichainLayout = _multichainLayout;
    }

    function extractNamehash(
        bytes calldata data
    ) public pure returns (bytes32 namehash) {
        namehash = bytes32(data[data.length - 32:]);
    }

    /// @notice Parses DNS-encoded name into three labels: sub.dom.eth
    function parseDnsDomain(
        bytes calldata name
    )
        internal
        pure
        returns (string memory sub, string memory dom, string memory top)
    {
        uint256 length = name.length;

        uint8 firstlen = uint8(name[0]);
        string memory first = string(name[1:1 + firstlen]);

        if (length == firstlen + 2) return ("", "", first);

        uint8 secondlen = uint8(name[firstlen + 1]);
        string memory second = string(
            name[firstlen + 2:firstlen + 2 + secondlen]
        );

        if (length == firstlen + secondlen + 3) return ("", first, second);

        uint8 thirdlen = uint8(name[firstlen + secondlen + 2]);
        string memory third = string(
            name[firstlen + secondlen + 3:firstlen + secondlen + 3 + thirdlen]
        );

        return (first, second, third);
    }

    function getDomainSlot(bytes32 _key) public view returns (bytes32) {
        return keccak256(abi.encode(_key, mappingSlot));
    }

    function toLower(string memory str) private pure returns (string memory) {
        bytes memory bStr = bytes(str);
        bytes memory bLower = new bytes(bStr.length);
        for (uint256 i = 0; i < bStr.length; i++) {
            if ((uint8(bStr[i]) >= 65) && (uint8(bStr[i]) <= 90)) {
                bLower[i] = bytes1(uint8(bStr[i]) + 32);
            } else {
                bLower[i] = bStr[i];
            }
        }
        return string(bLower);
    }

    /// @notice Legacy layout: one value per label (demo Registry-style).
    function getDomainSlot(string memory _key) public view returns (bytes32) {
        string memory domain = toLower(_key);
        uint256 tokenId = uint256(keccak256(abi.encodePacked(domain)));
        return keccak256(abi.encode(tokenId, mappingSlot));
    }

    /// @notice MultichainNameRegistry layout: mapping(tokenId => mapping(coinType => bytes32)) at `mappingSlot`.
    function getMultichainDomainSlot(
        string memory sub,
        uint256 coinType
    ) public view returns (uint256) {
        string memory domain = toLower(sub);
        uint256 tokenId = uint256(keccak256(abi.encodePacked(domain)));
        bytes32 inner = keccak256(abi.encode(tokenId, mappingSlot));
        return uint256(keccak256(abi.encode(coinType, inner)));
    }

    function _isSupportedCoinType(uint256 coinType) internal pure returns (bool) {
        if (
            coinType == COIN_SLIP44_ETH ||
            coinType == COIN_SLIP44_SOL ||
            coinType == COIN_SLIP44_BNB ||
            coinType == ZKSYNC_MAINNET_COIN_TYPE ||
            coinType == COIN_TYPE_BASE ||
            coinType == COIN_TYPE_ARBITRUM
        ) {
            return true;
        }
        return false;
    }

    /// @notice ERC-2304 binary: Solana 32 bytes; EVM chains 20-byte address in word.
    function _formatResolvedAddr(
        bytes32 word,
        uint256 coinType
    ) internal pure returns (bytes memory) {
        if (coinType == COIN_SLIP44_SOL) {
            return abi.encodePacked(word);
        }
        return abi.encodePacked(address(uint160(uint256(word))));
    }

    function resolve(
        bytes calldata _name,
        bytes calldata _data
    ) external view returns (bytes memory) {
        bytes memory callData = abi.encodeWithSelector(
            IOffchainResolver.resolve.selector,
            _name,
            _data
        );

        string[] memory urls = new string[](1);
        urls[0] = url;

        (
            string memory sub,
            string memory dom,
            string memory top
        ) = parseDnsDomain(_name);

        if (bytes(dom).length == 0 || bytes(top).length == 0) {
            revert InvalidDnsDomain();
        }

        if (bytes(sub).length == 0) {
            return abi.encodePacked(domainOwner);
        }

        bytes4 functionSelector = bytes4(_data[:4]);
        uint256 queryCoinType;
        if (functionSelector == ADDR_SELECTOR) {
            queryCoinType = COIN_SLIP44_ETH;
        } else if (functionSelector == ADDR_MULTICHAIN_SELECTOR) {
            (, queryCoinType) = abi.decode(_data[4:], (bytes32, uint256));
            if (multichainLayout) {
                if (!_isSupportedCoinType(queryCoinType)) {
                    revert UnsupportedCoinType(queryCoinType);
                }
            } else if (queryCoinType != ZKSYNC_MAINNET_COIN_TYPE) {
                revert UnsupportedCoinType(queryCoinType);
            }
        } else {
            revert UnsupportedSelector(functionSelector);
        }

        uint256 registryKey = multichainLayout
            ? getMultichainDomainSlot(sub, queryCoinType)
            : uint256(getDomainSlot(sub));

        revert OffchainLookup(
            address(this),
            urls,
            callData,
            ClaveResolver.resolveWithProof.selector,
            abi.encode(registry, registryKey, queryCoinType)
        );
    }

    function resolveWithProof(
        bytes memory _response,
        bytes memory _extraData
    ) external view returns (bytes memory) {
        (StorageProof memory proof, bytes32 fallbackValue) = abi.decode(
            _response,
            (StorageProof, bytes32)
        );
        (address account, uint256 key, uint256 coinType) = abi.decode(
            _extraData,
            (address, uint256, uint256)
        );

        if (validateProofs) {
            proof.account = account;
            proof.key = key;
        }

        bool verified = storageProofVerifier.verify(proof);

        if (verified && proof.value != bytes32(0)) {
            return _formatResolvedAddr(proof.value, coinType);
        }
        return _formatResolvedAddr(fallbackValue, coinType);
    }

    function supportsInterface(
        bytes4 interfaceID
    ) external pure returns (bool) {
        return
            interfaceID == INTERFACE_META_ID ||
            interfaceID == EXTENDED_INTERFACE_ID;
    }
}
