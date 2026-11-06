# Onchain Sensor Oracle — Hackathon Architecture Plan

Nov 6, 2026 · @andrea

> This is the original plan the project is built from. Where the implementation
> had to fill a gap or deviate, the decision is recorded in
> [`docs/decisions.md`](./decisions.md).

## Track selection

We target three tracks, with each sponsor doing a job the system genuinely needs: 0G decides, Arkiv stores, Hedera tokenizes.

| Pick | Track | Prize pool | Why it fits |
| --- | --- | --- | --- |
| 1 | 0G – Physical AI: Agents with a Body | $5,000 | A real pocket device; one prize is reserved for the best build on real hardware, so fewer teams compete for it. |
| 2 | Arkiv – Build on Arkiv (from scratch) | $4,000 | Sensor readings map naturally onto entities owned by the device wallet, filterable and expiring. |
| 3 | Hedera – Tokenize Anything (ATS) | $5,000 | The tradability goal: a tokenized warehouse receipt whose compliance rules react to sensor data. The track lists warehouse receipts and freezes. |

Skipped, and why:

- **Whitechain Tokenize** overlaps with Hedera ATS; we can't do both well in one weekend.
- **Chainlink CRE** is only $1,500, and CCIP needs a genuine cross-chain need we don't have.
- **EF CROPS** has a strong privacy angle, but EF places a project in at most one of its tracks, and judges want a structural CROPS property in the demo.
- **Hedera x402** could be a cheap add-on later (sell verified readings per call). Don't plan around it.

## Architecture

The device signs, the gateway proves location privately, and the three sponsor layers each do one job before the buyer verifies and trades.

## Layer 1: Sensor device

The device signs every reading with a hardware-rooted key, so a number can't be typed in by a person.

- **Parts:** ESP32-S3 with camera (XIAO ESP32S3 Sense or ESP32-S3-EYE), SHT31, ATECC608B, GPS module (NEO-M8N or NEO-6M).
- **Two keys, one chain of trust:**
  - The ATECC608B holds the hardware root key (P-256, never extractable).
  - At boot, the ESP32 generates a secp256k1 device wallet. The ATECC signs a certificate binding that wallet address to the hardware key, once, at registration.
  - The device wallet signs every reading and owns its Arkiv entities directly.
- **Signed payload:** `{device, asset_id, temp, humidity, gps_commitment, ts, seq, blockhash}`. GPS goes in as a hash commitment, never in the clear.
- **Checkpoint events** happen at custody handoffs (warehouse in or out, truck to dock). The device photographs the tamper seal and bundles it with the last N readings.

## Layer 2: Gateway (phone or laptop)

The gateway proves location privately and relays everything to the three sponsor layers.

- Receives signed packets over BLE or WiFi.
- **ZK geofence proof:** a Noir circuit proves the device signature is valid over a GPS point inside venue X's geofence, without revealing the coordinates. Noir's std library has secp256k1 ECDSA verification.
- **What ZK buys:** privacy, not anti-spoofing. A GPS spoofer still produces valid proofs. Keep the BLE venue anchor (a second ESP32 that co-signs a nonce) as the authenticity layer, and state this trust model in the README.
- Relays to 0G, Arkiv and Hedera.

## Layer 3a: 0G, the decision layer (Physical AI track)

At each custody checkpoint, a 0G vision model decides whether to accept the handoff; signatures, not the AI, certify the readings.

- **Decision in the loop:** send the seal photo plus a reading summary to a 0G vision model (qwen vision). It returns `ACCEPT_CUSTODY / REJECT / ESCALATE` with a reason. This is a real decision, not logging, which the track requires.
- **Episode log:** each decision goes to 0G Storage with its request ID, so the full custody episode is replayable.
- **Safe stop:** if 0G is unreachable, the device shows `PENDING`, the handoff isn't accepted, and the token isn't touched. It never fakes an ACCEPT, which would disqualify.
- **Trust boundary:** the AI decides operational actions (accept a handoff, escalate). It never certifies that a temperature was real.
- Demo live at the 0G booth to compete for the real-hardware prize.

