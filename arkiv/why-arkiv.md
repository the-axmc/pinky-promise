# Why Arkiv

Pinky Promise turns sensor readings into something a stranger can check before buying a
warehouse receipt. Three properties of Arkiv carry that, and a conventional database gives none
of them.

## 1. The buyer can tell who wrote a reading — without trusting us

Every Arkiv entity records the wallet that created it, and nobody else can create an entity in
that wallet's name. Our Reading and Checkpoint entities are created by the **device's own
wallet**. So the buyer page does not ask "does the operator's database say the device reported
this?"; it asks Arkiv for the readings created by that device, and the chain answers.

With Postgres the operator holds the write key to every row. Signatures inside the rows would
still verify, but a buyer would have to trust the operator's API to return all of them. On Arkiv
the buyer queries the chain directly. And withholding shows: each custody record commits to the
readings it was judged on (how many, and a hash over them), so a reading that was signed but
never published leaves a gap the buyer page reports.

The device is a microcontroller behind a gateway, so how can it be the writer? The gateway
builds each transaction and the device signs it — after decoding it and checking that it
publishes exactly what the device measured, as read-only entities and nothing else. The gateway
never holds the device's key, and cannot get the device's signature on anything the device did
not measure.

## 2. The question a buyer actually has is one query

> All readings for lot #42 where `in_range = false`.

Indexed attributes make that a filter, combined with "created by this device":

```ts
reader.select().from(Readings)
  .where(and(eq('asset_id', 'LOT-42'), eq('in_range', false)))
  .createdBy(deviceAddress)
```

The same goes for "every handoff that was rejected", "the record for this 0G request id" and
"the proofs for this venue". We did not build an indexer; the data layer is the index.

## 3. Evidence expires when nobody can dispute it any more

Sensor data about a shipment is useful until the shipment is over and the dispute window has
closed. After that it is a liability. On Arkiv each entity is created with a lifetime: readings
live until the shipment's end plus the dispute window — all of a lot's readings expire at the
same moment — and custody records and proofs live one dispute window. Data minimisation is a
property of the write, not a cleanup job somebody has to remember to run.

## What goes on Arkiv and what does not

Arkiv holds what must be public and checkable: that a reading exists, who signed it, whether it
was within limits, a commitment to where it was taken, the decision about each handoff with its
0G request id, and the location proofs. It does not hold raw temperatures or positions. Those go,
encrypted, to 0G Storage, and Arkiv holds the pointer. The one exception is deliberate: when a
breach is confirmed, the single out-of-range reading that proves it is disclosed, because the
token freeze on Hedera depends on it.

## Where Arkiv did not fit as-is

Honestly listed in [`friction.md`](friction.md). The short version: no way to run a node locally
without Docker (we wrote a stand-in), a device cannot check what it is asked to sign without
re-implementing the transaction encoder, lifetimes are capped at about 182 days so "never
expires" means "renew it", and a few type and query-language gaps.
