# Device protocol

What a device signs, byte for byte, and what it says to a gateway. This is the contract a
firmware port has to meet; the reference implementation is `packages/protocol` (formats) and
`packages/device` (behaviour).

## Rules that hold everywhere

- **One hash: SHA-256.** An ESP32 computes it in hardware, the EVM has it as a precompile, and a
  Noir circuit can afford it — so the same digest is checked in firmware, on Hedera and inside
  the geofence proof.
- **Fixed-width binary payloads**, each starting with a 4-byte ASCII magic. Every integer is
  big-endian. There is no JSON, CBOR or ABI encoding to disagree about.
- **Signatures are over the raw 32-byte digest**, with no prefix.
  - secp256k1 (device wallet, venue anchor, gateway attestor, registry): 65 bytes `r ‖ s ‖ v`,
    `v` = 27 or 28, low `s` — exactly what `ecrecover` accepts.
  - P-256 (the ATECC608B root key): 64 bytes `r ‖ s`, `s` not normalised (the chip does not).
- **Identifiers** (lot id, venue id) are ASCII `A-Z a-z 0-9 . _ -`, at most 32 characters,
  zero-padded on the right to 32 bytes.
- **Units**: temperature in hundredths of °C (signed), relative humidity in hundredths of a
  percent, time in unix seconds.

## PPR1 — reading (144 bytes)

| Offset | Length | Field          | Notes                                                       |
| ------ | ------ | -------------- | ----------------------------------------------------------- |
| 0      | 4      | magic          | `PPR1`                                                      |
| 4      | 20     | device         | the device wallet's address                                 |
| 24     | 32     | asset_id       | the lot                                                     |
| 56     | 4      | temp_centi     | int32                                                       |
| 60     | 4      | rh_centi       | uint32                                                      |
| 64     | 32     | gps_commitment | see below                                                   |
| 96     | 8      | ts             | uint64                                                      |
| 104    | 8      | seq            | uint64, never reused                                        |
| 112    | 32     | blockhash      | hash of a recent Arkiv block: the reading cannot predate it |

`digest = SHA-256(payload)`; the device signs the digest.

### GPS commitment

The position never appears in the clear.

```
lat_units = round(lat° × 10^7) + 900_000_000        (uint32)
lon_units = round(lon° × 10^7) + 1_800_000_000      (uint32)
commitment = SHA-256(lat_units ‖ lon_units ‖ salt)   salt: 32 fresh random bytes per reading
```

Without a fix, both units are `0xFFFFFFFF`, still with a random salt, so "no fix" readings are
not linkable either. The device sends the opening (`lat_units`, `lon_units`, `salt`) to the
gateway only, alongside the reading; the gateway uses it to make the geofence proof and then
drops it.

A venue's geofence is a box in the same units, bound to its id:
`venue_hash = SHA-256("PPV1" ‖ venue_id ‖ lat_min ‖ lat_max ‖ lon_min ‖ lon_max)`.

## PPC1 — checkpoint (221 bytes)

Taken at a custody handoff. It commits to the readings since the previous checkpoint, to the
seal evidence and to the venue anchor's co-signature.

| Offset | Length | Field         | Notes                                                                |
| ------ | ------ | ------------- | -------------------------------------------------------------------- |
| 0      | 4      | magic         | `PPC1`                                                               |
| 4      | 20     | device        |                                                                      |
| 24     | 32     | asset_id      |                                                                      |
| 56     | 1      | kind          | 1 WAREHOUSE_IN · 2 WAREHOUSE_OUT · 3 DOCK_HANDOFF · 4 FINAL_DELIVERY |
| 57     | 8      | ts            |                                                                      |
| 65     | 8      | seq           | shares the reading counter                                           |
| 73     | 8      | first_seq     | first reading in the window                                          |
| 81     | 8      | last_seq      | last reading in the window                                           |
| 89     | 4      | reading_count | uint32                                                               |
| 93     | 32     | readings_root | SHA-256 of the window's reading digests, concatenated in order       |
| 125    | 32     | seal_hash     | SHA-256 of the seal evidence record, as sent                         |
| 157    | 32     | anchor_digest | SHA-256 of the PPA1 payload, or 32 zero bytes without an anchor      |
| 189    | 32     | blockhash     | recent Arkiv block, also the anchor's nonce                          |

The checkpoint id is `SHA-256(payload)`.

### Seal evidence

A small UTF-8 JSON record, because what a device can observe depends on its hardware. Any mix of
the three, at least one:

```json
{
  "v": 1,
  "photo": { "sha256": "0x…", "mime": "image/jpeg", "source": "device-camera" },
  "nfc": { "uid": "0x04a1b2c3d4e5f6", "tagType": "iso14443a", "tamper": "unknown" },
  "enclosure": { "closed": true, "openCount": 0 }
}
```

`seal_hash` is the hash of the exact bytes sent, so there is no canonical form to agree on. The
photo travels next to the record and must hash to `photo.sha256`. `source` is one of
`device-camera`, `gateway-camera`, `file`, `simulated`. An NFC `tamper` of `open`, or
`enclosure.closed: false`, is hardware-reported tampering.

## PPA1 — venue anchor attestation (96 bytes)

