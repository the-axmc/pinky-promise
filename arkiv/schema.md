# Arkiv schema

Six entity types. The definitions are code — `packages/protocol/src/arkiv/schemas.ts` — and this
file explains them. All use SDK 1.0 typed schemas (`defineSchema`), and every entity is created
read-only.

## Who writes what

| Entity | Schema name | Created by | Lives until |
| --- | --- | --- | --- |
| Device | `pinky.device.v1` | registry wallet | the chain's maximum (~182 days); anyone may extend |
| Venue | `pinky.venue.v1` | registry wallet | the chain's maximum; anyone may extend |
| Lot | `pinky.lot.v1` | registry wallet | shipment end + dispute window |
| Reading | `pinky.reading.v1` | **the device's own wallet** | shipment end + dispute window |
| Checkpoint | `pinky.checkpoint.v1` | **the device's own wallet** | one dispute window after it is written |
| GeoProof | `pinky.geoproof.v1` | gateway wallet | one dispute window after it is written |

**Trust comes from the creator, never from the schema name** — anyone can write an entity with
the same name. A reader scopes Device, Venue and Lot to the registry address it trusts, Reading
and Checkpoint to the device the lot names, GeoProof to the gateway the lot names, and then
verifies the signatures inside. `packages/web/src/lib/verify.ts` is that reader.

## Fields

