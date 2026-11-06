import type { Hex } from '@pinky/protocol';
import type { LotEntity } from '@pinky/protocol/arkiv';
import vkArtifact from '@pinky/zk/artifacts/geofence.vk.json';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Checks, Linked } from './components/Checks';
import { ReadingStrip, TemperatureChart } from './components/charts';
import { type Context, connect, explorerLink } from './lib/config';
import { type OpenedEpisode, fetchDemoViewKey, fetchEpisode } from './lib/episode';
import { celsius, clock, coins, dateTime, percent, shortHex } from './lib/format';
import { type LotView, listLots, loadLot, verifyProof } from './lib/lot';
import { type Buyer, type Holding, type Listing, browserWallet, buy, demoWallet, explainRefusal, holdingOf, listingsFor, redeem, requestOnboarding } from './lib/market';
import { allOk } from './lib/verify';

const DEFAULT_GATEWAY = (import.meta.env.VITE_GATEWAY_URL as string | undefined) ?? 'http://127.0.0.1:8787';
/** SHA-256 of the geofence circuit's verification key, as built into this page. */
const VK_HASH = vkArtifact.vkHash as Hex;

const STATE_TEXT: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral'; note: string }> = {
  REGISTERED: { label: 'Registered', tone: 'neutral', note: 'No custody accepted yet: nothing has been issued.' },
  IN_CUSTODY: { label: 'In custody', tone: 'good', note: 'A venue holds the goods. The receipt can be traded.' },
  IN_TRANSIT: { label: 'In transit', tone: 'warn', note: 'On the road between venues: transfers are restricted.' },
  FROZEN: { label: 'Frozen', tone: 'bad', note: 'A breach was confirmed. Every unit is frozen until an inspector releases the lot.' },
  DELIVERED: { label: 'Delivered', tone: 'good', note: 'Final delivery accepted. The receipt can be redeemed.' },
  NONE: { label: 'Unknown', tone: 'neutral', note: 'The oracle does not know this lot.' },
};

const DECISION_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = {
  ACCEPTED: 'good',
  RELEASED: 'good',
  REFUSED: 'bad',
  FROZEN: 'bad',
  BLOCKED_BY_BREACH: 'bad',
  ESCALATED: 'warn',
  PENDING: 'warn',
};

const KIND_LABEL: Record<string, string> = {
  WAREHOUSE_IN: 'Warehouse in',
  WAREHOUSE_OUT: 'Warehouse out',
  DOCK_HANDOFF: 'Dock handoff',
  FINAL_DELIVERY: 'Final delivery',
};

/** Short names for the handoff markers on the readings strip. */
const STRIP_LABEL: Record<string, string> = { WAREHOUSE_IN: 'In', WAREHOUSE_OUT: 'Out', DOCK_HANDOFF: 'Dock', FINAL_DELIVERY: 'Delivery' };

