# Showing it to judges

A runbook for the booth and the judging calls. Three ways to run the same journey, from the one
that works today with nothing to set up, to the one the Arkiv and Hedera prizes require.

| Way                                | What is real                                                                                             | Needs                                       | Status                                                                                                            |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **A. Local**                       | the whole flow, with stand-ins for the three networks (unmodified Arkiv SDK, real ATS contract bytecode) | nothing                                     | verified many times                                                                                               |
| **B. Real 0G model, local chains** | the decisions and their request ids                                                                      | a 0G API key                                | code path verified against the stand-in only                                                                      |
| **C. Testnets**                    | everything: Arkiv Rabdi, Hedera testnet, 0G Router and Storage                                           | funded keys, a 0G API key, ~1 hour of setup | rehearsed end to end against the stand-ins through the same configuration; **never yet run on the live networks** |

Whatever you show, say which one it is. The page says it too: a banner appears whenever the
decisions come from a stand-in.

## 0. The day before

```sh
git clone --recurse-submodules <repo>  && cd pinky-promise
pnpm install                      # Node 22+, pnpm 11; anvil from Foundry must be on the PATH
pnpm demo --once                  # ~30 s; ends with: checkpoints: ACCEPTED, ACCEPTED, FROZEN, ACCEPTED
```

If `pnpm demo --once` passes, the machine is ready for A and B. Also:

- Run through section A once with your hands on the keys, so the pacing is yours.
- Put the terminal font at 16 pt or more and the browser next to it. Dark or light theme both work.
- If anything was killed hard and a later start complains about a port: `pkill anvil`.
- Have the repo open at [`README.md`](../README.md) and [`decisions.md`](decisions.md) for
  questions.

## A. Local showcase (10 minutes)

Three terminals in the repository root.

```sh
# terminal 1 — the system, with you on the keys
pnpm demo --interactive

# terminal 2 — the buyer page
pnpm web                      # then open http://localhost:5173

# terminal 3 — kept for the Arkiv query (section A.3)
```

Terminal 1 starts the three stand-ins and the gateway (about 15 s), registers two venues, enrols
the device, creates the lot and its receipt token, and then shows the keys:

```
r reading   1 warehouse in   2 warehouse out   3 dock handoff   4 final delivery   q quit
+ / - temperature   b break/mend the seal   g GPS fix on/off
v move on (origin → road → dock)   o cut 0G off / back   i inspector release   m list units   s show lot
```

After every handoff it prints the lot's state on Hedera and **what to press next**. If you press a
key that makes no sense in the current state, the gateway refuses it, nothing is decided, and the
device keeps the readings for the next handoff — so a slip costs nothing.

### A.1 The journey, with what to say