| Offset | Length | Field                                                      |
| ------ | ------ | ---------------------------------------------------------- |
| 0      | 4      | magic `PPA1`                                               |
| 4      | 32     | venue_id                                                   |
| 36     | 20     | device — the wallet that asked                             |
| 56     | 32     | blockhash — the nonce, the same one the checkpoint carries |
| 88     | 8      | counter — the anchor's own, never reused                   |

Signed by the anchor's secp256k1 key over `SHA-256(payload)`. Using a recent block hash as the
nonce makes the attestation fresh without the anchor needing a clock.

## PPD1 — device certificate (105 bytes, signed twice)

| Offset | Length | Field                                          |
| ------ | ------ | ---------------------------------------------- |
| 0      | 4      | magic `PPD1`                                   |
| 4      | 20     | device — wallet address                        |
| 24     | 64     | hw_pubkey — the ATECC608B's P-256 key, `x ‖ y` |
| 88     | 9      | hw_serial — the chip's serial number           |
| 97     | 8      | issued_at                                      |

Bundle on the wire: `payload ‖ hw_sig (64) ‖ wallet_sig (65)` = 234 bytes. The chip signs once,
at enrolment: "this chip vouches for this wallet". The wallet countersigns the same digest.

## PPL1 — lot profile (80 bytes, signed by the registry)

| Offset | Length | Field                  |
| ------ | ------ | ---------------------- |
| 0      | 4      | magic `PPL1`           |
| 4      | 32     | asset_id               |
| 36     | 20     | device                 |
| 56     | 4      | temp_min_centi (int32) |
| 60     | 4      | temp_max_centi (int32) |
| 64     | 4      | rh_min_centi (uint32)  |
| 68     | 4      | rh_max_centi (uint32)  |
| 72     | 8      | valid_until            |

The device adopts a profile only if the registry it was provisioned with signed it, it names
this device and it has not expired. A gateway cannot widen the limits.

## PPX1 — decision attestation (110 bytes, signed by the gateway's attestor key)

Not produced by the device, but the device checks it before publishing a decision under its own
name.

| Offset | Length | Field                                                           |
| ------ | ------ | --------------------------------------------------------------- |
| 0      | 4      | magic `PPX1`                                                    |
| 4      | 32     | checkpoint_digest                                               |
| 36     | 1      | decision — 0 PENDING · 1 ACCEPT_CUSTODY · 2 REJECT · 3 ESCALATE |
| 37     | 1      | breach — 1 if a bundled reading was out of range                |
| 38     | 32     | request_id_hash — SHA-256 of the 0G request id                  |
| 70     | 32     | episode_root — 0G Storage root of the episode log               |
| 102    | 8      | decided_at                                                      |

## Device ⇄ gateway

The device always initiates. JSON over HTTP today; binary fields are `0x` hex.

| Call                                      | Purpose                                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/device/context?device=0x…`       | a fresh anchor block, and the lot profile once assigned                                                                                    |
| `POST /v1/device/readings`                | `{ payload, sig, opening? }`                                                                                                               |
| `POST /v1/device/checkpoints`             | `{ payload, sig, seal, photo?, anchor? }` — answers 409 with `missing: [seq…]` if it lacks readings of the window; the device resends them |
| `GET /v1/device/checkpoints/:id?device=…` | `PENDING` until a decision exists                                                                                                          |
| `GET /v1/device/sign-requests?device=…`   | Arkiv transactions waiting for the device's signature                                                                                      |
| `POST /v1/device/signatures?device=…`     | signatures, or refusals with a reason                                                                                                      |

`PENDING` means not accepted. A device shows it as such and never treats it as a yes.

## Four behaviours a firmware port must keep

1. **Never reuse a sequence number.** Persist the counter before signing with it. A crash may
   skip a number; it must not repeat one.
2. **Sign exactly these layouts.** The vectors below are the test.
3. **Trust limits only from a registry-signed profile** for this device.
4. **Sign an Arkiv transaction only after reading it.** The device wallet owns its Reading and
   Checkpoint entities, so it signs the transactions that create them, but the gateway builds
   them. Before signing, the device decodes the transaction and refuses unless it is a legacy
   transaction to the Arkiv engine on the expected chain, carries no value and a capped fee,
   contains only read-only Create operations, and every Reading matches one of its own readings
   field for field and every Checkpoint carries its own checkpoint with an attestation from the
   configured attestor that is honest about breaches as far as the device's own readings show.
   See `packages/device/src/signing-policy.ts`.

## Test vectors

[`contracts/vectors/protocol-v1.json`](../contracts/vectors/protocol-v1.json) holds, for fixed
published test keys: five readings (in range, exactly on the lower bounds, too warm, too cold with a negative temperature, too humid), a
GPS commitment and venue hash, an anchor attestation, a seal record, a checkpoint, a decision
attestation, a lot profile, a certificate bundle, and all 384 rows of the custody state machine.
The TypeScript implementation generates the file and the Solidity tests
(`contracts/test/ProtocolVectors.t.sol`) decode and verify the same bytes, so the two already
agree. A firmware implementation is correct when it reproduces the payloads and digests and its
signatures verify.

## The serial bridge

Until the device logic runs on the ESP32, the `pinky-bridge` firmware exposes the parts over USB
serial and the host does the rest. That protocol — JSON lines, one command per part — is in
`packages/device/src/bridge/protocol.ts`, with a complete working reference in
`packages/device/src/bridge/mock-board.ts`. See [`hardware.md`](hardware.md).
