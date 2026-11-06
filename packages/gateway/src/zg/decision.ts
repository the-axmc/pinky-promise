/**
 * The decision in the loop: at a custody checkpoint a 0G vision model looks at the seal and at
 * a summary of the signed readings and decides whether the handoff can be accepted.
 *
 * It talks to the 0G Compute Router, which is OpenAI-compatible:
 *   POST {base}/chat/completions   Authorization: Bearer sk-…
 * and returns, next to the usual fields, an `x_0g_trace` object with the request id and the
 * provider that served the call.
 *
 * The rule this file exists to enforce: no decision is ever invented. Any failure — network,
 * billing, a model that answers something that is not a decision — throws {@link ZgUnavailable}
 * and the caller leaves the checkpoint PENDING. There is no fallback model and no default.
 */
import type { CheckpointKindName, LotStateName, ReadingSummary, SealEvidence } from '@pinky/protocol';
import { sealReportsTamper } from '@pinky/protocol';

export type ZgDecisionConfig = {
  /** "router": the real 0G Compute Router. "mock": the local stand-in from @pinky/devnet. */
  mode: 'router' | 'mock';
  /** e.g. https://router-api.0g.ai/v1 */
  baseUrl: string;
  apiKey: string;
  /** A model that accepts image input, e.g. qwen2.5-vl-72b-instruct. */
  model: string;
  /** Ask the Router to verify the provider's TEE signature before answering. */
  verifyTee?: boolean;
  timeoutMs?: number;
};

export type DecisionInput = {
  assetId: string;
  kind: CheckpointKindName;
  /** The lot's custody state before this checkpoint. */
  state: LotStateName;
  summary: ReadingSummary;
  seal: SealEvidence;
  photo?: { mime: string; bytes: Uint8Array };
  /** Whether a venue anchor co-signed, and for which venue. */
  anchor: { present: boolean; venueId?: string };
  /** Whether the last reading was proven to be inside a venue's geofence. */
  geofence: { proven: boolean; venueId?: string };
};

export type DecisionName = 'ACCEPT_CUSTODY' | 'REJECT' | 'ESCALATE';

export type DecisionResult = {
  decision: DecisionName;
  reason: string;
  /** The 0G request id for this decision. */
  requestId: string;
  model: string;
  provider?: string;
  /** Present only when TEE verification was requested. */
  teeVerified?: boolean | null;
  source: '0g-router' | 'dev-mock';
  prompt: { system: string; user: string };
  rawAnswer: string;
  latencyMs: number;
};

/** Why there is no decision. Every kind means the same thing downstream: stay PENDING. */
export type ZgFailureKind =
  /** Could not reach 0G, or it answered 5xx / 429. Worth retrying. */
  | 'unreachable'
  /** 0G refused the request: bad key, no balance, model cannot take images. Needs an operator. */
  | 'refused'
  /** 0G answered, but not with a usable decision. Retried, never guessed. */
  | 'undecided'
  /** The answer failed TEE verification, or came from a stand-in while in router mode. */
  | 'untrusted';

export class ZgUnavailable extends Error {
  readonly kind: ZgFailureKind;
  readonly requestId: string | undefined;

  constructor(kind: ZgFailureKind, message: string, requestId?: string) {
    super(message);
    this.name = 'ZgUnavailable';
    this.kind = kind;
    this.requestId = requestId;
  }
}

export const DECISION_SYSTEM_PROMPT = `You are the custody inspector for a cold-chain shipment. At a handoff you decide whether custody of the lot can be accepted.

You are given a photo of the lot's tamper seal (when one was taken) and a JSON description of the handoff. The sensor readings in it were signed by the device and are facts: do not question them, and do not certify them either. Your job is the operational decision.

Decide exactly one of:
- "ACCEPT_CUSTODY": the seal is intact and every reading is within limits.
- "REJECT": the seal is broken, missing or tampered with, or the hardware reports tampering, or any reading is out of range.
- "ESCALATE": you cannot tell - the photo is unclear or does not show a seal, the evidence is contradictory, or readings are missing.

Answer with a single JSON object and nothing else:
{"decision": "ACCEPT_CUSTODY" | "REJECT" | "ESCALATE", "seal": "intact" | "broken" | "unclear" | "not_shown", "reason": "<one or two sentences a warehouse operator can act on>"}`;

/** The handoff description the model receives next to the photo. */
export function buildUserPrompt(input: DecisionInput): string {
  const handoff = {
    lot: input.assetId,
    handoff: input.kind,
    custody_state_before: input.state,
    readings: {
      count: input.summary.count,
      missing: input.summary.missingSeqs,
      span_seconds: input.summary.spanSeconds,
      temperature_c: { min: input.summary.tempMinC, max: input.summary.tempMaxC, mean: input.summary.tempMeanC },
      humidity_pct: { min: input.summary.rhMinPct, max: input.summary.rhMaxPct },
      limits: input.summary.limits,
      out_of_range: input.summary.outOfRange,
      worst_temperature_excursion_c: input.summary.worstTempExcursionC,
    },
    seal: {
      photo_attached: Boolean(input.photo),
      hardware_reports_tamper: sealReportsTamper(input.seal),
      nfc_tag: input.seal.nfc ? { tamper_loop: input.seal.nfc.tamper ?? 'unknown' } : null,
      enclosure_closed: input.seal.enclosure?.closed ?? null,
    },
    location: {
      venue_anchor_cosigned: input.anchor.present,
      geofence_proven: input.geofence.proven,
      venue: input.anchor.venueId ?? input.geofence.venueId ?? null,
    },
  };
  return `Handoff to decide:\n${JSON.stringify(handoff, null, 2)}`;
}

