// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The slice of an ATS security token (an EIP-2535 diamond) this project calls.
/// @dev Signatures are copied from the facet interfaces in the asset-tokenization-contracts npm
///      package (hashgraph scope), v8.0.0. The token exposes far more; only what the custody
///      oracle, the market, the deploy script and the tests use is declared here.
interface IAtsToken {
    // --- ERC-20 surface (CoreFacet, BalanceTrackerFacet, TransferFacet, AllowanceFacet) ---
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
    /// @dev The freely transferable balance: frozen, locked and held units are excluded.
    function balanceOf(address holder) external view returns (uint256);
    /// @dev Everything the holder owns, including frozen units.
    function getTotalBalanceFor(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);

    // --- Issuance and redemption (MintFacet, BurnFacet) ---
    function issue(address tokenHolder, uint256 value, bytes calldata data) external;
    function redeem(uint256 value, bytes calldata data) external;

    // --- ERC-3643 freeze (FreezeFacet, BatchFreezeFacet) ---
    // Token freeze: locks `amount` of a holder's balance. `isFrozen` is true while any are locked.
    function freezePartialTokens(address userAddress, uint256 amount) external;
    function unfreezePartialTokens(address userAddress, uint256 amount) external;
    function batchFreezePartialTokens(address[] calldata userAddresses, uint256[] calldata amounts) external;
    function batchUnfreezePartialTokens(address[] calldata userAddresses, uint256[] calldata amounts) external;
    function getFrozenTokens(address userAddress) external view returns (uint256);
    function isFrozen(address userAddress) external view returns (bool);
    // Address freeze: in ATS this removes the address from the allowlist (or adds it to the
    // blocklist) and does not change `isFrozen`.
    function setAddressFrozen(address userAddress, bool freezeStatus) external;
    function batchSetAddressFrozen(address[] calldata userAddresses, bool[] calldata freeze) external;

    // --- Pause (PauseFacet) ---
    function pause() external returns (bool);
    function unpause() external returns (bool);
    function paused() external view returns (bool);

    // --- Allowlist (ControlListFacet) ---
    function addToControlList(address account) external returns (bool);
    function removeFromControlList(address account) external returns (bool);
    function isInControlList(address account) external view returns (bool);
    function getControlListType() external view returns (bool);

    // --- KYC (KycFacet, SsiManagementFacet) ---
    function addIssuer(address issuer) external returns (bool);
    function isIssuer(address issuer) external view returns (bool);
    function grantKyc(address account, string memory vcId, uint256 validFrom, uint256 validTo, address issuer)
        external
        returns (bool);
    function revokeKyc(address account) external returns (bool);
    function getKycStatusFor(address account) external view returns (uint8);
    function isInternalKycActivated() external view returns (bool);

    // --- Holders (SecurityHoldersFacet) ---
    function getSecurityHolders(uint256 pageIndex, uint256 pageLength)
        external
        view
        returns (address[] memory);
    function getTotalSecurityHolders() external view returns (uint256);

    // --- Roles (AccessControlFacet) ---
    function grantRole(bytes32 role, address account) external returns (bool);
    function revokeRole(bytes32 role, address account) external returns (bool);
    function hasRole(bytes32 role, address account) external view returns (bool);

    // --- Documents (DocumentationFacet, ERC-1643) ---
    function setDocument(bytes32 name, string calldata uri, bytes32 documentHash) external;
    function getDocument(bytes32 name) external view returns (string memory, bytes32, uint256);

    // --- ERC-3643 wiring (IdentityFacet / ComplianceFacet) ---
    function compliance() external view returns (address);
}

/// @notice ATS role identifiers (`contracts/constants/roles.sol` in v8.0.0).
library AtsRoles {
    bytes32 internal constant DEFAULT_ADMIN = 0x00;
    bytes32 internal constant AGENT = 0x9830aa071a741c08855dd42130bdb0ff50f7bdf5a4b72f12181eefded0c6542b;
    bytes32 internal constant CONTROL_LIST =
        0x6ed9a91e996c6475ecdc28ecbdbe9bd1122fc62b30cdbe6da8271884b51ec74d;
    bytes32 internal constant DOCUMENTER = 0xb7b1452b94e2932605f7ad2a3ceba0bafd68db64704c9bd667f27163c57ca319;
    bytes32 internal constant FREEZE_MANAGER =
        0x71ae38482e1ab1c28e767d64766d686215b490c8c1bd7dfe6b101525187c2155;
    bytes32 internal constant ISSUER = 0x5eeaf5602c75bf26e73b5206d0bd6ee82f621166255e5fd73cc06bc7bd84a95f;
    bytes32 internal constant KYC = 0x754f499f9fdfbb089d12bdec817a6863d593d8a3ea7f546c00a5cafd20957bfc;
    bytes32 internal constant PAUSER = 0x3cb8b459fdb6e7dc3d2a2aa529e530f885d45e03584adb438423209c86a2731f;
    bytes32 internal constant SSI_MANAGER =
        0x3120494a82251fe85b0403877539486dbfcf0f94c20741a3229cfad31f625ee1;
}

/// @notice The ERC-3643 compliance module interface ATS calls on every balance change.
/// @dev `canTransfer` gates transfers, issuance (`from == 0`) and redemption (`to == 0`);
///      the other three are notifications after the fact and must not revert.
interface ICompliance {
    function canTransfer(address from, address to, uint256 amount) external view returns (bool);
    function transferred(address from, address to, uint256 amount) external;
    function created(address to, uint256 amount) external;
    function destroyed(address from, uint256 amount) external;
}