export function App() {
  const [gatewayUrl, setGatewayUrl] = useState(DEFAULT_GATEWAY);
  const [ctx, setCtx] = useState<Context>();
  const [error, setError] = useState<string>();
  const [lots, setLots] = useState<LotEntity[]>([]);
  const [assetId, setAssetId] = useState<string>();
  const [view, setView] = useState<LotView>();

  useEffect(() => {
    let cancelled = false;
    setCtx(undefined);
    setError(undefined);
    connect(gatewayUrl).then(
      (connected) => !cancelled && setCtx(connected),
      (problem) => !cancelled && setError(`Cannot reach the gateway at ${gatewayUrl}: ${(problem as Error).message}. Start the stack with \`pnpm demo\`.`),
    );
    return () => {
      cancelled = true;
    };
  }, [gatewayUrl]);

  const refresh = useCallback(async () => {
    if (!ctx) return;
    try {
      const found = await listLots(ctx);
      setLots(found);
      const chosen = assetId ?? found[0]?.assetId;
      if (chosen && chosen !== assetId) setAssetId(chosen);
      if (chosen) setView(await loadLot(ctx, chosen, VK_HASH));
      setError(undefined);
    } catch (problem) {
      setError((problem as Error).message);
    }
  }, [ctx, assetId]);

  // Keep the page live while a journey is running.
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => document.visibilityState === 'visible' && void refresh(), 4_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <div className="page">
      <header className="top">
        <div>
          <h1>Pinky Promise</h1>
          <p className="muted">Buyer view — everything below is read from Arkiv and Hedera and checked in this browser.</p>
        </div>
        <label className="gateway">
          <span>Gateway</span>
          <input defaultValue={gatewayUrl} onBlur={(event) => setGatewayUrl(event.target.value.trim())} onKeyDown={(event) => event.key === 'Enter' && (event.target as HTMLInputElement).blur()} />
        </label>
      </header>

      {error ? <p className="banner banner-bad">{error}</p> : null}
      {ctx && ctx.config.zg.mode === 'mock' ? (
        <p className="banner banner-warn">
          This gateway uses a stand-in decision model, not 0G. Its decisions are recorded as <code>dev-mock</code> and would be refused by a gateway
          running against the 0G Compute Router.
        </p>
      ) : null}

      {ctx && lots.length === 0 && !error ? <p className="muted">No lots on Arkiv yet for registry {shortHex(ctx.config.arkiv.registry)}.</p> : null}

      {lots.length > 0 ? (
        <nav className="lots" aria-label="Lots">
          {lots.map((lot) => (
            <button key={lot.assetId} className={lot.assetId === assetId ? 'lot-tab lot-tab-on' : 'lot-tab'} onClick={() => setAssetId(lot.assetId)}>
              <strong>{lot.assetId}</strong>
              <span>{lot.title}</span>
            </button>
          ))}
        </nav>
      ) : null}

      {ctx && view ? <Lot ctx={ctx} view={view} onChanged={refresh} /> : null}

      <footer className="muted">
        {ctx ? (
          <>
            Arkiv chain {ctx.config.arkiv.chainId} · registry {shortHex(ctx.config.arkiv.registry)} · Hedera chain {ctx.config.hedera.chainId} · oracle{' '}
            <Linked href={explorerLink(ctx.config, 'contract', ctx.config.hedera.oracle)}>{shortHex(ctx.config.hedera.oracle)}</Linked>
          </>
        ) : (
          'connecting…'
        )}
      </footer>
    </div>
  );
}