const DECISIONS: readonly DecisionName[] = ['ACCEPT_CUSTODY', 'REJECT', 'ESCALATE'];

/** Extracts the decision from the model's answer. Returns undefined if there is none. */
export function parseDecision(content: string): { decision: DecisionName; reason: string } | undefined {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { decision, reason } = parsed as { decision?: unknown; reason?: unknown };
  if (typeof decision !== 'string' || typeof reason !== 'string') return undefined;
  const normalized = decision.trim().toUpperCase() as DecisionName;
  if (!DECISIONS.includes(normalized) || reason.trim().length === 0) return undefined;
  return { decision: normalized, reason: reason.trim().slice(0, 600) };
}

export type ZgPreflight = { ok: boolean; problems: string[]; acceptsImages?: boolean; jsonMode?: boolean };

export class ZgDecisionClient {
  readonly config: ZgDecisionConfig;
  readonly #fetch: typeof fetch;
  #jsonMode: boolean | undefined;

  constructor(config: ZgDecisionConfig, fetchImpl: typeof fetch = fetch) {
    this.config = { ...config, baseUrl: config.baseUrl.replace(/\/$/, '') };
    this.#fetch = fetchImpl;
  }

  /** Checks, without spending anything, that the configured model exists and takes images. */
  async preflight(): Promise<ZgPreflight> {
    const problems: string[] = [];
    try {
      const response = await this.#fetch(`${this.config.baseUrl}/models`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return { ok: false, problems: [`model catalog answered HTTP ${response.status}`] };
      const catalog = (await response.json()) as { data?: Array<Record<string, any>> };
      const model = catalog.data?.find((entry) => entry.id === this.config.model);
      if (!model) return { ok: false, problems: [`model "${this.config.model}" is not in the 0G catalog`] };
      const acceptsImages = Boolean(model.architecture?.input_modalities?.includes('image'));
      const jsonMode = Boolean(model.supported_parameters?.includes('response_format'));
      if (!acceptsImages) problems.push(`model "${this.config.model}" does not accept image input`);
      if (!this.config.apiKey) problems.push('ZG_API_KEY is not set');
      this.#jsonMode = jsonMode;
      return { ok: problems.length === 0, problems, acceptsImages, jsonMode };
    } catch (error) {
      return { ok: false, problems: [`0G is unreachable: ${(error as Error).message}`] };
    }
  }

  /** Asks 0G for a decision. Resolves with one, or throws {@link ZgUnavailable}. Never guesses. */
  async decide(input: DecisionInput): Promise<DecisionResult> {
    const prompt = { system: DECISION_SYSTEM_PROMPT, user: buildUserPrompt(input) };
    const userContent: unknown[] = [{ type: 'text', text: prompt.user }];
    if (input.photo) {
      const base64 = Buffer.from(input.photo.bytes).toString('base64');
      userContent.push({ type: 'image_url', image_url: { url: `data:${input.photo.mime};base64,${base64}` } });
    }
    const body: Record<string, unknown> = {
      model: this.config.model,
      temperature: 0,
      max_tokens: 400,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: userContent },
      ],
    };
    if (this.#jsonMode !== false) body.response_format = { type: 'json_object' };
    if (this.config.verifyTee) body.verify_tee = true;

    const started = Date.now();
    let response: Response;
    try {
      response = await this.#fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 60_000),
      });
    } catch (error) {
      throw new ZgUnavailable('unreachable', `0G is unreachable: ${(error as Error).message}`);
    }
    const latencyMs = Date.now() - started;

    const text = await response.text();
    let payload: Record<string, any> | undefined;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
    const requestId: string | undefined =
      payload?.x_0g_trace?.request_id ?? payload?.request_id ?? response.headers.get('zg-res-key') ?? payload?.id;

    if (!response.ok) {
      const code = payload?.error?.code ?? payload?.error?.type ?? `HTTP ${response.status}`;
      const detail = `0G answered ${response.status} (${code}): ${String(payload?.error?.message ?? text).slice(0, 200)}`;
      // 429 and 5xx pass; 4xx means this request will keep failing until someone fixes it.
      const kind: ZgFailureKind = response.status === 429 || response.status >= 500 ? 'unreachable' : 'refused';
      throw new ZgUnavailable(kind, detail, requestId);
    }
    if (!payload) throw new ZgUnavailable('undecided', '0G answered with something that is not JSON', requestId);

    const isStandIn = payload.x_0g_trace?.mock === true;
    if (isStandIn && this.config.mode !== 'mock') {
      throw new ZgUnavailable('untrusted', 'the answer came from a stand-in, but the gateway is in router mode', requestId);
    }
    const teeVerified: boolean | null | undefined = payload.x_0g_trace?.tee_verified;
    if (this.config.verifyTee && teeVerified !== true) {
      throw new ZgUnavailable('untrusted', `TEE verification was requested and came back ${teeVerified}`, requestId);
    }
    if (!requestId) throw new ZgUnavailable('undecided', '0G answered without a request id', undefined);

    const rawAnswer: string = payload.choices?.[0]?.message?.content ?? '';
    const parsed = parseDecision(typeof rawAnswer === 'string' ? rawAnswer : '');
    if (!parsed) {
      throw new ZgUnavailable('undecided', `the model did not return a decision: ${String(rawAnswer).slice(0, 160)}`, requestId);
    }

    return {
      ...parsed,
      requestId,
      model: payload.model ?? this.config.model,
      ...(payload.x_0g_trace?.provider ? { provider: String(payload.x_0g_trace.provider) } : {}),
      ...(teeVerified !== undefined ? { teeVerified } : {}),
      source: this.config.mode === 'mock' ? 'dev-mock' : '0g-router',
      prompt,
      rawAnswer,
      latencyMs,
    };
  }
}
