// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAtsFactory, IAtsResolver} from "../../src/ats/IAtsFactory.sol";
import {IAtsToken, AtsRoles} from "../../src/ats/IAtsToken.sol";

/// @notice Deploys a warehouse-receipt equity token through the real ATS Factory, loaded from a
///         snapshot of Hedera testnet (`fixtures/ats-hedera-testnet.alloc.json`: the deployed
///         bytecode of the Factory, the Business Logic Resolver and all 108 facets plus their
///         storage). Tests therefore run the genuine ATS code with no network access.
///         Regenerate the snapshot with the `snapshot:ats` script of the devnet package.
abstract contract AtsFixture is Test {
    // Asset Tokenization Studio v8.0.0 on Hedera testnet
    // (packages/ats/contracts/deployments/hedera-testnet/newBlr-2026-06-12T11-19-42-198.json).
    address internal constant ATS_FACTORY = 0xd1F118A40f3b02883D35909eF2517e7EDd78379d;
    address internal constant ATS_RESOLVER = 0xBA2D5FC2083A0b8f164c50e65d782087fBA18E0a;
    bytes32 internal constant EQUITY_CONFIG_ID = bytes32(uint256(1));

    address internal issuer = makeAddr("issuer");

    /// @dev Hedera testnet chain id and a realistic clock (2026-11-06), then the ATS contracts.
    function _loadAts() internal {
        vm.chainId(296);
        vm.warp(1_793_966_400);
        vm.loadAllocs("fixtures/ats-hedera-testnet.alloc.json");
    }

    /// @param complianceModule ERC-3643 compliance contract wired into the token (the custody oracle).
    /// @param freezeManager    account granted ROLE_FREEZE_MANAGER (the custody oracle).
    function _deployReceiptToken(address complianceModule, address freezeManager)
        internal
        returns (IAtsToken token)
    {
        address[] memory issuerOnly = new address[](1);
        issuerOnly[0] = issuer;
        address[] memory freezers = new address[](1);
        freezers[0] = freezeManager;

        IAtsFactory.Rbac[] memory rbacs = new IAtsFactory.Rbac[](8);
        rbacs[0] = IAtsFactory.Rbac(AtsRoles.DEFAULT_ADMIN, issuerOnly);
        rbacs[1] = IAtsFactory.Rbac(AtsRoles.ISSUER, issuerOnly);
        rbacs[2] = IAtsFactory.Rbac(AtsRoles.KYC, issuerOnly);
        rbacs[3] = IAtsFactory.Rbac(AtsRoles.SSI_MANAGER, issuerOnly);
        rbacs[4] = IAtsFactory.Rbac(AtsRoles.CONTROL_LIST, issuerOnly);
        rbacs[5] = IAtsFactory.Rbac(AtsRoles.PAUSER, issuerOnly);
        rbacs[6] = IAtsFactory.Rbac(AtsRoles.DOCUMENTER, issuerOnly);
        rbacs[7] = IAtsFactory.Rbac(AtsRoles.FREEZE_MANAGER, freezers);

        IAtsFactory.SecurityData memory security;
        security.resolver = ATS_RESOLVER;
        security.maxSupply = 1_000_000;
        security.resolverProxyConfiguration = IAtsFactory.ResolverProxyConfiguration({
            key: EQUITY_CONFIG_ID,
            version: IAtsResolver(ATS_RESOLVER).getLatestVersionByConfiguration(EQUITY_CONFIG_ID)
        });
        security.erc20MetadataInfo = IAtsFactory.ERC20MetadataInfo({
            name: "Warehouse Receipt LOT-42", symbol: "WR42", isin: "US0378331005", decimals: 0
        });
        security.rbacs = rbacs;
        security.externalPauses = new address[](0);
        security.externalControlLists = new address[](0);
        security.externalKycLists = new address[](0);
        security.compliance = complianceModule;
        security.identityRegistry = address(0);
        security.arePartitionsProtected = false;
        security.isMultiPartition = false;
        security.isControllable = false;
        security.isWhiteList = true; // the control list is an allowlist
        security.clearingActive = false;
        security.internalKycActivated = true;
        security.erc20VotesActivated = false;

        IAtsFactory.EquityDetailsData memory details;
        details.redemptionRight = true; // the one right a warehouse receipt carries
        details.dividendRight = IAtsFactory.DividendType.NONE;
        details.currency = bytes3("USD");
        details.nominalValue = 1800; // 18.00 USD per unit
        details.nominalValueDecimals = 2;

        IAtsFactory.FactoryRegulationData memory regulation;
        regulation.regulationType = IAtsFactory.RegulationType.REG_S;
        regulation.regulationSubType = IAtsFactory.RegulationSubType.NONE;
        regulation.additionalSecurityData = IAtsFactory.AdditionalSecurityData({
            countriesControlListType: false, listOfCountries: "", info: ""
        });

        vm.prank(issuer);
        address deployed =
            IAtsFactory(ATS_FACTORY).deployEquity(IAtsFactory.EquityData(security, details), regulation);
        token = IAtsToken(deployed);
    }

    /// @dev Registers the issuer as its own KYC credential issuer, once per token.
    function _enableKycIssuer(IAtsToken token) internal {
        vm.prank(issuer);
        token.addIssuer(issuer);
    }

    /// @dev Allowlists and KYCs an investor.
    function _onboard(IAtsToken token, address investor) internal {
        vm.startPrank(issuer);
        token.addToControlList(investor);
        token.grantKyc(investor, "vc:demo", block.timestamp - 1, block.timestamp + 365 days, issuer);
        vm.stopPrank();
    }
}
