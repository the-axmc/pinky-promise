# Pinky Promise — Onchain Sensor Oracle

A pocket device signs cold-chain readings with a hardware-rooted key. **0G decides** each custody
handoff from the seal photo and the readings, **Arkiv stores** the evidence as entities only the
device can write, and **Hedera tokenizes** the lot as an ATS warehouse receipt that freezes
itself when a breach is proven — and a buyer checks all of it in their own browser before buying.

Built for ETHGlobal Mumbai from [`docs/architecture-plan.md`](docs/architecture-plan.md).

## Status

| | |
| --- | --- |
| The whole flow on one machine | **Works.** Simulated device, local stand-ins for the three networks running the unmodified Arkiv SDK and the real ATS contract bytecode, more than 360 automated tests, and the buyer page exercised in a real browser. |
| Arkiv, Hedera and 0G testnets | **Not deployed yet.** The code paths exist and all three networks were reached read-only (`pnpm doctor`), but no transaction has been sent: that needs funded keys and a 0G API key. |
| Real 0G model | **Not exercised.** Local decisions come from a stand-in and are labelled `dev-mock` everywhere they appear. |
| Hardware | Host side **tested** against an in-memory board. Firmware **written but not yet compiled or run** on a board. See [`docs/hardware.md`](docs/hardware.md). |

[`docs/decisions.md`](docs/decisions.md) lists every gap in the plan and how it was filled.

## Try it

