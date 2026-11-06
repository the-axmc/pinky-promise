# arkiv-devnet

A local stand-in for an Arkiv node. It lets the **unmodified** `@arkiv-network/sdk` create,
change and query entities with no network, access key or faucet — so the whole project can be
developed and tested offline, and switched to the Rabdi testnet by changing the chain it is given.

It is an emulation, built from Arkiv's public documentation and checked against the Rabdi
testnet. It is not the real chain: see [Differences from a real node](#differences-from-a-real-node).

## How it works

```
anvil (plain local chain, chain id 1337)
  └─ ArkivDevEngine bytecode installed at 0x4400…0044    accepts the SDK's execute(...) calls
JSON-RPC proxy   ← the URL you give the SDK
  ├─ arkiv_query / arkiv_getEntity / arkiv_getBlockTiming    answered from a replica built from logs
  └─ every other method                                       forwarded to anvil unchanged
```

- **Engine** (`packages/devnet/contracts/src/ArkivDevEngine.sol`): a Solidity implementation of
  the write-transaction spec — the `execute` entry point, the five operations, key derivation,
  expiry rules, creation flags, events and custom errors. Its compiled bytecode is checked in as
  `engine.artifact.json`, so running the devnet needs `anvil` but never the Solidity compiler.
- **Replica** (`store.ts`): rebuilt purely from the engine's logs, so a restarted proxy catches
  up from block 0 and a reset chain is detected and replayed.
- **Query language** (`query/`): lexer, parser and evaluator for conditions, `ORDER BY`,
  projections, paging and counting, with the node's error codes, wording and positions.

## Start it

Requires `anvil` on `PATH` (it ships with [Foundry](https://getfoundry.sh)).

From code:

```ts
import { createPublicClient, createWalletClient } from '@arkiv-network/sdk';
import { http } from 'viem';
import { startArkivDevnet } from './arkiv'; // packages/devnet/src/arkiv/index.ts

const devnet = await startArkivDevnet({ blockTime: 2 }); // seconds; 0 mines a block per transaction
await devnet.fund(account.address); // 100 test tGLM

const reader = createPublicClient({ chain: devnet.chain, transport: http() });
const wallet = createWalletClient({ chain: devnet.chain, transport: http(), account });
// ... use the SDK exactly as against Rabdi ...
await devnet.stop();
```

`startArkivDevnet(options)` takes `{ port?, anvilPort?, chainId?, blockTime?, quiet? }` (free
ports, chain id 1337, 2-second blocks and quiet anvil by default) and resolves to:

| Member | Meaning |
| --- | --- |
| `rpcUrl` | The proxy URL. Give this to SDK clients and to the browser. |
| `chainId`, `chain` | The chain id and a viem chain whose default RPC is `rpcUrl`. |
| `anvilUrl` | The anvil URL, for debugging. It does not answer `arkiv_*` methods. |
| `fund(address, ether?)` | Sets an account's balance. |
| `mine(blocks?)` | Mines empty blocks, for example to move past an expiry. |
| `blockNumber()` | The current block, read straight from the chain. |
| `restartProxy()` | Restarts the proxy with an empty replica, which it rebuilds from logs. |
| `stop()` | Closes the proxy and stops the anvil process it started. |

From a terminal:

```bash
pnpm --filter @pinky/devnet arkiv                       # http://127.0.0.1:8645, anvil on 8646
pnpm --filter @pinky/devnet arkiv --port 9000 --anvil-port 9001 --chain-id 1337 --block-time 2
```

The same settings can come from `ARKIV_DEVNET_PORT`, `ARKIV_DEVNET_ANVIL_PORT`,
`ARKIV_DEVNET_CHAIN_ID` and `ARKIV_DEVNET_BLOCK_TIME`. Ctrl-C stops anvil cleanly.

## Tests

```bash
pnpm --filter @pinky/devnet test
```

| Suite | What it covers |
| --- | --- |
| `test/arkiv.entities.test.ts` | Every write operation through the SDK: all column types, explicit and estimated gas, patch, readonly, extend, ownership, delete, atomic batches, expiry, events, replica rebuild, and engine rules sent as raw calldata. |
| `test/arkiv.query.test.ts` | Queries through the SDK: every operator and type, schema tags, owner/creator, sorting, paging, counting, projections, schema mismatches, raw query strings and `QueryError` kinds. |
| `test/arkiv.rpc.test.ts` | The JSON on the wire (field order and encodings as Rabdi returns them), error codes, batches, CORS, and running with a block time. |
| `test/arkiv.language.test.ts` | The query language alone, against error codes, wording and positions captured from Rabdi. |

## Rebuilding the engine

Only after editing the Solidity source:

```bash
pnpm --filter @pinky/devnet build:arkiv-engine   # forge build + refresh engine.artifact.json
```

## Differences from a real node

Deliberate, or simply unknown — nothing here should be taken as a statement about Rabdi.

**Chain and fees**

- Chain id 1337, not Rabdi's 7794095, so nothing signed for the devnet is valid on Rabdi.
- Gas costs are this Solidity engine's, not the real engine's. For orientation: a small create
  uses about 200k gas here, one with a 9 KB `bytes` value about 430k, one with the maximum
  128 KiB about 5.3M. Do not derive Rabdi gas limits from these.
- No access keys, quotas or rate limits. Any URL path is accepted and ignored.
- It is anvil underneath, so anvil's dev methods (`anvil_setBalance`, `anvil_mine`, …) work.

**Writes**

- The engine emits one extra, devnet-only event per create and patch, `DevAttributes`, which
  carries the attributes for the replica. The SDK ignores it; code reading raw logs will see it.
- When several rules are broken at once, which error wins is this engine's choice (structure
  first, then existence and expiry, then ownership, then read-only). The real order is unknown.
- `NonCanonicalOperationData` is detected by decoding and re-encoding the payload.
- `str` values are not checked for valid UTF-8, and the 128 KiB budget across all `bytes` values
  of one operation (which the SDK enforces before sending) is not re-checked; only each value's
  own limit is.
- Type id 6 (`bytes32`) is accepted. The write documentation lists it as reserved, but Rabdi
  holds attributes of that type.
- A tombstone for an attribute the entity does not have is accepted and does nothing.
- An extension to the entity's current expiry is accepted and emits `ExpiryExtended`.
- `execute` returns one key per operation. What the real engine returns is not documented.
- `updatedAt` moves on a patch only, following the SDK's description of the field.
- An entity counts as expired from the block equal to its `expiresAt`. Operating on an expired
  entity reverts with `EntityExpired`; a real node may report `EntityNotFound` once it has
  cleaned the entity up.

**Reads**

- HTTP only. There is no WebSocket endpoint, so `webSocket()` transports and subscriptions do
  not work; `watchEntityEvents` over HTTP polling does.
- Rabdi adds an undocumented `cursor` (`"b64:…"`) to a full page. The devnet does not.
- Without `ORDER BY`, and for ties within one, results come in creation order. The real node
  documents only "its own order" (observed not to be key order).
- `NOT` is parsed and then answered with `-32603 … NotImplemented`, as Rabdi does today.
- Error codes follow the node. Wording and positions are verbatim for the cases captured in
  `test/arkiv.language.test.ts`; for anything else the wording is this implementation's.
- The node's limits on query length, nesting depth and predicate count (`-32004`) are not
  enforced.
- `addr` values are rendered as lowercase 20-byte hex and `dec` values in their shortest form.
  Both match what the SDK accepts, but were not compared against Rabdi data of those types.
