# Arkiv friction log

What got in our way while building on Arkiv (SDK `@arkiv-network/sdk@1.0.1`, Rabdi testnet,
docs as of 6 November 2026), most painful first. Each item says what we expected, what happened
and how to reproduce it. Items marked **(emulator)** were measured on our local stand-in for the
node rather than on Rabdi.

Everything here was observed while building this repository. Nothing is hypothetical.

## 1. There is no way to run a node locally without Docker

- **Expected:** a binary or an npm package we could start in tests and CI, the way `anvil`
  starts an EVM chain.
- **What happened:** the only local node is the Docker image the SDK's own tests use
  (`ghcr.io/arkiv-network/arkiv-reth-dev`, see `test/src/utils.ts` in `arkiv-sdk-js`). Our
  machines had no Docker, and writing to Rabdi needs an access key and faucet funds, so for a
  while we could not execute a single write.
- **What it cost:** we wrote our own emulator (a Solidity engine at `0x44…44` on anvil plus a
  JSON-RPC proxy with a query-language implementation, `packages/devnet/src/arkiv`, about
  2,400 lines) just to be able to test. That is a lot of work to spend before the first entity.
- **Suggestion:** publish the dev node as a standalone binary (or `npx @arkiv-network/devnode`).

## 2. Writes take 4 seconds by default on a 2-second chain

- **Expected:** `createEntity` to resolve about one block after sending.
- **What happened:** the chain object returned by `rabdi()` (and `localhost`) has no
  `blockTime`, so viem falls back to a 4,000 ms polling interval and cache time. **(emulator)**
  With 2-second blocks, four consecutive `createEntity` calls took 4009, 4010, 4010 and 4009 ms;
  after adding `blockTime: 2000` to the chain they took 2012, 2009, 2010 and 2010 ms.
- **Reproduce:** `createWalletClient({ chain: rabdi({ accessKey: '' }), transport: http() })`
  and inspect `client.pollingInterval` (4000).
- **Suggestion:** set `blockTime: 2_000` in the chain definitions the SDK exports.

## 3. A device cannot check what it is asked to sign without re-implementing the encoder

- **Our case:** readings must be created by the device's own wallet, but the transaction is
  assembled by a gateway. Before signing, the device has to confirm the calldata says what it
  measured.
- **Expected:** public helpers to encode and decode the `execute` calldata of a create.
- **What happened:** `encodeCreate` and the attribute codec live in `src/schema/attributes.ts`
  and `src/schema/codec.ts`, marked as an internal seam and not exported from any entry point.
  We wrote our own decoder and reference encoder (`packages/protocol/src/arkiv/calldata.ts`) and
  test them against the SDK's by importing its source file by path.
- **Suggestion:** export `encodeExecute` / `decodeExecute`, or document the wire format as
  stable. Hardware wallets and signing services need the same thing.

## 4. The recommended gas policy is only written down in the agent skills

- **Expected:** the docs to say how much gas a write needs.
- **What happened:** the SDK estimates and adds 25 %, but the `arkiv-first-write` and
  `arkiv-write-safety` skills say default estimation produced out-of-gas reverts on Rabdi and
  recommend explicit `{ nonce, gas, gasPrice }` with `gas = max(1,000,000 + 400,000 × (ops − 1),
2 × estimate)`. Those numbers are not in the docs, and the SDK has no public estimator for a
  create (the skill says so too), so we hard-coded the floor.
- **Related:** the SDK's public client type does not expose viem actions it has at runtime;
  `getGasPrice` needs `import { getGasPrice } from 'viem/actions'` (TS2339 otherwise).

## 5. Query-language surprises

All observed on Rabdi with read-only calls.

- **`!=` points to something that does not work.** The error for `!=` says to "write NOT (attr
  = value) for the complement", but a query using `NOT` returns
  `-32603 count: store: NotImplemented`. There is currently no way to express "not equal".
- **`EXISTS` only sees indexed attributes.** It is documented as "is set, with any type". On
  Rabdi, `… AND EXISTS(chunkcount)` returns count 0 for entities that do carry an unindexed
  `chunkcount`.
- **The SDK says match-all cannot be written; the node accepts `*`.** The SDK throws that the
  language "has no spelling for 'match every entity'", while the node's own empty-query error
  recommends `*`.
- **Reserved words are looser than documented.** The SDK refuses `order` as an attribute name;
  the node accepts `order = i32(1)`.
- **Good:** a bare hex literal gets a precise, actionable error ("a hex literal must carry its
  type — write addr(0x…), key(0x…), bytes32(0x…) or u256(0x…)", with the position).

## 6. Types that almost fit

- **No `bytes32` column.** The node has the type (Rabdi holds `bytes32` attributes and the
  query language accepts `bytes32(0x…)`), but the SDK has no constructor and reads such values
  back as `key`. We index hashes as 66-character hex strings instead, which is half of the
  128-byte string limit and a bigger index key than necessary.
- **`str` is capped at 128 bytes**, so a 64-byte public key as hex (130 characters) does not
  fit and had to become an unindexable `bytes` column, and a model's free-text reason has to be
  truncated.
- **No multi-valued attributes.** "Which venues is this device enrolled at" became a
  comma-separated string that can only be matched whole.
- **Attribute names must start with a letter** and cannot be `key`, `order`, `by` or a type
  name, so the `0g_request_id` field in our design had to be renamed `zg_request_id`. The
  validation error was clear; the rule is easy to miss until you hit it.

## 7. Lifetimes

- **"Never" does not exist.** The maximum lifetime is 7,884,000 blocks (about 182.5 days). Our
  device and venue registry entries are meant to be permanent, so they are created with
  `ExpirationTime.max()` and `permissionlessExtension`, and somebody has to remember to extend
  them. A way to ask for "renew automatically while funded" would remove a silent failure mode.
- **Durations must be an even number of seconds.** `ExpirationTime.fromSeconds(3601)` throws.
  The message is good, but every caller ends up writing the same rounding helper.
- **Natural expiry emits no event** (the Arkiv agent skills state this; our emulator had to
  filter by block height for the same reason), so a client that mirrors entities has to poll or
  compare block heights to notice that something expired.

## 8. Readonly is all-or-nothing

We wanted "the device writes a checkpoint as PENDING, and later fills in the decision once,
after which it is immutable". Readonly entities cannot be patched at all, and mutable ones can
be patched forever, so we write two entities per checkpoint and readers pick the decided one.
A "seal after next patch" or per-attribute immutability would model append-then-freeze records.

## 9. Smaller things

- The README inside the SDK package still shows `"@arkiv-network/sdk": "^0.9.0"` in its example
  `package.json` output, although the package is 1.0.1.
- `/start-here/installation/` redirects to `/start-here/first-entity/`, and the docs landing
  page never names the npm package, so the package name has to be found elsewhere.
- Responses of full pages carry an undocumented `cursor: "b64:…"` field. Parse-error `data` is
  `{ message, position }` while a comment in the SDK describes `{ position, expected, got }`.
- The access key is a path segment of the RPC URL, so it ends up in any log line or error that
  prints a URL. We redact transport errors, but a header would be harder to leak.

## What worked well

- Typed schemas with compile-time checked filters caught several mistakes before a single
  request was sent (filtering on an unindexed column does not compile).
- `$creator` being separate from `$owner` is exactly the primitive our trust model needs.
- Every docs page is available as raw Markdown by appending `.md`, which made it easy to read
  the docs with tools.
- Error messages from both the SDK and the node are specific and say what to write instead.
