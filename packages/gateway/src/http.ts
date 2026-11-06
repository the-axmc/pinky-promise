/**
 * The gateway's HTTP API.
 *
 *   /v1/device/*   what a device talks to (see packages/device/src/wire.ts)
 *   /v1/admin/*    the operator: venues, devices, lots, investors, releases (bearer token)
 *   /v1/*          read-only help for the buyer page: network config and episode downloads
 *
 * Device routes need no credentials because everything a device sends is signed, and what it
 * fetches (transactions awaiting its signature) is about to be public anyway.
 */
import { type Address, type Hex, ProtocolError, boxAround } from '@pinky/protocol';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { type Gateway, GatewayError, type NewLot } from './gateway';

export type PublicConfig = {
  /** What the buyer page needs to read the three networks directly. */
  arkiv: { rpcUrl: string; chainId: number; registry: Address; explorerUrl?: string };
  hedera: { rpcUrl: string; chainId: number; oracle: Address; market: Address; explorerUrl?: string };
  zg: { mode: 'router' | 'mock'; model: string; storage: '0g' | 'local'; storageExplorerUrl?: string };
  attestor: Address;
  gateway: Address;
  /** Local demo conveniences (self-service onboarding, view keys) are switched on. */
  demo: boolean;
};

export type AppOptions = {
  publicConfig: PublicConfig;
  /** Required for /v1/admin/*. Without it the admin API is disabled. */
  adminToken?: string;
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

function address(value: unknown, name: string): Address {
  if (typeof value !== 'string' || !ADDRESS.test(value))
    throw new GatewayError(400, `${name} must be an address`);
  return value.toLowerCase() as Address;
}

export function createApp(gateway: Gateway, options: AppOptions): Hono {
  const app = new Hono();
  app.use('*', cors());

  app.onError((error, c) => {
    if (error instanceof GatewayError) {
      return c.json({ error: error.message, ...(error.detail ?? {}) }, error.status as 400);
    }
    if (error instanceof ProtocolError || error instanceof SyntaxError)
      return c.json({ error: error.message }, 400);
    console.error(error);
    return c.json({ error: 'internal error' }, 500);
  });

  app.get('/health', (c) => c.json({ ok: true }));

  // --- device ---------------------------------------------------------------------------------

  app.get('/v1/device/context', async (c) =>
    c.json(await gateway.context(address(c.req.query('device'), 'device'))),
  );

  app.post('/v1/device/readings', async (c) => c.json(await gateway.acceptReading(await c.req.json())));

  app.post('/v1/device/checkpoints', async (c) =>
    c.json(await gateway.acceptCheckpoint(await c.req.json()), 202),
  );

  app.get('/v1/device/checkpoints/:id', (c) => {
    const id = c.req.param('id');
    if (!HASH.test(id)) throw new GatewayError(400, 'checkpoint id must be a 32-byte hash');
    return c.json(gateway.checkpointStatus(address(c.req.query('device'), 'device'), id as Hex));
  });

  app.get('/v1/device/sign-requests', (c) =>
    c.json(gateway.pendingSignRequests(address(c.req.query('device'), 'device'))),
  );

  app.post('/v1/device/signatures', async (c) => {
    const device = address(c.req.query('device'), 'device');
    const submissions = await c.req.json();
    if (!Array.isArray(submissions)) throw new GatewayError(400, 'expected an array of signatures');
    return c.json({ accepted: submissions.map((submission) => gateway.submitSignature(device, submission)) });
  });

  // --- operator -------------------------------------------------------------------------------

  const admin = new Hono();
  admin.use('*', async (c, next) => {
    if (!options.adminToken)
      throw new GatewayError(403, 'the admin API is disabled (no ADMIN_TOKEN configured)');
    if (c.req.header('authorization') !== `Bearer ${options.adminToken}`)
      throw new GatewayError(401, 'bad admin token');
    await next();
  });

  admin.post('/venues', async (c) => {
    const body = await c.req.json();
    // A venue is given either as an explicit box or as a centre and radius.
    const box = body.box ?? boxAround(Number(body.latDeg), Number(body.lonDeg), Number(body.radiusM ?? 150));
    return c.json(
      await gateway.registerVenue({
        venueId: String(body.venueId),
        name: String(body.name ?? body.venueId),
        box,
        ...(body.anchor ? { anchor: address(body.anchor, 'anchor') } : {}),
      }),
    );
  });

  admin.post('/devices', async (c) => {
    const body = await c.req.json();
    return c.json(
      await gateway.enrollDevice({
        certBundle: body.certBundle,
        venueIds: Array.isArray(body.venueIds) ? body.venueIds.map(String) : [],
        label: String(body.label ?? 'device'),
      }),
    );
  });

  admin.post('/lots', async (c) => {
    const body = (await c.req.json()) as NewLot;
    const { viewKey: _viewKey, ...lot } = await gateway.createLot({
      ...body,
      device: address(body.device, 'device'),
      ...(body.depositor ? { depositor: address(body.depositor, 'depositor') } : {}),
    });
    return c.json(lot);
  });

  admin.post('/lots/:assetId/investors', async (c) => {
    const body = await c.req.json();
    await gateway.onboardInvestor(c.req.param('assetId'), address(body.address, 'address'));
    return c.json({ ok: true });
  });

  admin.post('/lots/:assetId/release', async (c) => {
    const body = await c.req.json();
    if (typeof body.inspectionRef !== 'string' || !HASH.test(body.inspectionRef)) {
      throw new GatewayError(
        400,
        'inspectionRef must be a 32-byte hash (for example of the inspection report)',
      );
    }
    return c.json({ txHash: await gateway.release(c.req.param('assetId'), body.inspectionRef) });
  });

  admin.get('/lots/:assetId/view-key', (c) => c.json({ viewKey: gateway.viewKey(c.req.param('assetId')) }));
  admin.get('/status', (c) => c.json(gateway.status()));
  app.route('/v1/admin', admin);

  // --- buyer page -----------------------------------------------------------------------------

  app.get('/v1/config', (c) => c.json(options.publicConfig));

  /** The encrypted episode log, by its 0G Storage root. Useless without the lot's view key. */
  app.get('/v1/episodes/:root', async (c) => {
    const root = c.req.param('root').toLowerCase();
    if (!HASH.test(root)) throw new GatewayError(400, 'root must be a 32-byte hash');
    let bytes: Uint8Array;
    try {
      bytes = await gateway.episodes.get(root as Hex);
    } catch (error) {
      throw new GatewayError(404, (error as Error).message);
    }
    return c.body(bytes as never, 200, {
      'content-type': 'application/octet-stream',
      'cache-control': 'public, max-age=3600',
    });
  });

  if (options.publicConfig.demo) {
    // Demo only: lets a visitor onboard their own wallet and read raw episodes without an operator.
    app.post('/v1/demo/onboard', async (c) => {
      const body = await c.req.json();
      await gateway.onboardInvestor(String(body.assetId), address(body.address, 'address'));
      return c.json({ ok: true });
    });
    app.get('/v1/demo/lots/:assetId/view-key', (c) =>
      c.json({ viewKey: gateway.viewKey(c.req.param('assetId')) }),
    );
    app.get('/v1/demo/status', (c) => c.json(gateway.status()));
  }

  return app;
}
