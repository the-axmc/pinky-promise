/**
 * Drives a device against a gateway: fetch the context, take and send readings and checkpoints,
 * and answer requests to sign Arkiv transactions. The simulator and a real board use the same
 * loop; only the hardware behind the Device differs.
 */
import { type CheckpointKindValue, type Hex, ProtocolError, checkpointDigest, fromHex, toHex } from '@pinky/protocol';
import type { Device } from './device';
import { type GatewayLink, LinkError } from './link';
import type { ChainAnchor, CheckpointResponse, ReadingResponse } from './wire';

export type RunnerLog = (event: string, detail?: Record<string, unknown>) => void;

export class DeviceRunner {
  readonly device: Device;
  readonly link: GatewayLink;
  readonly #log: RunnerLog;
  #anchor: ChainAnchor | undefined;

  constructor(device: Device, link: GatewayLink, log: RunnerLog = () => {}) {
    this.device = device;
    this.link = link;
    this.#log = log;
  }

  /** Fetches the gateway's context: a fresh anchor block, and the lot assignment if there is one. */
  async sync(): Promise<void> {
    const context = await this.link.context(this.device.address);
    this.#anchor = context.arkiv.anchor;
    if (context.profile && context.profile.payload !== this.#adopted) {
      const profile = this.device.setProfile(context.profile); // throws unless the registry signed it
      this.#adopted = context.profile.payload;
      this.#log('profile.adopted', { assetId: profile.assetId });
    }
  }
  #adopted: Hex | undefined;

  async #freshAnchor(): Promise<ChainAnchor> {
    await this.sync();
    if (!this.#anchor) throw new ProtocolError('the gateway gave no anchor block');
    return this.#anchor;
  }

  /** Takes one reading and sends it. */
  async reading(): Promise<ReadingResponse> {
    const request = await this.device.takeReading(await this.#freshAnchor());
    const response = await this.link.postReading(request);
    this.#log('reading.sent', { seq: this.device.seq, digest: response.digest });
    return response;
  }

  /** Takes a checkpoint and sends it, first resending any readings the gateway says it lacks. */
  async checkpoint(kind: CheckpointKindValue): Promise<CheckpointResponse> {
    const request = await this.device.takeCheckpoint(kind, await this.#freshAnchor());
    const id = toHex(checkpointDigest(fromHex(request.payload)));
    try {
      const response = await this.link.postCheckpoint(request);
      this.#log('checkpoint.sent', { id, status: response.status });
      return response;
    } catch (error) {
      const missing = error instanceof LinkError && error.status === 409 ? (error.detail.missing as number[] | undefined) : undefined;
      if (!missing?.length) throw error;
      this.#log('checkpoint.resending', { missing });
      for (const seq of missing) {
        const stored = this.device.storedReading(seq);
        if (stored) await this.link.postReading(stored);
      }
      const response = await this.link.postCheckpoint(request);
      this.#log('checkpoint.sent', { id, status: response.status });
      return response;
    }
  }

  /** Signs (or refuses) every Arkiv transaction waiting for this device. Returns how many. */
  async serviceSignRequests(): Promise<number> {
    const requests = await this.link.signRequests(this.device.address);
    if (requests.length === 0) return 0;
    const submissions = [];
    for (const request of requests) {
      const submission = await this.device.sign(request);
      if ('refused' in submission) this.#log('sign.refused', { purpose: request.purpose, reason: submission.refused });
      else this.#log('sign.approved', { purpose: request.purpose });
      submissions.push(submission);
    }
    await this.link.postSignatures(this.device.address, submissions);
    return requests.length;
  }

  /** Keeps answering sign requests in the background. Returns a function that stops it. */
  startSigning(pollMs = 250): () => Promise<void> {
    let stopped = false;
    const loop = (async () => {
      while (!stopped) {
        try {
          await this.serviceSignRequests();
        } catch (error) {
          this.#log('sign.error', { error: (error as Error).message });
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    })();
    return async () => {
      stopped = true;
      await loop;
    };
  }

  /**
   * Polls a checkpoint until it is no longer PENDING, or until the timeout. Resolves with the
   * last status either way: PENDING after a timeout simply means "still not accepted".
   */
  async awaitDecision(id: Hex, options: { timeoutMs?: number; pollMs?: number } = {}): Promise<CheckpointResponse> {
    const deadline = Date.now() + (options.timeoutMs ?? 60_000);
    let status = await this.link.checkpoint(this.device.address, id);
    while (status.status === 'PENDING' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 300));
      status = await this.link.checkpoint(this.device.address, id);
    }
    this.device.showStatus(status);
    return status;
  }
}