| Press                      | What happens                                                                                                                                                                                   | Say                                                                                                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `1`                        | Reading, then `WAREHOUSE_IN` — **PENDING** for a second, then `ACCEPTED`. "Hedera: lot is IN_CUSTODY; depositor holds 100 free".                                                               | _Every handoff is pending until the vision model has looked at the seal photo and the readings. Only then is custody accepted and the receipt issued._                                                |
| `m`                        | 40 units listed on the market.                                                                                                                                                                 | _The receipt trades only while a venue holds the goods._                                                                                                                                              |
| browser                    | Lot shows **In custody**. Open _Why trust this record?_ Open the handoff's _Decision record_: request id, episode root, the checks. Click **Buy for 0.1 HBAR**.                                | _Nothing on this page is taken from us: the browser reads Arkiv and Hedera directly and recomputes every signature. The demo wallet buys 5 units._                                                    |
| `2`                        | `WAREHOUSE_OUT` → `ACCEPTED`, lot **In transit**.                                                                                                                                              | _In transit, transfers are restricted — the token's own compliance module refuses them._                                                                                                              |
| `v`, then `+` ×7, then `r` | At the road. Temperature climbs to 8.5 °C; reading flagged. Browser strip shows a ✕.                                                                                                           | _The cooling fails. The public record says only "out of range" — the value itself stays private._                                                                                                     |
| `v`, `o`, `3`              | At the dock, 0G cut off, `DOCK_HANDOFF` sent: **PENDING**, and after 5 s: _still PENDING — no decision yet (0G is unreachable)_. Press `s`: lot still IN_TRANSIT, 100 free.                    | _Safe stop. If 0G cannot be asked, nothing is accepted, nothing is invented, the token is not touched. The device shows PENDING._                                                                     |
| `o`                        | 0G back → `FROZEN (REJECT)`: "1 reading(s) were outside the allowed range". "Hedera: lot is FROZEN (breach open); depositor holds 0 free, 100 frozen".                                         | _The model rejects, and the contract verifies the device-signed out-of-range reading itself before freezing every holder's units. An operator alone cannot freeze, and cannot wave a breach through._ |
| browser                    | Lot **Frozen**; the dock handoff shows the disclosed 12.6 °C reading; _You hold 0 free · 5 frozen_; Buy is off.                                                                                | _The buyer's units are frozen too._                                                                                                                                                                   |
| `i`                        | Inspector releases → IN_CUSTODY, units free.                                                                                                                                                   | _Only the lot's inspector can release, with a reference to the inspection._                                                                                                                           |
| `-` ×7, then `4`           | Temperature back in range, `FINAL_DELIVERY` → `ACCEPTED`, lot **Delivered**.                                                                                                                   | _Delivered: holders redeem._                                                                                                                                                                          |
| browser                    | Click **Use the demo key**: temperature chart against the band, four seal photos. Click **Verify all in this browser**: every location proof turns to "proof verifies". **Redeem my 5 units.** | _Raw values live encrypted on 0G Storage; the view key decrypts them here. The proofs show each reading was inside the venue without revealing where._                                                |
| `q`                        | Stops everything.                                                                                                                                                                              |                                                                                                                                                                                                       |

Extra beats if there is time: `b` breaks the seal before a handoff — the model rejects without a
breach, custody is refused, the token is untouched. `g` drops the GPS fix — the next readings
carry no location proof.

### A.2 The scripted version (no keys to press)

```sh
pnpm demo --pause         # plays all seven acts; stops twice: in custody (buy now), frozen (look)
```

Press Enter in the terminal to move on from each stop. Good for a recording; `--once` exits at
the end instead of staying up.

### A.3 The Arkiv query (terminal 3, while the stack is up)

```sh
pnpm arkiv:query --lot LOT-42 --out-of-range
```

Prints the three writer wallets (registry, device, gateway) and every out-of-range reading the
lot's device wrote — the plan's "all readings for lot #42 where in_range = false" — straight from
the Arkiv node. Without `--out-of-range` it lists all seven.

## B. Real 0G decisions, local chains

The only thing missing from A for the 0G track is that the decisions come from a stand-in. With a
0G Compute API key the same demo asks the real Router, while Arkiv and Hedera stay local:

```sh
ZG_API_KEY=<key> pnpm doctor   # with ZG_MODEL unset it lists the models that accept images
ZG_ROUTER_URL=https://router-api.0g.ai/v1 ZG_API_KEY=<key> ZG_MODEL=qwen2.5-vl-72b-instruct \
  pnpm demo --interactive
```

Then the decision records on the page carry real 0G request ids, and the seal photos are judged
by a real vision model. Two differences: the `o` key does not work in this mode (the outage can
only be rehearsed with the stand-in, or in C where the route to 0G is cut), and each decision
takes a few seconds longer.

Not yet exercised against the live Router from this repository: expect to check the model name
and the response format on the first try (`pnpm doctor` does the first part).

## C. Testnets

