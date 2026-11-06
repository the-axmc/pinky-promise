/**
 * A local stand-in for the 0G Compute Router, for development without 0G credits.
 *
 * It speaks the same OpenAI-compatible protocol (GET /v1/models, POST /v1/chat/completions) and
 * returns an `x_0g_trace` like the Router's — but it is NOT 0G and it does not look at images.
 * It recognises the simulator's two bundled seal pictures by their hash and otherwise applies
 * the decision rules mechanically. Every answer is marked `x_0g_trace.mock: true`; the gateway
 * records such decisions as "dev-mock" and refuses them outright when it is in router mode.
 *
 * It is only ever reached because the gateway was configured to use it. It is not a fallback:
 * when the real Router is unreachable the gateway leaves the checkpoint PENDING.
 */
import { createHash, randomUUID } from 'node:crypto';
import { type Server, createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../anvil';

export const MOCK_MODEL = 'mock-vision';

/** How the stand-in behaves; switch it to rehearse the gateway's safe stop. */
export type MockMode =
  /** Answers with a decision. */
  | 'up'
  /** Answers 503 like a Router with no healthy provider. */
  | 'down'
  /** Answers 200 with prose that contains no decision. */
  | 'garbage'
  /** Answers 402 like a Router account with no balance. */
  | 'no-balance';

export type MockZgRouter = {
  /** Give this to the gateway as ZG_ROUTER_URL. */
  baseUrl: string;
  mode: MockMode;
  setMode(mode: MockMode): void;
  /** Every chat request received, newest last. */
  requests: Array<{ at: number; hasImage: boolean; decision?: string }>;
  stop(): Promise<void>;
};

const SEALS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../device/assets');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function knownSeals(): Record<string, 'intact' | 'broken'> {
  const known: Record<string, 'intact' | 'broken'> = {};
  for (const condition of ['intact', 'broken'] as const) {
    try {
      known[sha256(readFileSync(resolve(SEALS, `seal-${condition}.png`)))] = condition;
    } catch {
      // The simulator's pictures are optional; without them every photo is "unclear".
    }
  }
  return known;
}

type Handoff = {
  readings?: { out_of_range?: number; missing?: number };
  seal?: { photo_attached?: boolean; hardware_reports_tamper?: boolean };
};

function decide(handoff: Handoff, seal: 'intact' | 'broken' | 'unclear' | 'not_shown') {
  const outOfRange = handoff.readings?.out_of_range ?? 0;
  if (seal === 'broken') return { decision: 'REJECT', seal, reason: 'The tamper seal is torn and the carton has been opened.' };
  if (handoff.seal?.hardware_reports_tamper) {
    return { decision: 'REJECT', seal, reason: 'The seal hardware reports tampering.' };
  }
  if (outOfRange > 0) {
    return { decision: 'REJECT', seal, reason: `${outOfRange} reading(s) were outside the allowed range.` };
  }
  if (seal === 'unclear') return { decision: 'ESCALATE', seal, reason: 'The photo does not clearly show the seal.' };
  if (seal === 'not_shown') return { decision: 'ESCALATE', seal, reason: 'No seal evidence was provided.' };
  if ((handoff.readings?.missing ?? 0) > 0) {
    return { decision: 'ESCALATE', seal, reason: 'Some readings are missing from the window.' };
  }
  return { decision: 'ACCEPT_CUSTODY', seal, reason: 'The seal is intact and every reading is within limits.' };
}

export async function startMockZgRouter(options: { port?: number } = {}): Promise<MockZgRouter> {
  const port = options.port ?? (await freePort());
  const seals = knownSeals();
  const state: MockZgRouter = {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    mode: 'up',
    setMode(mode) {
      state.mode = mode;
    },
    requests: [],
    stop: () => new Promise((done) => server.close(() => done())),
  };

  const json = (res: import('node:http').ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return json(res, 200, {
        object: 'list',
        data: [
          {
            id: MOCK_MODEL,
            object: 'model',
            owned_by: 'pinky-promise devnet (not 0G)',
            type: 'chatbot',
            architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
            supported_parameters: ['temperature', 'max_tokens', 'response_format'],
          },
        ],
      });
    }
    if (req.method === 'POST' && url.pathname === '/__mock/mode') {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const mode = JSON.parse(raw || '{}').mode as MockMode;
        if (!['up', 'down', 'garbage', 'no-balance'].includes(mode)) return json(res, 400, { error: 'unknown mode' });
        state.setMode(mode);
        json(res, 200, { mode });
      });
      return;
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      return json(res, 404, { error: { type: 'not_found_error', code: 'not_found', message: 'no such route' } });
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const requestId = `mock-${randomUUID()}`;
      if (!/^Bearer \S+/.test(req.headers.authorization ?? '')) {
        return json(res, 401, { error: { type: 'invalid_request_error', code: 'missing_authorization', message: 'no API key' }, request_id: requestId });
      }
      if (state.mode === 'down') {
        state.requests.push({ at: Date.now(), hasImage: false });
        return json(res, 503, { error: { type: 'server_error', code: 'no_available_provider', message: 'no healthy provider' }, request_id: requestId });
      }
      if (state.mode === 'no-balance') {
        state.requests.push({ at: Date.now(), hasImage: false });
        return json(res, 402, { error: { type: 'payment_error', code: 'insufficient_balance', message: 'deposit more 0G' }, request_id: requestId });
      }

      let body: any;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return json(res, 400, { error: { type: 'invalid_request_error', code: 'invalid_body', message: 'not JSON' }, request_id: requestId });
      }
      const user = [...(body.messages ?? [])].reverse().find((message: any) => message.role === 'user');
      const parts: any[] = Array.isArray(user?.content) ? user.content : [{ type: 'text', text: String(user?.content ?? '') }];
      const text = parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
      const image = parts.find((part) => part.type === 'image_url')?.image_url?.url as string | undefined;

      let seal: 'intact' | 'broken' | 'unclear' | 'not_shown' = 'not_shown';
      if (image) {
        const base64 = image.slice(image.indexOf(',') + 1);
        seal = seals[sha256(Buffer.from(base64, 'base64'))] ?? 'unclear';
      }
      let handoff: Handoff = {};
      try {
        handoff = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      } catch {
        // No machine-readable handoff: decide on the seal alone.
      }
      // An NFC tag or enclosure switch is seal evidence too, even without a photo.
      if (seal === 'not_shown' && handoff.seal && handoff.seal.hardware_reports_tamper === false && !handoff.seal.photo_attached) {
        seal = 'intact';
      }

      const answer = decide(handoff, seal);
      const content = state.mode === 'garbage' ? 'Looks fine to me, I would probably let it through.' : JSON.stringify(answer);
      state.requests.push({ at: Date.now(), hasImage: Boolean(image), decision: state.mode === 'garbage' ? undefined : answer.decision });
      json(
        res,
        200,
        {
          id: `chatcmpl-${requestId}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: MOCK_MODEL,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          x_0g_trace: {
            request_id: requestId,
            provider: `0x${'00'.repeat(20)}`,
            billing: { input_cost: '0', output_cost: '0', total_cost: '0' },
            mock: true,
            ...(body.verify_tee ? { tee_verified: false } : {}),
          },
        },
        { 'zg-res-key': requestId },
      );
    });
  });

  await new Promise<void>((ready, failed) => {
    server.once('error', failed);
    server.listen(port, '127.0.0.1', () => ready());
  });
  return state;
}