`●` = indexed, usable in a filter. Hashes are stored as lowercase hex strings so they can be
indexed (the SDK's `bytes` columns cannot be).

### Device — a sensor and its certificate

| Field | Type | | Meaning |
| --- | --- | --- | --- |
| `device_id` | address | ● | the device wallet |
| `hw_cert_hash` | string | ● | SHA-256 of the certificate bundle |
| `hw_cert` | bytes | | the certificate: wallet address, the secure element's P-256 key and serial, signed by both keys |
| `hw_serial` | string | ● | the secure element's serial number |
| `wallet_pubkey` | bytes | | the wallet's public key — a public input of geofence proofs |
| `venue_ids` | string | ● | venues the device is enrolled at, comma-separated |
| `label` | string | | |
| `registered_at` | u64 | ● | |

### Venue — a place where custody changes hands

| Field | Type | | Meaning |
| --- | --- | --- | --- |
| `venue_id` | string | ● | |
| `venue_hash` | string | ● | binds the id to the box below |
| `name` | string | | |
| `lat_min`, `lat_max`, `lon_min`, `lon_max` | u64 | | the public geofence, in shifted 1e-7 degrees |
| `anchor` | address | ● (optional) | the venue anchor's signing address |

### Lot — the physical thing, its limits, its token

| Field | Type | | Meaning |
| --- | --- | --- | --- |
| `asset_id` | string | ● | |
| `title` | string | | |
| `device_id` | address | ● | the device assigned to the lot |
| `temp_min_c`, `temp_max_c`, `rh_min_c`, `rh_max_c` | i32 | | limits, in hundredths |
| `profile` | bytes | | the same limits and device, signed by the registry — what the device itself checks |
| `hedera_chain_id` | i32 | ● | |
| `token` | address | ● | the receipt token on Hedera |
| `oracle`, `market` | address | | |
| `attestor` | address | ● | whose decision attestations count for this lot |
| `gateway` | address | ● | who publishes this lot's geofence proofs |
| `units`, `ends_at`, `dispute_window_s` | u64 | | |

### Reading — one measurement

Raw temperature and humidity are deliberately **not** here.

| Field | Type | | Meaning |
| --- | --- | --- | --- |
| `asset_id` | string | ● | |
| `device_id` | address | ● | |
| `seq` | u64 | ● | the device's counter |
| `ts` | u64 | ● | device time |
| `in_range` | bool | ● | the one fact made public |
| `venue_hash` | string | ● (optional) | set when the reading was taken inside a venue |
| `digest` | string | ● | SHA-256 of the signed payload |
| `sig` | bytes | | the device's signature over the digest |
| `gps_commitment` | string | | hides the position |
| `anchor_block`, `anchor_blockhash` | u64, string | | the Arkiv block the reading cannot predate |

### Checkpoint — a custody handoff and the decision about it

| Field | Type | | Meaning |
| --- | --- | --- | --- |
| `asset_id`, `device_id` | | ● | |
| `checkpoint_id` | string | ● | SHA-256 of the signed checkpoint; a PENDING record and the decided one share it |
| `kind` | string | ● | `WAREHOUSE_IN`, `WAREHOUSE_OUT`, `DOCK_HANDOFF`, `FINAL_DELIVERY` |
| `decision` | string | ● | what the model said: `PENDING`, `ACCEPT_CUSTODY`, `REJECT`, `ESCALATE` |
| `outcome` | string | ● | what it meant: `PENDING`, `ACCEPTED`, `REFUSED`, `FROZEN`, `ESCALATED`, `BLOCKED_BY_BREACH` |
| `breach` | bool | ● | a bundled reading was out of range |
| `zg_request_id` | string | ● (optional) | the 0G request id; absent while PENDING |
| `zg_model`, `zg_provider`, `zg_tee_verified` | | (optional) | |
| `zg_source` | string | ● | `0g-router`, `dev-mock` (the local stand-in) or `none` |
| `episode_root` | string | ● (optional) | 0G Storage root of the encrypted episode log |
| `reason` | string | | the model's reason |
| `seq`, `ts`, `decided_at` | u64 | ● | |
| `first_seq`, `last_seq` | u64 | | the readings the checkpoint covers |
| `venue_hash` | string | ● (optional) | |
| `payload`, `sig` | bytes | | the signed checkpoint |
| `attestation`, `attestor_sig` | bytes | | the decision attestation and its signature |
| `attestor` | address | ● | |
| `anchor_att` | bytes | (optional) | the venue anchor's co-signature |
| `breach_reading` | bytes | (optional) | the out-of-range reading that proves a breach, disclosed |

### GeoProof — a reading was taken inside a venue

| Field | Type | | Meaning |
| --- | --- | --- | --- |
| `asset_id`, `device_id`, `venue_id`, `venue_hash` | | ● | |
| `reading_digest` | string | ● | which reading |
| `seq`, `ts` | u64 | ● | |
| `proof_hash` | string | ● | SHA-256 of the proof |
| `circuit`, `vk_hash` | string | ● | which circuit the proof is for |
| `proof` | bytes | | the proof itself, about 8.8 kB |

## Queries the product uses

All in `packages/protocol/src/arkiv/queries.ts`, with the SDK's typed builder.

```ts
// Every out-of-range reading of a lot — only those its own device wrote.
reader.select().from(Readings)
  .where(and(eq('asset_id', 'LOT-42'), eq('in_range', false)))
  .createdBy(deviceAddress)
  .orderBy(asc('seq'))

// The custody records of a lot, newest first.
reader.select().from(Checkpoints)
  .where(eq('asset_id', 'LOT-42'))
  .createdBy(deviceAddress)
  .orderBy(desc('decided_at'))

// The lots a registry has published.
reader.select().from(Lots).createdBy(registryAddress)
```

Run the first one against a running gateway's Arkiv node:

```sh
pnpm arkiv:query --lot LOT-42 --out-of-range
```

## Design notes

- **Read-only, append-only.** Nothing is ever patched. A handoff that waits for 0G produces a
  PENDING record and later a decided one with the same `checkpoint_id`; readers take the latest.
- **Batches.** Readings are created several per transaction; a checkpoint is one.
- **The device signs its own transactions**, although a gateway builds them. Before signing it
  decodes the transaction and checks each entity against what it measured. See
  `packages/device/src/signing-policy.ts`.
- **Versioned names.** A breaking change becomes `…v2`; old entities stay readable until they
  expire.
