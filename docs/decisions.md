# Decisions

The [plan](architecture-plan.md) says what to build. This file records every place where it left
something open, or where the implementation does something different, and why. Read it before
changing any of these: most exist because two layers have to agree.

## Not verified yet

Stated first, because the rest of this file describes design, not proof.

| What                                        | Status                                                                                                                                                                                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The whole flow on one machine               | **Verified.** More than 360 automated tests, the scripted journey (`pnpm demo`), and the buyer page driven in a real browser. Arkiv and Hedera are local stand-ins running the unmodified Arkiv SDK and the real ATS contract bytecode.              |
| Writes to the Arkiv, Hedera and 0G testnets | **Not done.** No funded keys or 0G API key were available while building. `pnpm doctor` reached all three networks read-only; the adapters for them exist and are covered against the stand-ins. Expect first-run issues: fees, rate limits, timing. |
| Decisions by a real 0G vision model         | **Not done.** Local decisions come from a stand-in that recognises two pictures by hash. They are recorded as `dev-mock` on Arkiv and shown as "not 0G" on the buyer page.                                                                           |
| Firmware                                    | **Written, not compiled or run.** See [`hardware.md`](hardware.md).                                                                                                                                                                                  |
| Contracts verified on HashScan              | **Not done**: nothing is deployed. `pnpm deploy:hedera` prints the verification commands.                                                                                                                                                            |

## Layer 1 — device

**Payload encoding.** The plan lists the signed fields but not their encoding. They are
fixed-width big-endian binary with a magic prefix, hashed with SHA-256 and signed over the raw
digest. Reason: the same bytes must be parsed by firmware, by Solidity and inside a Noir circuit.
SHA-256 is hardware-accelerated on the ESP32, a precompile on the EVM and affordable in a
circuit; keccak fails the first and third. Layouts: [`device-protocol.md`](device-protocol.md).

**`blockhash` in the payload.** The plan does not say which chain's. It is a recent **Arkiv**
block: that is where the reading is published, the device reaches it through the gateway, and a
reader can check on the same chain that the reading cannot predate that block. The gateway
refuses readings whose anchor is too old.

**GPS commitment.** `SHA-256(lat ‖ lon ‖ 32-byte salt)` over shifted 1e-7-degree integers. The
salt is fresh per reading, so two readings at the same spot do not share a commitment. No fix is
a sentinel value with a salt, not a missing field. The opening goes to the gateway only and is
kept in memory until the proof is made.

**The certificate.** The ATECC608B signs a 105-byte certificate binding the wallet address to
its P-256 key and serial; the wallet countersigns. What the certificate cannot show is that the
P-256 key is in a genuine chip — that is what enrolment by the registry stands for. In
production the chip's Microchip certificate chain would be checked at that step; here it is not.

**Checkpoints bundle a window, not "the last N".** A checkpoint commits to every reading since
the previous checkpoint (first and last sequence number, count, and a hash over their digests).
"Last N" would let readings between checkpoints go unjudged.

**Seal evidence is more than a photo.** The plan has a photo. Because the parts list also has a
PN532 and a tamper switch, the evidence is a small record that can hold a photo hash, an NFC tag
read and the enclosure switch state, in any combination. The checkpoint commits to its hash.

**A reassigned device starts a new window.** When a device moves to another lot, readings taken
for the old lot are not bundled into the new lot's first checkpoint.

**Hardware: a tethered bridge first.** The plan has the ESP32 running the device logic and
talking BLE or WiFi to the gateway. What exists is the logic on the host and a firmware that
exposes each part over USB serial, so parts can be brought up one at a time and everything not
wired is simulated. The device ⇄ gateway hop is HTTP. Standalone firmware and BLE to the gateway
are the next step, not done.

## Layer 2 — gateway and location

**Geofence shape.** A latitude/longitude bounding box. A circle or polygon would cost far more
constraints for no gain in a demo. The venue's id and box are hashed together, so a proof for one
box cannot be presented as being for another venue of the same name.

**What the circuit proves.** That the reading's digest is the SHA-256 of a payload the device's
key signed, that the commitment inside that payload opens to a point, and that the point is
inside the box. Public inputs: the digest, the device's public key, the box. The verifier
rebuilds those from data it already trusts.

