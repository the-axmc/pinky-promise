# Demo script

Two videos are needed: under 3 minutes for 0G, 4 minutes or less for Hedera. Both come from the
same recording of one journey; the cuts differ in what they linger on. Nothing here has been
recorded yet.

## Setup before recording

```sh
pnpm demo --pause      # terminal, large font
pnpm web               # browser at http://localhost:5173, next to the terminal
```

`--pause` holds the journey at the two moments that need the browser: when the lot is in custody
(buy now) and when it is frozen. Press Enter in the terminal to move on.

With hardware on the desk, add `--port <port>` (and `--anchor-port <port>`); the terminal then
lists which parts are real. With a real camera, also set `ZG_ROUTER_URL`, `ZG_API_KEY` and
`ZG_MODEL` so a real model judges the photos — the stand-in cannot see.

If the recording is of the local stand-ins, **say so on screen**: the page already shows a banner
("stand-in decision model, not 0G"). For the submission videos, record against the testnets so
the request ids, HashScan links and Arkiv entities are real.

## The journey, shot by shot

| #   | Terminal                                                                                  | Browser                                                                                        | Say                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | Stack starts; the parts table (real vs simulated)                                         | —                                                                                              | A sensor device, a hardware-rooted key, three networks.                                                               |
| 2   | Act 1: two readings, `WAREHOUSE_IN`, **PENDING**, then ACCEPTED                           | Lot appears: _In custody_, 100 units issued                                                    | Every handoff is PENDING until a vision model on 0G has looked at the seal photo and the readings.                    |
| 3   | paused                                                                                    | Open "Why trust this record?"; open the handoff's decision record: 0G request id, episode root | Nothing here is taken on our word: the page reads Arkiv and Hedera and checks signatures itself.                      |
| 4   | paused                                                                                    | Buy 5 units                                                                                    | The receipt trades only while a venue holds the goods.                                                                |
| 5   | Enter. Acts 2–3: in transit; reading #7 at 12.6 °C                                        | Strip shows one ✕                                                                              | The cooling fails on the road. The public record says only _out of range_ — the value stays private.                  |
| 6   | Act 4: 0G unreachable → **PENDING**, "no decision was made up, the token was not touched" | Handoff shows PENDING                                                                          | Safe stop: if 0G cannot be asked, nothing is accepted and nothing is faked.                                           |
| 7   | Act 5: 0G answers → REJECT → **FROZEN**                                                   | Lot _Frozen_; "You hold 0 free · 5 frozen"; Buy is off; the disclosed 12.6 °C reading          | The token froze itself — on a REJECT _and_ a device-signed out-of-range reading the contract verified.                |
| 8   | Enter. Act 6: inspector releases                                                          | _In custody_ again, units free                                                                 | Only the inspector can release.                                                                                       |
| 9   | Act 7: final delivery                                                                     | _Delivered_; Redeem                                                                            | Delivered: holders redeem.                                                                                            |
| 10  | —                                                                                         | "Use the demo key": temperature chart, seal photos. "Verify all in this browser"               | The raw values live encrypted on 0G Storage. The location proofs verify here, without revealing where the device was. |

## 0G cut (under 3 minutes)

Keep shots 1, 2, 3 (decision record), 6, 7 and 10. The points to land, in order:

1. The decision is in the loop: no handoff is accepted without the model's answer (shot 2).
2. Each decision has a request id and an episode on 0G Storage that can be replayed (shots 3, 10).
3. Safe stop (shot 6) — give it the most time; it is the requirement most demos fake.
4. A physical body: the device, its sensor, its camera. With the boards on the desk, show the
   seal being cut and the next handoff being rejected.

## Hedera cut (4 minutes or less)

Keep shots 2, 4, 5, 7, 8 and 9. The points to land:

1. Issuance through Asset Tokenization Studio: one security token per lot, with an allowlist and
   KYC (show the token on HashScan).
2. Compliance: the purchase works only for an allow-listed buyer, and only while the lot is in
   custody — in transit the page says transfers are restricted and buying is off, because the
   token itself would refuse the transfer.
3. The lifecycle driven by the sensor: freeze on proven breach (shot 7), unfreeze after
   inspection (shot 8), redeem at delivery (shot 9). Show the oracle's transactions on HashScan.

## Things to have ready

- The contract addresses and the HashScan pages, open in tabs.
- The Arkiv query in a second terminal: `pnpm arkiv:query --lot LOT-42 --out-of-range`.
- For a hardware take: the seal tag on the PN532, something to warm the sensor (a hand is
  enough), and a seal to cut.