What the Arkiv ("writes to the current testnet") and Hedera ("issuance and a lifecycle operation
on testnet, contracts verified") tracks require, and what makes the 0G request ids and episode
logs real. Budget an hour the first time. **Nothing below has been run against the live networks
yet**; the same commands have been rehearsed end to end against the stand-ins (section C.4), so
what remains unknown is network behaviour: fees, rate limits, timing.

### C.1 Accounts and funds

Make keys with Foundry: `cast wallet new` prints an address and a private key; run it once per
row. Keep the output in a password manager, not in a chat.

| `.env` variable        | Network    | Needs funds?                                                        | Where                                                                                            |
| ---------------------- | ---------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `REGISTRY_KEY`         | Arkiv      | yes — it writes entities and tops up device wallets                 | the faucet linked from the Arkiv docs / hub                                                      |
| `GATEWAY_KEY`          | Arkiv      | yes — it writes proofs                                              | same                                                                                             |
| `ATTESTOR_KEY`         | —          | no                                                                  | —                                                                                                |
| `HEDERA_ISSUER_KEY`    | Hedera     | yes — deploys the contracts and each lot's token (the largest cost) | [portal.hedera.com](https://portal.hedera.com) testnet account; its faucet gives test HBAR daily |
| `HEDERA_RELAYER_KEY`   | Hedera     | yes — submits checkpoints                                           | same                                                                                             |
| `HEDERA_INSPECTOR_KEY` | Hedera     | yes — releases                                                      | same                                                                                             |
| `ZG_API_KEY`           | 0G Compute | yes — pays per decision                                             | the 0G Compute Router's console / docs (the model catalogue is at pc.0g.ai/models)               |
| `ZG_STORAGE_KEY`       | 0G chain   | yes — pays storage fees                                             | the 0G testnet faucet                                                                            |
| `DEMO_DEPOSITOR_KEY`   | Hedera     | a little                                                            | optional; empty = the issuer                                                                     |
| `DEMO_BUYER_ADDRESS`   | Hedera     | the wallet that will buy needs HBAR                                 | your MetaMask address                                                                            |
| `ARKIV_ACCESS_KEY`     | —          | no                                                                  | hub.arkiv.network/access-keys (the public endpoint is rate-limited)                              |

Hedera accounts must be **ECDSA** (secp256k1), which is what `cast wallet new` makes. Create the
account in the portal with that key, or send HBAR to the key's EVM address from a portal account.

Expect each `--live` run to spend a few test HBAR (a token deployment is about 6.7 million gas)
plus small amounts on Arkiv and 0G. The exact figures are unknown until the first run.

### C.2 Configure and check

```sh
cp .env.example .env         # every line is explained in the file
pnpm doctor                  # reads only; repeat until it ends with "Ready."
```

Partial setups are fine for a while:

- no 0G Storage funds yet → `ZG_STORAGE=local` (episode logs stay on the machine; the doctor says so);
- `ZG_MODE=mock` exists for rehearsals only — never for a run you show as 0G.

Set `GATEWAY_DEMO=true` so the buyer page can allow-list a visitor's wallet and hand out the view
key; set `ADMIN_TOKEN` to a long random string.

### C.3 Deploy the two contracts, once

```sh
pnpm deploy:hedera           # CustodyOracle and ReceiptMarket, with the issuer key
```

Paste the two addresses it prints into `.env` (`HEDERA_ORACLE`, `HEDERA_MARKET`), then run the
two `forge verify-contract` commands it also prints, from the `contracts/` folder: that is the
"verified on HashScan" requirement. Run `pnpm doctor` again.

### C.4 Rehearse the exact commands first

```sh
pnpm devnets                                     # terminal 1: stand-ins only; writes .env.rehearsal
ENV_FILE=.env.rehearsal pnpm doctor              # terminal 2
ENV_FILE=.env.rehearsal pnpm demo --live --pause # terminal 2: the same command as the real run
pnpm web                                         # terminal 3, if you want the page too
```

Same configuration path, same adapters, same command; only the endpoints differ. Stop terminal 1
with Ctrl-C when done.

### C.5 The real run

```sh
pnpm demo --live --pause          # terminal 1
pnpm web                          # terminal 2 → http://localhost:5173
```

- Each run uses a new lot id (`LOT-MMDD-HHMM`); the gateway keeps its state in `DATA_DIR`, so
  earlier lots stay visible on the page.
- The first stop ("in custody"): buy on the page with MetaMask on Hedera testnet. If the wallet
  is not the one in `DEMO_BUYER_ADDRESS`, press **Onboard me (demo)** first. The wallet pays in
  HBAR.
- The second stop ("frozen"): show the page, then Enter.
- At the end the terminal prints the block for the README: writer wallets, contract addresses,
  the token, and the query to run:

  ```sh
  pnpm arkiv:query --lot LOT-1107-1030 --out-of-range     # against the real Arkiv node
  ```

  Put those addresses in the README's _Deployed addresses_ table and in the submission forms.

- For a judge who wants to drive: `pnpm demo --live --interactive` has the same keys as A,
  including `o`, which cuts the gateway's route to 0G.
- Timing: real networks answer in seconds. A handoff takes 20–60 s to go from PENDING to
  decided and applied; the terminal waits up to 5 minutes before giving up and says what it is
  waiting on.

If a run fails midway, nothing needs cleaning up: start another, it gets a new lot.

## D. With hardware

Only after `pnpm device probe --port <port>` shows the parts you expect
([`hardware.md`](hardware.md) has the bring-up). Then any of the above with the board:

```sh
pnpm demo --interactive --port /dev/cu.usbmodem101 --sim gps          # indoors: keep the GPS simulated
pnpm demo --interactive --port /dev/cu.usbmodem101 --anchor-port /dev/cu.usbmodem201
pnpm demo --live --pause --port /dev/cu.usbmodem101 --sim gps
```

With a real SHT31 the lot's limits are set around what it reads at start; warm it in your hand or
breathe on it to breach. With a real camera the decisions must come from the real model (B or
C): the stand-in cannot see and escalates every real photo. The firmware has not been compiled
yet, so leave an hour for its first build.

## E. Thirty seconds per track

**0G.** The vision model's decision is in the loop: no handoff is accepted without it. Every
decision carries its request id, and the whole episode — photo, raw readings, the answer, every
failed attempt — is encrypted on 0G Storage and replayable. Safe stop: unreachable means PENDING,
never a made-up answer. The body is a sensor device with a hardware-rooted key.

**Arkiv.** Readings and custody records are created by the device's own wallet, so a buyer can
ask the chain for them and know who wrote them — a microcontroller signs its own transactions
after reading them. The buyer's question is one filter. Evidence expires with the dispute window.
Write-ups in [`arkiv/`](../arkiv/).

**Hedera.** One Asset Tokenization Studio security token per lot, with an allowlist and KYC. A
custody oracle is its compliance module: transfers only while a venue holds the goods; freeze on a
breach that the contract itself verifies from a device-signed reading plus the attested REJECT;
unfreeze by the inspector; redeem at delivery. Contracts in [`contracts/`](../contracts/).

## F. When something goes wrong

| Symptom                                                          | Do                                                                                                                                                                                 |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `address already in use` at start                                | an earlier run is still up: Ctrl-C it, or `pkill anvil`                                                                                                                            |
| the page says it cannot reach the gateway                        | terminal 1 is not up yet, or `VITE_GATEWAY_URL` points elsewhere                                                                                                                   |
| every handoff ESCALATEs                                          | real photos with the stand-in model: use B or C, or `--sim camera`                                                                                                                 |
| a handoff stays PENDING for long (C)                             | the terminal's wait says what is pending; `--verbose` shows every step; check funds with `pnpm doctor`                                                                             |
| `the gateway refused this handoff: … cannot be accepted while …` | wrong key for the state; the hint line says what to press                                                                                                                          |
| `this device is still assigned to lot …` (C)                     | the previous lot was not delivered; finish it with `4`, or use a fresh device identity (`--data` for the CLI, or simply a new run of the demo, which makes a new simulated device) |
| the buy reverts                                                  | the lot is not in custody, or the wallet is not allow-listed: **Onboard me (demo)**                                                                                                |
| `ConfigError` on `--live`                                        | `.env` is incomplete; the message lists every missing value                                                                                                                        |
