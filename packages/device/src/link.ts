/**
 * The device's connection to a gateway, over HTTP. A BLE transport would implement the same
 * six calls.
 */
import type { Address, Hex } from '@pinky/protocol';
import type {
  CheckpointRequest,
  CheckpointResponse,
  DeviceContext,
  ReadingRequest,
  ReadingResponse,
  SignRequest,
  SignatureSubmission,
} from './wire';

/** The gateway answered, but with a refusal. `detail` carries what it said (e.g. missing seqs). */
export class LinkError extends Error {
  readonly status: number;
  readonly detail: Record<string, unknown>;

  constructor(status: number, detail: Record<string, unknown>) {
    super(`gateway answered ${status}: ${String(detail.error ?? 'request refused')}`);
    this.name = 'LinkError';
    this.status = status;
    this.detail = detail;
  }
}

export interface GatewayLink {
  context(device: Address): Promise<DeviceContext>;
  postReading(request: ReadingRequest): Promise<ReadingResponse>;
  postCheckpoint(request: CheckpointRequest): Promise<CheckpointResponse>;
  checkpoint(device: Address, id: Hex): Promise<CheckpointResponse>;
  signRequests(device: Address): Promise<SignRequest[]>;
  postSignatures(device: Address, submissions: SignatureSubmission[]): Promise<void>;
}

export class HttpGatewayLink implements GatewayLink {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(baseUrl: string, fetchImpl: typeof fetch = fetch) {
    this.#baseUrl = baseUrl.replace(/\/$/, '');
    this.#fetch = fetchImpl;
  }

  async #call<T>(path: string, body?: unknown): Promise<T> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { error: text.slice(0, 200) };
    }
    if (!response.ok) throw new LinkError(response.status, parsed as Record<string, unknown>);
    return parsed as T;
  }

  context(device: Address) {
    return this.#call<DeviceContext>(`/v1/device/context?device=${device}`);
  }

  postReading(request: ReadingRequest) {
    return this.#call<ReadingResponse>('/v1/device/readings', request);
  }

  postCheckpoint(request: CheckpointRequest) {
    return this.#call<CheckpointResponse>('/v1/device/checkpoints', request);
  }

  checkpoint(device: Address, id: Hex) {
    return this.#call<CheckpointResponse>(`/v1/device/checkpoints/${id}?device=${device}`);
  }

  signRequests(device: Address) {
    return this.#call<SignRequest[]>(`/v1/device/sign-requests?device=${device}`);
  }

  async postSignatures(device: Address, submissions: SignatureSubmission[]) {
    await this.#call(`/v1/device/signatures?device=${device}`, submissions);
  }
}
