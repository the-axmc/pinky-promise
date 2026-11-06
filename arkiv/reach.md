# Reach

Who this is for, how it would get to them, and where it stands. Nothing here is traction: the
project was built at a hackathon and has no users.

> **To the team:** the sections marked *to fill in* need facts only you have. Everything else is
> a draft from what the project does; change whatever does not match your intent.

## Who has the problem

A warehouse receipt is only as good as the buyer's confidence that the goods behind it were kept
properly. Today that confidence comes from paperwork and the reputation of whoever issued it.

- **Buyers and financiers of goods in storage or transit** — cold-chain pharmaceuticals,
  specialty coffee, anything where a few hours out of range ruins the lot. They want to check the
  conditions themselves before buying or lending against a receipt.
- **Warehouses and logistics operators** who want their receipts to trade at less of a discount,
  and who gain from a record they cannot be accused of editing.
- **Insurers and inspectors**, who need a dispute to be settled by evidence both sides accept.

## What they get that they cannot get today

- A reading that only the sensor could have written, queryable by anyone.
- A custody decision per handoff with a request id that can be traced and an episode that can be
  replayed.
- A token that freezes on proven evidence of a breach and unfreezes only on inspection.
- A page that checks all of it in the buyer's own browser.

## How it reaches them

*To fill in.* Open questions the team should answer before claiming a path to users:

- Which first customer: a single warehouse operator, a coffee importer, a pharma distributor?
- Who pays — the issuer of the receipt (to sell it at a better price) or the buyer?
- Is the device sold, leased, or bundled with the receipt issuance?
- Which jurisdiction's rules on warehouse receipts and security tokens apply? The token here is
  an ATS equity used as a receipt with a placeholder ISIN; a real one needs legal structuring.

## What exists

- The complete flow on one machine, with a simulated device: `pnpm demo`, then `pnpm web`.
- Firmware and wiring for the hardware, not yet run on a board
  ([`docs/hardware.md`](../docs/hardware.md)).
- No testnet deployment yet, no users, no pilots.

## What would come next

1. Hardware on the desk and a testnet deployment, so a stranger can be shown a real reading.
2. One pilot with one operator and one lot type.
3. The pieces a real deployment needs and a demo does not: flash encryption or a wallet key in
   the secure element, checking the secure element's manufacturer certificate at enrolment, a
   standalone device that talks to the gateway by itself, and legal structuring of the receipt.

## Team and contact

*To fill in:* who built this, and how to reach you.