**Proof system.** Noir with UltraHonk (Barretenberg). Proofs are about 8.8 kB, take about two
seconds to make on the gateway, and verify in the buyer's browser.

**Proofs are not verified on-chain.** They are stored on Arkiv with their hash, and anyone
verifies them off-chain. Nothing on Hedera depends on location, so paying to verify 8.8 kB there
would buy nothing.

**Trust model, as the plan demands.** The proof gives privacy, not authenticity: a spoofed GPS
proves just as well. Authenticity is the venue anchor's co-signature. The buyer page says this
in those words next to the proofs, and marks a handoff with no anchor as resting on GPS alone.

**Anchor nonce.** The plan says "co-signs a nonce". The nonce is the same recent block hash the
checkpoint carries, which makes the attestation fresh without the anchor having a clock, plus
the anchor's own counter. The gateway accepts an attestation only from the anchor registered for
a venue the device is enrolled at.

**Anchor transport.** Over USB to the host by default; over BLE between the two boards as an
opt-in firmware build. Only the BLE path is evidence that the _device_ was near the anchor.

## Layer 3a — 0G

**The model call.** The 0G Compute Router's OpenAI-compatible chat endpoint, with the seal photo
as an image part and a summary of the readings as text. The model must answer with a decision
and a reason in JSON; anything else counts as no decision.

**Safe stop.** If 0G is unreachable, refuses, answers without a decision, or (in router mode)
answers through the stand-in, the checkpoint stays `PENDING`: no attestation is signed, nothing
is sent to Hedera, the device shows PENDING, and Arkiv gets a record that says PENDING and claims
no 0G request. The gateway retries with backoff. There is no fallback model and no default
answer.

**Who vouches for the decision on-chain.** The Hedera contract cannot call 0G. The gateway signs
a 110-byte attestation with an _attestor_ key: checkpoint, decision, breach flag, the hash of the
0G request id and the episode root. That is a trust assumption — the attestor relays 0G
honestly — and it is bounded two ways: the request id and the full episode are on record for
audit, and a freeze additionally needs evidence the attestor cannot forge (below). Asking the
Router to verify the provider's TEE signature is a configuration flag.

**Episode log.** One per decided checkpoint: the checkpoint, the seal record and photo, the raw
signed readings of the window, the summary sent to the model, the model's answer with the request
id, every failed attempt before it, and what the policy did. It is encrypted with a per-lot view
key and stored on 0G Storage; its root is in the Arkiv record and in the attestation. Anyone with
the view key can replay the episode and re-verify every signature in it.

**Stand-in for development.** A local server that speaks the Router's protocol and marks every
answer as a mock. It is used only when configured, never as a fallback, and a gateway in router
mode refuses its answers.

## Layer 3b — Arkiv

**"Only the device can write its readings."** Taken literally: Reading and Checkpoint entities
are created by the device's own wallet, so their `creator` is the device. The device cannot reach
Arkiv itself, so the gateway builds each transaction and the device signs it — but only after
decoding it and checking it publishes exactly what the device measured (the signing policy in
[`device-protocol.md`](device-protocol.md)). The gateway cannot use the device's signature to
publish anything else. The registry tops the device wallet up with gas.

**Trust by creator, not by schema.** Anyone can write an entity with the same schema name. A
reader scopes Device, Venue and Lot by the registry address it trusts, and Reading and Checkpoint
by the lot's device address, then verifies the signatures inside.

**Everything is read-only.** Records are never patched. A checkpoint that is first PENDING and
later decided is two records with the same checkpoint id; readers take the latest.

