// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The slice of the Asset Tokenization Studio (ATS) Factory this project calls.
/// @dev Mirrors `IFactory` from the asset-tokenization-contracts npm package (hashgraph scope),
///      v8.0.0, the version deployed on Hedera testnet (Factory proxy
///      0xd1F118A40f3b02883D35909eF2517e7EDd78379d). Field order matters: these structs are
///      ABI-encoded and must match the deployed code.
interface IAtsFactory {
    enum DividendType {
        NONE,
        PREFERRED,
        COMMON
    }

    enum RegulationType {
        NONE,
        REG_S,
        REG_D
    }

    enum RegulationSubType {
        NONE,
        REG_D_506_B,
        REG_D_506_C
    }

    struct ResolverProxyConfiguration {
        bytes32 key;
        uint256 version;
    }

    struct ERC20MetadataInfo {
        string name;
        string symbol;
        string isin;
        uint8 decimals;
    }

    struct Rbac {
        bytes32 role;
        address[] members;
    }

    struct SecurityData {
        address resolver;
        uint256 maxSupply;
        ResolverProxyConfiguration resolverProxyConfiguration;
        ERC20MetadataInfo erc20MetadataInfo;
        Rbac[] rbacs;
        address[] externalPauses;
        address[] externalControlLists;
        address[] externalKycLists;
        address compliance;
        address identityRegistry;
        bool arePartitionsProtected;
        bool isMultiPartition;
        bool isControllable;
        bool isWhiteList;
        bool clearingActive;
        bool internalKycActivated;
        bool erc20VotesActivated;
    }

    struct EquityDetailsData {
        bool votingRight;
        bool informationRight;
        bool liquidationRight;
        bool subscriptionRight;
        bool conversionRight;
        bool redemptionRight;
        bool putRight;
        DividendType dividendRight;
        bytes3 currency;
        uint256 nominalValue;
        uint8 nominalValueDecimals;
    }

    struct EquityData {
        SecurityData security;
        EquityDetailsData equityDetails;
    }

    struct AdditionalSecurityData {
        bool countriesControlListType;
        string listOfCountries;
        string info;
    }

    struct FactoryRegulationData {
        RegulationType regulationType;
        RegulationSubType regulationSubType;
        AdditionalSecurityData additionalSecurityData;
    }

    event EquityDeployed(
        address indexed deployer,
        address equityAddress,
        EquityData equityData,
        FactoryRegulationData regulationData
    );

    function deployEquity(EquityData calldata equityData, FactoryRegulationData calldata regulationData)
        external
        returns (address equityAddress);
}

/// @notice The one Business Logic Resolver view needed to pin a configuration version.
interface IAtsResolver {
    function getLatestVersionByConfiguration(bytes32 configurationId) external view returns (uint256);
}