## Layer 3b: Arkiv, the data layer (Build on Arkiv track)

Readings live as Arkiv entities that only the device can write and that expire once nobody needs them.

| Entity | Owner | Queryable fields | Expires |
| --- | --- | --- | --- |
| Device | registry wallet | device\_id, hw\_cert, venue\_ids | never (long TTL) |
| Reading | device wallet | asset\_id, venue\_hash, ts, in\_range, seq | shipment end + dispute window |
| Checkpoint | device wallet | asset\_id, decision, 0g\_request\_id | dispute window |
| GeoProof | gateway | asset\_id, venue\_hash, proof\_hash | dispute window |

- **Why Arkiv** (25% of judging): only the device can write its readings, anyone can filter "all readings for lot #42 at venue Y where in\_range = false", and expiry is data minimization. Postgres can't give buyers write-proof ownership like that.
- **Privacy:** store `in_range` and commitments in the clear. Raw values go encrypted to 0G Storage, with Arkiv holding the pointer.

## Layer 3c: Hedera, the asset layer (Tokenize Anything track)

An ATS warehouse receipt token freezes automatically when the sensor layer confirms a breach.

- Issue a warehouse receipt security token with ATS for a physical lot (cold-chain pharma pallet or specialty coffee lot).
- **Lifecycle operations driven by the sensor:**
  - **Freeze** transfers when a breach is confirmed: an out-of-range reading plus a 0G `REJECT` at a checkpoint.
  - **Unfreeze** after inspection.
  - **Redeem** at final delivery.
- **Compliance controls** (bonus points): investor allowlist (KYC), transfer restrictions while a lot is in transit.
- Optionally log each freeze reason to an HCS topic as a tamper-evident audit trail.

## Layer 4: Buyer view

One web page: pick a lot, see its readings from Arkiv, the geofence proofs, the 0G checkpoint decisions with request IDs, and the token status on HashScan, then buy the receipt. That screen is the tradability story in one frame.

## Weekend build plan

Three people, five blocks of roughly six to eight hours, with the end-to-end flow working by hour 30.

| Hours | Hardware | Backend | Frontend |
| --- | --- | --- | --- |
| 0–6 | Flash ESP32, SHT31 + GPS readings, signing | Arkiv schema + writes from a mock device | Repo, README skeleton, buyer page shell |
| 6–14 | ATECC cert, BLE to gateway, camera capture | Noir geofence circuit + prover on gateway | Arkiv query views |
| 14–22 | Venue anchor ESP32 | 0G vision call + Storage log + safe stop | ATS token issuance on testnet |
| 22–30 | Enclosure, tamper switch | Freeze/unfreeze wired to checkpoint decisions | End-to-end demo flow |
| 30–36 | Live booth demo rehearsal | `/arkiv/*.md` files, 0G one-liner | Demo videos (≤3 min for 0G, ≤5 min for Hedera) |

## Submission checklist

**0G – Physical AI**

- [ ] 0G call in the decision loop
- [ ] Episode log on 0G Storage with a request ID per decision
- [ ] Live hardware demo (or replayable sim)
- [ ] Safe-stop fallback when 0G is unreachable
- [ ] Public repo, video under 3 minutes, contract addresses

**Arkiv – Build on Arkiv**

- [ ] Writes to the current testnet; a user-facing feature reads from Arkiv
- [ ] README: writer wallet address(es) and one runnable query
- [ ] `/arkiv/schema.md`, `friction.md`, `reach.md`, `why-arkiv.md`, `how-you-use-arkiv.md`
- [ ] Open-source license; disclose AI use

**Hedera – Tokenize Anything (ATS)**

- [ ] Issuance, configuration and at least one lifecycle operation (freeze) on testnet
- [ ] Contracts verified on HashScan
- [ ] Video of 5 minutes or less

## Scope risk

Three chains plus hardware is a lot for one weekend. If we fall behind, cut in this order: the venue anchor, then the ATECC certificate (a key in flash is enough for the demo), then the ZK proof. Never cut the end-to-end flow.