function Lot({ ctx, view, onChanged }: { ctx: Context; view: LotView; onChanged: () => Promise<void> }) {
  const { lot, onChain } = view;
  const state = STATE_TEXT[onChain?.state ?? 'NONE']!;
  const trust = [...view.lotChecks, ...view.deviceChecks, ...(onChain ? [{ ok: onChain.agreesWithArkiv, label: 'Hedera oracle names the same token, device and attestor as Arkiv' }] : [])];
  const outside = view.readings.filter((reading) => !reading.inRange).length;

  return (
    <main>
      <section className="grid-2">
        <div className="card">
          <div className="card-head">
            <h2>{lot.title}</h2>
            <span className={`pill pill-${state.tone}`}>{state.label}</span>
          </div>
          <p>{state.note}</p>
          <dl className="facts">
            <div>
              <dt>Allowed range</dt>
              <dd>
                {celsius(lot.tempMinCenti)} – {celsius(lot.tempMaxCenti)}, {percent(lot.rhMinCenti)} – {percent(lot.rhMaxCenti)} RH
              </dd>
            </div>
            <div>
              <dt>Receipt token</dt>
              <dd>
                <Linked href={explorerLink(ctx.config, 'contract', lot.token)}>{shortHex(lot.token)}</Linked>
                {onChain ? ` · ${onChain.totalSupply} of ${lot.units} units issued` : ''}
              </dd>
            </div>
            <div>
              <dt>Sensor device</dt>
              <dd>
                {view.device?.label ?? 'unknown'} · {shortHex(lot.deviceId)}
              </dd>
            </div>
            <div>
              <dt>Readings</dt>
              <dd>
                {view.readings.length} published{outside ? ` · ${outside} outside limits` : ' · all within limits'}
              </dd>
            </div>
            <div>
              <dt>Shipment ends</dt>
              <dd>{dateTime(lot.endsAt)}</dd>
            </div>
          </dl>
          <details>
            <summary>
              Why trust this record? <Checks checks={trust} compact />
            </summary>
            <Checks checks={trust} />
          </details>
        </div>
        <BuyPanel ctx={ctx} view={view} onChanged={onChanged} />
      </section>

      <section className="card">
        <h2>Custody handoffs</h2>
        <p className="muted">Each handoff was judged by a vision model from the seal photo and the readings. A handoff with no decision is not accepted.</p>
        {view.checkpoints.length === 0 ? <p className="muted">No handoffs yet.</p> : null}
        <ol className="timeline">
          {view.checkpoints.map((record) => (
            <li key={record.checkpointId} className={`event event-${DECISION_TONE[record.outcome] ?? 'neutral'}`}>
              <div className="event-head">
                <strong>{KIND_LABEL[record.kind] ?? record.kind}</strong>
                <span className={`pill pill-${DECISION_TONE[record.outcome] ?? 'neutral'}`}>{record.outcome.replaceAll('_', ' ')}</span>
                <span className="muted">
                  {dateTime(record.ts)}
                  {record.venue ? ` · ${record.venue.name}` : ''}
                </span>
                <Checks checks={record.checks} compact />
              </div>
              <p className="event-reason">
                {record.decision === 'PENDING' ? 'No decision yet. ' : `${record.decision.replaceAll('_', ' ')}: `}
                {record.reason}
              </p>
              {record.disclosed ? (
                <p className="event-evidence">
                  Disclosed evidence: reading #{record.disclosed.seq} measured <strong>{celsius(record.disclosed.tempCenti)}</strong>, {percent(record.disclosed.rhCenti)} RH, signed by
                  the device.
                </p>
              ) : null}
              <details>
                <summary>Decision record</summary>
                <dl className="facts facts-wide">
                  <div>
                    <dt>Decided by</dt>
                    <dd>
                      {record.zgSource === '0g-router' ? `0G Compute · ${record.zgModel ?? ''}` : record.zgSource === 'dev-mock' ? `stand-in model (not 0G) · ${record.zgModel ?? ''}` : 'nobody yet'}
                      {record.zgTeeVerified ? ' · TEE verified' : ''}
                    </dd>
                  </div>
                  <div>
                    <dt>0G request id</dt>
                    <dd>{record.zgRequestId ? <code>{record.zgRequestId}</code> : '—'}</dd>
                  </div>
                  <div>
                    <dt>Episode log (0G Storage root)</dt>
                    <dd>{record.episodeRoot ? <code>{record.episodeRoot}</code> : '—'}</dd>
                  </div>
                  <div>
                    <dt>Checkpoint id</dt>
                    <dd>
                      <code>{record.checkpointId}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Readings covered</dt>
                    <dd>
                      #{record.firstSeq} – #{record.lastSeq}
                    </dd>
                  </div>
                </dl>
                <Checks checks={record.checks} />
              </details>
            </li>
          ))}
        </ol>
      </section>

      <ReadingsSection ctx={ctx} view={view} />
      <ProofsSection view={view} />
    </main>
  );
}