**Two more entity types than the plan.** Venue (the public geofence and the anchor's address) and
Lot (limits, the registry-signed profile, the token, the attestor) — a reader needs both to check
anything.

**Privacy.** As the plan says: `in_range` and commitments in the clear, raw values encrypted on
0G Storage with the pointer on Arkiv. One exception by design: a breach record discloses the one
out-of-range reading that proves it, because the freeze on Hedera needs that reading in the open.

**"Never expires".** Arkiv caps lifetimes at about 182 days, so Device and Venue get the maximum
and anyone may extend them. Readings expire at shipment end plus the dispute window, all at once;
checkpoints and proofs one dispute window after they are written.

## Layer 3c — Hedera

**Which ATS token.** ATS issues equities and bonds; there is no warehouse-receipt type. The
receipt is an equity with only the redemption right, zero decimals, an allowlist, internal KYC,
no controller, and a placeholder ISIN. Each lot gets its own token from the ATS factory.

**How the sensor drives the token.** A `CustodyOracle` contract is the token's ERC-3643
compliance module and holds its freeze-manager role. Every transfer asks it; it answers from the
lot's custody state. That gives the plan's transit restriction without touching ATS:
transfers and issuance only while a venue holds the goods, redemption then or after delivery,
nothing while in transit or frozen.

**What counts as a confirmed breach.** The plan: an out-of-range reading plus a 0G REJECT. On
chain that is two independent checks. The attestation must be signed by the lot's attestor and
say REJECT; and the caller must supply a reading signed by the lot's _device_ whose values are
outside the limits stored in the contract, which the contract verifies itself with the SHA-256
precompile and `ecrecover`. A compromised attestor cannot freeze a lot without a real
out-of-range reading, and an ACCEPT cannot wave a breach through: it is refused as
`BLOCKED_BY_BREACH`.

**Freezing.** In ATS, freezing an address means removing it from the allowlist, which would also
undo the holder's onboarding. The oracle instead freezes each holder's units
(`freezePartialTokens`) and unfreezes the same amounts on release. Holders are processed 50 at a
time with continuation calls, so a lot with many holders cannot run out of gas, and a call that
would otherwise skip a holder for lack of gas reverts instead.

**Unfreeze after inspection.** Only the lot's inspector can release, with a reference to the
inspection (a hash) and the sequence number it covers; later breaches are not pre-cleared.

**Buying.** The plan's "then buy the receipt" needs somewhere to buy. `ReceiptMarket` is a
minimal fixed-price listing where payment and units swap in one transaction, or neither moves. It
has no order book and no fee.

**One state machine, two implementations.** The custody rules exist in TypeScript (the gateway
previews an outcome before spending gas) and in Solidity (the contract enforces it). All 384
combinations are generated from the TypeScript and checked against the contract.

**HCS audit trail (optional in the plan).** Not built. The oracle keeps its own history on chain
(every applied checkpoint and release, with the request-id hash and episode root), which serves
the same purpose.

**x402 (the plan's "maybe later").** Not built.

## Layer 4 — buyer page

**It verifies rather than displays.** The page reads Arkiv and Hedera directly and checks each
record itself; the gateway only tells it where the networks are. See
[`packages/web/src/lib/verify.ts`](../packages/web/src/lib/verify.ts).

**Raw values need a key.** The public page shows whether each reading was in range. Temperatures
and seal photos appear only after decrypting the episode logs with the lot's view key, in the
browser. A demo gateway hands the key out; a real one would not.

**Wallets.** A browser wallet on real networks. On the local demo the page uses a funded
development account, so the demo needs no wallet setup.

## Running without the networks

**Local stand-ins.** To make the flow runnable with no accounts: Hedera is an anvil chain loaded
with a snapshot of the real ATS contracts from testnet (bytecode and storage), plus the project's
two contracts; Arkiv is a local node that emulates the chain's entity precompile and query
language closely enough for the unmodified SDK to run on it, checked against the real testnet's responses;
0G is the stand-in above and a folder for episode logs. What these do **not** reproduce: Hedera's
fees, its tinybar/wei units and its native services; Arkiv's real gas costs; anything about a
real model's judgement. Known differences are listed in `packages/devnet/src/arkiv/README.md`.

## Scope cuts that are already switches

The plan's order of cuts is available without code changes: no anchor (handoffs are simply
marked as GPS-only), a simulated secure element (the default until the chip is provisioned), and
`GEOFENCE_PROOFS=false` for the proofs. The end-to-end flow needs none of the three.

## Things chosen for you

- **Licence: MIT.** The plan asks for an open-source licence and names none.
- **Package manager and layout:** a pnpm workspace, TypeScript run from source, Foundry for
  Solidity.
- **Names:** lot `LOT-42`, venues `WH-MUM-01` and `DK-PNQ-02`, a 2–8 °C pharma pallet. All are
  demo data.
