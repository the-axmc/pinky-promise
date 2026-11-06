# How we use Arkiv

## In one paragraph

Arkiv is the system of record for evidence. Six entity types
([`schema.md`](schema.md)) are written by three wallets — a registry, each device, and the
gateway — through `@arkiv-network/sdk` 1.0. The buyer page reads them straight from the chain
and verifies what is inside. Nothing the product shows comes from a private database.

## Writes

| When | What is written | By |
| --- | --- | --- |
| A venue is registered | Venue: its public geofence and anchor address | registry |
| A device is enrolled | Device: the certificate binding its wallet to its secure element | registry |
| A lot is created | Lot: limits signed by the registry, the device, the Hedera token, the attestor | registry |
| The device takes readings | Reading entities, several per transaction | **the device's wallet** |
| A reading was taken inside a venue | GeoProof: a zero-knowledge proof of that, without the position | gateway |
| A handoff is recorded | Checkpoint (PENDING), then Checkpoint (decided) with the 0G request id and the episode root | **the device's wallet** |

Details that mattered:

- **Device-signed writes through a remote signer.** The SDK's wallet client is given a viem
  account whose `signTransaction` hands the transaction to the device and waits for its
  signature. The device reviews the calldata first (`packages/device/src/signing-policy.ts`):
  only read-only creates of its own readings and checkpoints get signed. The gateway checks the
  returned signature recovers to the device before broadcasting.
- **One transaction at a time per signer, with explicit nonce, gas and gas price**, as Arkiv
  recommends for Rabdi. Gas is computed from the number of operations and the payload size.
- **Lifetimes** are set per entity type at creation (`packages/protocol/src/arkiv/expiry.ts`).
- **Everything read-only.** There are no updates; a later record supersedes an earlier one by
  sharing its `checkpoint_id`.
- **Gas for devices.** The registry tops a device's wallet up when it runs low.

Code: `packages/gateway/src/arkiv/adapter.ts`.

## Reads — the user-facing feature

The buyer page (`packages/web`) is the feature that reads from Arkiv. For the chosen lot it runs
these queries from the browser and then checks every result:

| Query | Scoped to | Shown as |
| --- | --- | --- |
| Lots | created by the registry | the lot picker |
| Device, Venues | created by the registry | "why trust this record?" |
| Readings of the lot | created by the lot's device | the readings strip and table |
| Checkpoints of the lot | created by the lot's device | the custody timeline, with 0G request ids |
| GeoProofs of the lot | created by the lot's gateway | location proofs, verified in the browser |

The checks (`packages/web/src/lib/verify.ts`): each entity's creator is who it should be; the
device's signature over each reading and checkpoint; the registry's signature over the lot's
limits; the attestor's signature over each decision and that it names this checkpoint and this
0G request id; the disclosed out-of-range reading behind a breach; the venue anchor's
co-signature; and each proof's hash, circuit and — on request — the proof itself.

## One runnable query

```sh
pnpm arkiv:query --lot LOT-42 --out-of-range
```

prints the writer wallets and every out-of-range reading the lot's device wrote. It works
against any running gateway (`--gateway <url>`), local or testnet.

## Where it runs today

Be clear about this when judging: **the writes above have been exercised against a local
Arkiv-compatible node, not yet against Rabdi.** We had no funded testnet keys while building. The
local node (`packages/devnet/src/arkiv`) runs the unmodified SDK and was checked against Rabdi's
actual responses for the same requests; the adapter is the one that will talk to Rabdi, selected
by configuration. From this repository we reached Rabdi read-only (`pnpm doctor`).

### Before submitting — to be done by the team

- [ ] Fund the registry and gateway wallets on Rabdi and run `pnpm gateway` against it.
- [ ] Run a journey (`pnpm device run`, or the demo's device against the testnet gateway).
- [ ] Put the writer wallet addresses in the README (the query command prints them).
- [ ] Re-read [`friction.md`](friction.md): items marked *(emulator)* should be re-measured on
      Rabdi, and anything new added.
