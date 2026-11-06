/**
 * The Hedera side: contract interfaces and how a warehouse-receipt token is configured in
 * Asset Tokenization Studio (ATS).
 */
import type { Address } from '../crypto';
import { type Thresholds, assetIdToBytes32, isinForLot } from '../lot';

export * from './generated';

/** ATS v8.0.0 on Hedera testnet (packages/ats/contracts/deployments/hedera-testnet in the ATS repo). */
export const ATS_HEDERA_TESTNET = {
  chainId: 296,
  factory: '0xd1F118A40f3b02883D35909eF2517e7EDd78379d',
  resolver: '0xBA2D5FC2083A0b8f164c50e65d782087fBA18E0a',
} as const;

/** The ATS configuration id of an equity token. */
export const ATS_EQUITY_CONFIG_ID = `0x${'00'.repeat(31)}01` as const;

/** ATS role identifiers (contracts/constants/roles.sol in ATS v8.0.0). */
export const ATS_ROLES = {
  DEFAULT_ADMIN: `0x${'00'.repeat(32)}`,
  AGENT: '0x9830aa071a741c08855dd42130bdb0ff50f7bdf5a4b72f12181eefded0c6542b',
  CONTROL_LIST: '0x6ed9a91e996c6475ecdc28ecbdbe9bd1122fc62b30cdbe6da8271884b51ec74d',
  DOCUMENTER: '0xb7b1452b94e2932605f7ad2a3ceba0bafd68db64704c9bd667f27163c57ca319',
  FREEZE_MANAGER: '0x71ae38482e1ab1c28e767d64766d686215b490c8c1bd7dfe6b101525187c2155',
  ISSUER: '0x5eeaf5602c75bf26e73b5206d0bd6ee82f621166255e5fd73cc06bc7bd84a95f',
  KYC: '0x754f499f9fdfbb089d12bdec817a6863d593d8a3ea7f546c00a5cafd20957bfc',
  PAUSER: '0x3cb8b459fdb6e7dc3d2a2aa529e530f885d45e03584adb438423209c86a2731f',
  SSI_MANAGER: '0x3120494a82251fe85b0403877539486dbfcf0f94c20741a3229cfad31f625ee1',
} as const;

export type ReceiptTokenParams = {
  assetId: string;
  /** ATS Business Logic Resolver and the equity configuration version to pin. */
  resolver: Address;
  configVersion: bigint;
  /** Holds every administrative role: admin, issuer, KYC, allowlist, pause, documents. */
  issuer: Address;
  /** The custody oracle: wired in as the compliance module and granted the freeze role. */
  oracle: Address;
  /** Units of the lot the receipt represents (the supply cap). */
  units: bigint;
  /** Declared value of one unit, in cents of `currency`. */
  unitValueCents: bigint;
  /** ISO 4217 code, three letters. */
  currency?: string;
};

/**
 * The arguments of the ATS Factory's `deployEquity` for a warehouse receipt.
 *
 * A warehouse receipt is modelled as an equity class whose only right is redemption: one unit
 * is a claim on one unit of the stored lot. Configuration choices:
 *  - `compliance` is the custody oracle (ERC-3643 compliance module): transferability follows
 *    the lot's custody state.
 *  - allowlist + internal KYC are on: only onboarded investors can hold units.
 *  - not controllable: nobody, the issuer included, can force-transfer a holder's units.
 *  - Regulation S, zero decimals (a unit is indivisible).
 */
export function receiptTokenArgs(params: ReceiptTokenParams) {
  const issuerOnly = [params.issuer] as const;
  const currency = params.currency ?? 'USD';
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('currency must be a three-letter ISO 4217 code');
  const currencyBytes3 = `0x${[...currency].map((c) => c.charCodeAt(0).toString(16)).join('')}` as `0x${string}`;
  const symbol = `WR${params.assetId.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`.slice(0, 11);

  const equityData = {
    security: {
      resolver: params.resolver,
      maxSupply: params.units,
      resolverProxyConfiguration: { key: ATS_EQUITY_CONFIG_ID, version: params.configVersion },
      erc20MetadataInfo: {
        name: `Warehouse Receipt ${params.assetId}`,
        symbol,
        isin: isinForLot(params.assetId),
        decimals: 0,
      },
      rbacs: [
        { role: ATS_ROLES.DEFAULT_ADMIN, members: issuerOnly },
        { role: ATS_ROLES.ISSUER, members: issuerOnly },
        { role: ATS_ROLES.KYC, members: issuerOnly },
        { role: ATS_ROLES.SSI_MANAGER, members: issuerOnly },
        { role: ATS_ROLES.CONTROL_LIST, members: issuerOnly },
        { role: ATS_ROLES.PAUSER, members: issuerOnly },
        { role: ATS_ROLES.DOCUMENTER, members: issuerOnly },
        { role: ATS_ROLES.FREEZE_MANAGER, members: [params.oracle] as const },
      ],
      externalPauses: [],
      externalControlLists: [],
      externalKycLists: [],
      compliance: params.oracle,
      identityRegistry: `0x${'00'.repeat(20)}`,
      arePartitionsProtected: false,
      isMultiPartition: false,
      isControllable: false,
      isWhiteList: true,
      clearingActive: false,
      internalKycActivated: true,
      erc20VotesActivated: false,
    },
    equityDetails: {
      votingRight: false,
      informationRight: false,
      liquidationRight: false,
      subscriptionRight: false,
      conversionRight: false,
      redemptionRight: true,
      putRight: false,
      dividendRight: 0, // NONE
      currency: currencyBytes3,
      nominalValue: params.unitValueCents,
      nominalValueDecimals: 2,
    },
  } as const;

  const regulationData = {
    regulationType: 1, // REG_S
    regulationSubType: 0, // NONE
    additionalSecurityData: { countriesControlListType: false, listOfCountries: '', info: '' },
  } as const;

  return [equityData, regulationData] as const;
}

/** The oracle's `LotConfig` for a lot. */
export function lotConfigArgs(input: {
  assetId: string;
  token: Address;
  device: Address;
  attestor: Address;
  inspector: Address;
  thresholds: Thresholds;
}) {
  return {
    lotId: assetIdToBytes32(input.assetId),
    token: input.token,
    device: input.device,
    attestor: input.attestor,
    inspector: input.inspector,
    tempMinCenti: input.thresholds.tempMinCenti,
    tempMaxCenti: input.thresholds.tempMaxCenti,
    rhMinCenti: input.thresholds.rhMinCenti,
    rhMaxCenti: input.thresholds.rhMaxCenti,
  } as const;
}
