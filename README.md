# Pinky Promise — Onchain Sensor Oracle

A pocket device signs cold-chain readings with a hardware-rooted key. **0G decides** each custody
handoff, **Arkiv stores** the evidence as entities only the device can write, and **Hedera
tokenizes** the lot as an ATS warehouse receipt that freezes itself when a breach is confirmed.

> Work in progress — this README is filled in as each layer lands. The plan the project is built
> from is in [`docs/architecture-plan.md`](docs/architecture-plan.md); every place the
> implementation had to fill a gap is recorded in [`docs/decisions.md`](docs/decisions.md).

## Repository layout

| Path | What it is |
| --- | --- |
| `packages/protocol` | The signed wire formats (reading, checkpoint, device certificate, decision attestation) shared by every other part. |
| `packages/zk` | Noir geofence circuit plus the prover and verifier. |
| `packages/device` | Device core and simulator (stands in for the ESP32 until hardware is connected). |
| `packages/gateway` | The relay: verifies packets, proves location, talks to 0G, Arkiv and Hedera. |
| `packages/devnet` | Local stand-ins for the three networks so the whole flow runs offline. |
| `packages/web` | Buyer view. |
| `contracts` | Solidity: the custody oracle that drives the ATS token, and the receipt market. |
| `arkiv` | The Arkiv track write-ups (schema, friction, reach, why, how). |
| `docs` | Plan, decisions, device protocol for firmware. |

## License

MIT — see [`LICENSE`](LICENSE).