Needs Node 22+, pnpm 11 and [Foundry](https://getfoundry.sh) (`anvil` on the PATH).

```sh
pnpm install
pnpm demo --pause      # terminal 1: the whole stack, and a device walking a lot through its journey
pnpm web               # terminal 2: the buyer page, http://localhost:5173
```

The demo starts the three local networks and the gateway, registers two venues, enrols a
simulated device, issues the lot's receipt token and plays seven acts:

1. Origin warehouse — custody accepted, 100 units issued, 40 offered on the market.
   *(`--pause` stops here: buy some on the buyer page.)*
2. Leaving the warehouse — in transit, transfers restricted.
3. On the road — the cooling fails: one reading at 12.6 °C against a 2–8 °C limit.
4. Destination dock — 0G is unreachable. **Safe stop**: the handoff stays PENDING, no decision
   is made up, the token is not touched.
5. 0G answers — REJECT, plus the device-signed out-of-range reading: every unit is frozen.
   *(`--pause` stops here too: see the freeze on the buyer page.)*
6. Inspection — the inspector releases the lot.
7. Final delivery — accepted; holders can redeem.

On the page, each record shows whether it verified and why; "Use the demo key" decrypts the raw
temperatures and the seal photos; "Verify all in this browser" runs the zero-knowledge verifier.

## How it works

```
 device (ESP32-S3)                gateway                          the three layers
 ─────────────────                ───────                          ────────────────
 SHT31, GPS, camera      signed   verifies every packet            0G      vision model decides each handoff;
 ATECC608B root key  ──────────▶  proves location in ZK   ───────▶         episode log on 0G Storage
 wallet signs every     packets   asks 0G for the decision         Arkiv   readings, decisions, proofs —
 reading and handoff              relays, never decides                    written by the device's wallet
                                                                   Hedera  ATS receipt token, frozen and
          ▲                                                                released by a custody oracle
          └── venue anchor (second ESP32) co-signs a nonce at each handoff
                                                                   buyer page reads Arkiv + Hedera directly
```

- **Device.** Every reading is a 144-byte payload — device, lot, temperature, humidity, a
  commitment to the GPS position, time, a sequence number and a recent block hash — signed by the
  device wallet. An ATECC608B signs a certificate binding that wallet to the chip. At a handoff
  the device records the seal (photo, NFC tag, case switch), asks the venue anchor to co-sign,
  and signs a checkpoint over all readings since the last one.
- **Gateway.** Checks signatures and freshness, proves in zero knowledge that a reading was
  inside a venue, asks 0G for the custody decision, and relays to Arkiv and Hedera. It cannot
  write as the device: the device signs its own Arkiv transactions after checking what they say.
- **0G.** A vision model answers `ACCEPT_CUSTODY`, `REJECT` or `ESCALATE` with a reason. Each
  decision's request id goes on record, and the full episode — photo, raw readings, the model's
  answer, any failed attempts — goes encrypted to 0G Storage.
- **Arkiv.** Six entity types, all read-only, each trusted by who created it. Raw values are not
  there: only whether a reading was in range, and commitments. Evidence expires when the dispute
  window closes.
- **Hedera.** Each lot is an Asset Tokenization Studio security token. A custody oracle is its
  compliance module: units move only while a venue holds the goods, freeze on a proven breach,
  unfreeze on inspection, and redeem at delivery.

## Trust model

- **The zero-knowledge proof gives privacy, not authenticity.** It shows a device-signed reading
  was taken inside a venue's boundary without revealing where. A spoofed GPS proves just as well.
- **Authenticity of location comes from the venue anchor**: a second microcontroller at the venue
  that co-signs a fresh nonce, which the device can only obtain in its radio range. A handoff
  without an anchor is marked as resting on GPS alone.
- **The device is trusted to measure honestly.** Its key is rooted in a secure element and its
  case and seal are watched, but a sensor can be fooled physically.
- **The gateway is not trusted with data**: it cannot forge readings, cannot write as the
  device, and a reading it declines to publish shows as a gap.
- **The gateway's attestor key is trusted to relay 0G's answer.** Hedera cannot call 0G. That
  trust is bounded: the request id and the episode are on record, and a freeze additionally
  needs a device-signed out-of-range reading that the contract verifies itself — an attestor
  alone can neither freeze a lot nor wave a breach through.
- **A decision that did not come from 0G is never passed off as one.** No answer means PENDING.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm demo` | The whole system locally, with a scripted journey. `--pause`, `--interactive`, `--port <port>` for a real board, `--once` to exit at the end |
| `pnpm web` | The buyer page |
| `pnpm device probe --port <port>` | Check every part on a board (`--port mock` for an in-memory board) |
| `pnpm device run --gateway <url>` | Run a device against a gateway from the keyboard |
| `pnpm arkiv:query --lot LOT-42 --out-of-range` | One runnable Arkiv query; also prints the writer wallets |
| `pnpm doctor` | Read-only check of the configured networks, accounts and contracts |
| `pnpm deploy:hedera` | Deploy the custody oracle and the market |
| `pnpm gateway` | The gateway against the real networks |
| `pnpm test` · `pnpm typecheck` | All TypeScript tests · type checks |
| `cd contracts && forge test` | Solidity tests (clone with `--recurse-submodules`) |

## Going to the testnets

Nothing below has been run yet; it is the intended path.

```sh
cp .env.example .env     # fill in keys: each line says what the key signs and whether it needs funds
pnpm doctor              # everything reachable, funded and in place?
pnpm deploy:hedera       # prints HEDERA_ORACLE / HEDERA_MARKET and the HashScan verification commands
pnpm gateway
pnpm device enroll --gateway http://127.0.0.1:8787 --admin-token … --venues WH-MUM-01
pnpm device run    --gateway http://127.0.0.1:8787
VITE_GATEWAY_URL=http://127.0.0.1:8787 pnpm web
```

Venues and lots are created through the gateway's admin API (`POST /v1/admin/venues`,
`/v1/admin/lots`); `packages/gateway/src/demo.ts` shows the calls.

### Deployed addresses

*To fill in after deployment.*

| | Address |
| --- | --- |
| Arkiv writer — registry (Device, Venue, Lot) | — |
| Arkiv writer — device (Reading, Checkpoint) | — |
| Arkiv writer — gateway (GeoProof) | — |
| Hedera — CustodyOracle | — |
| Hedera — ReceiptMarket | — |
| Hedera — receipt token of the demo lot | — |

`pnpm arkiv:query` prints the three Arkiv writers for a running gateway.

## Hardware

[`docs/hardware.md`](docs/hardware.md) covers the parts (ESP32-S3, SHT31, GPS, camera,
ATECC608B, PN532, a second ESP32-S3 as anchor), wiring, flashing and a part-by-part bring-up.
Every part has a simulated twin, and a board's real parts are picked up automatically, so
hardware can be connected one piece at a time without changing code.

## Repository

| Path | What it is |
| --- | --- |
| `packages/protocol` | The signed wire formats and the custody state machine, shared by everything else |
| `packages/device` | Device logic, its simulator, the serial bridge to a real board, and the device CLI |
| `packages/zk` | The Noir geofence circuit, its prover and its browser-ready verifier |
| `packages/gateway` | The relay: verification, proofs, the 0G decision, Arkiv and Hedera; the demo |
| `packages/devnet` | Local stand-ins for the three networks |
| `packages/web` | The buyer page |
| `contracts` | `CustodyOracle` (drives the ATS token) and `ReceiptMarket`, with Foundry tests |
| `firmware/pinky-bridge` | ESP32-S3 firmware for the device and the venue anchor |
| `arkiv` | The Arkiv track write-ups: schema, why, how, friction, reach |
| `docs` | The plan, decisions, device protocol, hardware guide, demo script |

## Submission checklist

**Done** = built and verified here. **Built** = implemented and verified against the local
stand-in only; it still has to be run on the live network. **To do** = not started.

| Track | Requirement | Status |
| --- | --- | --- |
| 0G | 0G call in the decision loop | **Built** — the Compute Router client; decisions so far came from the stand-in |
| 0G | Episode log on 0G Storage with a request id per decision | **Built** — episodes go to a local folder until 0G Storage is configured |
| 0G | Live hardware demo, or replayable sim | **Done** as a sim (`pnpm demo`); hardware pending the boards |
| 0G | Safe stop when 0G is unreachable | **Done** — act 4 of the demo, and tests |
| 0G | Public repo, video under 3 minutes, contract addresses | **To do** — script in [`docs/demo-script.md`](docs/demo-script.md) |
| Arkiv | Writes to the current testnet | **Built** — run against a local Arkiv-compatible node only |
| Arkiv | A user-facing feature reads from Arkiv | **Done** — the buyer page (against the local node) |
| Arkiv | README: writer wallet addresses and one runnable query | Query **done** (`pnpm arkiv:query`); addresses **to do** after deployment |
| Arkiv | `/arkiv` write-ups | **Done** — [schema](arkiv/schema.md), [friction](arkiv/friction.md), [why](arkiv/why-arkiv.md), [how](arkiv/how-you-use-arkiv.md); [reach](arkiv/reach.md) has sections for the team to fill in |
| Arkiv | Open-source licence; AI use disclosed | **Done** — MIT; see below |
| Hedera | Issuance, configuration and a lifecycle operation on testnet | **Built** — all run against the real ATS contracts on a local chain |
| Hedera | Contracts verified on HashScan | **To do** — `pnpm deploy:hedera` prints the commands |
| Hedera | Video of 4 minutes or less | **To do** — script in [`docs/demo-script.md`](docs/demo-script.md) |

## AI use

This repository — code, tests, firmware and documentation — was written with an AI coding
assistant (Claude, by Anthropic) working from the team's architecture plan and under the team's
direction. Treat it accordingly: the status table above says what has actually been run.

## Licence

MIT — see [`LICENSE`](LICENSE).