function ReadingsSection({ ctx, view }: { ctx: Context; view: LotView }) {
  const { lot } = view;
  const [viewKey, setViewKey] = useState('');
  const [episodes, setEpisodes] = useState<OpenedEpisode[]>([]);
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const roots = useMemo(() => view.checkpoints.map((record) => record.episodeRoot).filter((root): root is Hex => Boolean(root)), [view.checkpoints]);
  const rootsKey = roots.join(',');

  const unlock = useCallback(
    async (key: string) => {
      setBusy(true);
      setProblem(undefined);
      try {
        if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('a view key is 0x followed by 64 hex characters');
        setEpisodes(await Promise.all(roots.map((root) => fetchEpisode(ctx, root, key as Hex))));
      } catch (caught) {
        setEpisodes([]);
        setProblem((caught as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [ctx, roots],
  );

  // New handoffs bring new episode logs: reopen with the key already entered.
  const unlockedFor = useRef('');
  useEffect(() => {
    if (episodes.length > 0 && unlockedFor.current !== rootsKey) void unlock(viewKey);
    unlockedFor.current = rootsKey;
  }, [rootsKey, episodes.length, unlock, viewKey]);

  const raw = useMemo(() => {
    const bySeq = new Map<number, OpenedEpisode['readings'][number]>();
    for (const episode of episodes) for (const reading of episode.readings) bySeq.set(reading.seq, reading);
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }, [episodes]);
  const rawBySeq = new Map(raw.map((reading) => [reading.seq, reading]));
  const handoffs = view.checkpoints.map((record) => ({ seq: record.seq, label: STRIP_LABEL[record.kind] ?? record.kind }));

  return (
    <section className="card">
      <h2>Readings</h2>
      <p className="muted">
        The public record on Arkiv says only whether each reading was within limits — the values stay private. Each entity was created by the device&apos;s
        own wallet, so nobody else could have written it.
      </p>
      <ReadingStrip
        readings={view.readings.map((reading) => ({
          seq: reading.seq,
          ts: reading.ts,
          inRange: reading.inRange,
          hasProof: Boolean(reading.proof),
          ...(reading.venue ? { venueName: reading.venue.name } : {}),
        }))}
        handoffs={handoffs}
      />

      <div className="unlock">
        <h3>Raw values (private)</h3>
        <p className="muted">
          Temperatures, the seal photos and the model&apos;s full answers are in encrypted episode logs on 0G Storage. A view key decrypts them here, in the
          browser.
        </p>
        <div className="row">
          <input aria-label="View key" placeholder="view key (0x…)" value={viewKey} onChange={(event) => setViewKey(event.target.value.trim())} />
          <button disabled={busy || roots.length === 0} onClick={() => void unlock(viewKey)}>
            Decrypt
          </button>
          {ctx.config.demo ? (
            <button
              className="ghost"
              disabled={busy || roots.length === 0}
              onClick={async () => {
                try {
                  const key = await fetchDemoViewKey(ctx, lot.assetId);
                  setViewKey(key);
                  await unlock(key);
                } catch (caught) {
                  setProblem((caught as Error).message);
                }
              }}
            >
              Use the demo key
            </button>
          ) : null}
        </div>
        {roots.length === 0 ? <p className="muted">No episode logs yet: they are written when a handoff is decided.</p> : null}
        {problem ? <p className="banner banner-bad">{problem}</p> : null}
        {raw.length > 0 ? (
          <>
            <h4>Temperature, from the decrypted logs</h4>
            <TemperatureChart points={raw} minCenti={lot.tempMinCenti} maxCenti={lot.tempMaxCenti} />
            <div className="photos">
              {episodes
                .filter((episode) => episode.photo)
                .map((episode) => (
                  <figure key={episode.root}>
                    <img src={`data:${episode.photo!.mime};base64,${episode.photo!.base64}`} alt="Seal photo taken at the handoff" />
                    <figcaption>
                      {KIND_LABEL[view.checkpoints.find((record) => record.episodeRoot === episode.root)?.kind ?? ''] ?? 'Handoff'} — the photo the model judged
                    </figcaption>
                  </figure>
                ))}
            </div>
          </>
        ) : null}
      </div>

      <details>
        <summary>All readings as a table</summary>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Time</th>
                <th>Within limits</th>
                <th>Temperature</th>
                <th>Venue (proven)</th>
                <th>Checks</th>
              </tr>
            </thead>
            <tbody>
              {view.readings.map((reading) => (
                <tr key={reading.digest}>
                  <td>{reading.seq}</td>
                  <td>{clock(reading.ts)}</td>
                  <td>{reading.inRange ? '✓ yes' : '✕ no'}</td>
                  <td>{rawBySeq.has(reading.seq) ? celsius(rawBySeq.get(reading.seq)!.tempCenti) : <span className="muted">private</span>}</td>
                  <td>{reading.venue ? reading.venue.name : <span className="muted">—</span>}</td>
                  <td>
                    <Checks checks={reading.checks} compact />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

function ProofsSection({ view }: { view: LotView }) {
  const [results, setResults] = useState<Record<string, 'checking' | 'valid' | 'invalid' | 'error'>>({});
  const [note, setNote] = useState<string>();

  const verify = async (targets: LotView['proofs']) => {
    setNote(undefined);
    for (const proof of targets) {
      setResults((current) => ({ ...current, [proof.entityKey]: 'checking' }));
      try {
        const valid = await verifyProof(view, proof);
        setResults((current) => ({ ...current, [proof.entityKey]: valid ? 'valid' : 'invalid' }));
      } catch (caught) {
        setResults((current) => ({ ...current, [proof.entityKey]: 'error' }));
        setNote(`The verifier could not run in this browser: ${(caught as Error).message}`);
        return;
      }
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>Location proofs</h2>
        {view.proofs.length > 0 ? <button onClick={() => void verify(view.proofs)}>Verify all in this browser</button> : null}
      </div>
      <p className="muted">
        A zero-knowledge proof shows a device-signed reading was taken inside a venue&apos;s boundary without revealing where. It gives privacy, not
        authenticity: a spoofed GPS would still prove. Authenticity comes from the venue anchor&apos;s co-signature on each handoff.
      </p>
      {view.proofs.length === 0 ? <p className="muted">No proofs: readings taken on the road, or without a GPS fix, have none.</p> : null}
      {note ? <p className="banner banner-bad">{note}</p> : null}
      <div className="table-wrap">
        <table>
          {view.proofs.length > 0 ? (
            <thead>
              <tr>
                <th>Reading</th>
                <th>Venue</th>
                <th>Proof</th>
                <th>Record</th>
                <th>Zero-knowledge check</th>
              </tr>
            </thead>
          ) : null}
          <tbody>
            {view.proofs.map((proof) => {
              const result = results[proof.entityKey];
              return (
                <tr key={proof.entityKey}>
                  <td>#{proof.seq}</td>
                  <td>{proof.venue?.name ?? proof.venueId}</td>
                  <td>
                    <code>{shortHex(proof.proofHash, 8, 6)}</code>
                  </td>
                  <td>
                    <Checks checks={proof.checks} compact />
                  </td>
                  <td>
                    {result === 'valid' ? (
                      <span className="badge badge-good">✓ proof verifies</span>
                    ) : result === 'invalid' ? (
                      <span className="badge badge-bad">✕ proof does not verify</span>
                    ) : result === 'checking' ? (
                      <span className="muted">verifying…</span>
                    ) : (
                      <button className="ghost" onClick={() => void verify([proof])}>
                        Verify
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function BuyPanel({ ctx, view, onChanged }: { ctx: Context; view: LotView; onChanged: () => Promise<void> }) {
  const { lot, onChain } = view;
  const [buyer, setBuyer] = useState<Buyer | undefined>(() => demoWallet(ctx));
  const [listings, setListings] = useState<Listing[]>([]);
  const [holding, setHolding] = useState<Holding>();
  const [units, setUnits] = useState('5');
  const [message, setMessage] = useState<{ tone: 'good' | 'bad'; text: string }>();
  const [busy, setBusy] = useState(false);
  const token = onChain?.token;

  const reload = useCallback(async () => {
    if (!token) return;
    setListings(await listingsFor(ctx, token).catch(() => []));
    if (buyer) setHolding(await holdingOf(ctx, token, buyer.address).catch(() => undefined));
  }, [ctx, token, buyer]);
  useEffect(() => {
    void reload();
  }, [reload, view.at]);

  const act = async (label: string, job: () => Promise<string | void>) => {
    setBusy(true);
    setMessage(undefined);
    try {
      const done = await job();
      setMessage({ tone: 'good', text: done || label });
      await Promise.all([reload(), onChanged()]);
    } catch (caught) {
      setMessage({ tone: 'bad', text: explainRefusal(caught) });
    } finally {
      setBusy(false);
    }
  };

  const listing = listings[0];
  const count = BigInt(Math.max(0, Math.floor(Number(units) || 0)));
  const frozen = onChain?.state === 'FROZEN';
  // The token's compliance module allows transfers only while a venue holds the goods.
  const tradable = onChain?.state === 'IN_CUSTODY';

  return (
    <div className="card">
      <div className="card-head">
        <h2>Buy the receipt</h2>
        {buyer ? <span className="muted">{buyer.kind === 'demo' ? 'demo wallet' : 'your wallet'} {shortHex(buyer.address)}</span> : null}
      </div>

      {!token ? <p className="muted">The token is not registered on Hedera yet.</p> : null}
      {frozen ? <p className="banner banner-bad">This lot is frozen after a confirmed breach. Units cannot move until an inspector releases it.</p> : null}
      {onChain?.state === 'IN_TRANSIT' ? <p className="banner banner-warn">The lot is in transit: transfers are restricted until a venue accepts custody.</p> : null}
      {onChain?.state === 'REGISTERED' ? <p className="muted">Nothing has been issued yet: units appear when a venue first accepts custody.</p> : null}
      {onChain?.state === 'DELIVERED' ? <p className="muted">The lot was delivered: units can be redeemed by their holders and are no longer traded.</p> : null}

      {!buyer ? (
        <button
          disabled={busy}
          onClick={() =>
            act('Wallet connected', async () => {
              const provider = (window as unknown as { ethereum?: Parameters<typeof browserWallet>[1] }).ethereum;
              if (!provider) throw new Error('No browser wallet found. Install MetaMask, or use a demo gateway.');
              setBuyer(await browserWallet(ctx, provider));
            })
          }
        >
          Connect wallet
        </button>
      ) : null}

      {buyer && holding ? (
        <dl className="facts">
          <div>
            <dt>You hold</dt>
            <dd>
              {String(holding.free)} free{holding.frozen > 0n ? ` · ${holding.frozen} frozen` : ''}
            </dd>
          </div>
          <div>
            <dt>Allowed to hold</dt>
            <dd>{holding.allowlisted && holding.kyc ? '✓ allow-listed, KYC valid' : `✕ ${holding.allowlisted ? 'KYC missing' : 'not on the allowlist'}`}</dd>
          </div>
        </dl>
      ) : null}

      {buyer && holding && !(holding.allowlisted && holding.kyc) && ctx.config.demo ? (
        <button disabled={busy} onClick={() => act('Onboarded: allow-listed with KYC', () => requestOnboarding(ctx, lot.assetId, buyer.address))}>
          Onboard me (demo)
        </button>
      ) : null}

      {listing ? (
        <div className="offer">
          <p>
            <strong>{String(listing.unitsLeft)} units</strong> offered by {shortHex(listing.seller)} at <strong>{coins(listing.pricePerUnit)} HBAR</strong> each.
          </p>
          <div className="row">
            <input aria-label="Units to buy" type="number" min={1} max={Number(listing.unitsLeft)} value={units} onChange={(event) => setUnits(event.target.value)} />
            <button
              disabled={busy || !buyer || count <= 0n || count > listing.unitsLeft || !tradable}
              onClick={() => buyer && act(`Bought ${count} units`, async () => `Bought ${count} units · tx ${shortHex(await buy(ctx, buyer, listing, count), 8, 6)}`)}
            >
              Buy for {coins(count * listing.pricePerUnit)} HBAR
            </button>
          </div>
          <p className="muted">Payment and units swap in one transaction. The token&apos;s compliance module refuses the transfer if the lot is not tradable.</p>
        </div>
      ) : token ? (
        <p className="muted">Nothing is offered on the market right now.</p>
      ) : null}

      {buyer && token && holding && holding.free > 0n && (onChain?.state === 'DELIVERED' || onChain?.state === 'IN_CUSTODY') ? (
        <div className="offer">
          <p>
            {onChain?.state === 'DELIVERED' ? 'The lot was delivered. ' : ''}Redeeming hands in your units in exchange for the goods; the units are burned.
          </p>
          <button className="ghost" disabled={busy} onClick={() => act('Redeemed', async () => `Redeemed ${holding.free} units · tx ${shortHex(await redeem(ctx, buyer, token, holding.free), 8, 6)}`)}>
            Redeem my {String(holding.free)} units
          </button>
        </div>
      ) : null}

      {message ? <p className={`banner banner-${message.tone}`}>{message.text}</p> : null}
    </div>
  );
}
