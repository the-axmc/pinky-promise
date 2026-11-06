/**
 * The mailbox between the gateway and a device for Arkiv transactions the device has to sign.
 *
 * The gateway puts an unsigned transaction in; the device fetches it on its next poll, reviews
 * it against its signing policy and posts a signature (or a refusal) back. Nothing is broadcast
 * until then, so a request that times out or is refused has had no effect on chain.
 */
import { randomUUID } from 'node:crypto';
import type { Address } from '@pinky/protocol';
import type { SignRequest, SignatureSubmission, TransactionSignature, UnsignedTransaction } from '@pinky/device';

export class DeviceRefusedError extends Error {
  constructor(reason: string) {
    super(`the device refused to sign: ${reason}`);
    this.name = 'DeviceRefusedError';
  }
}

export class DeviceTimeoutError extends Error {
  constructor(seconds: number) {
    super(`the device did not sign within ${seconds} s`);
    this.name = 'DeviceTimeoutError';
  }
}

type Pending = {
  device: Address;
  request: SignRequest;
  resolve(signature: TransactionSignature): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

export class SignRequestQueue {
  readonly #pending = new Map<string, Pending>();
  readonly #timeoutMs: number;

  constructor(timeoutMs = 120_000) {
    this.#timeoutMs = timeoutMs;
  }

  /** Queues a transaction for a device and resolves with its signature. */
  request(device: Address, purpose: SignRequest['purpose'], transaction: UnsignedTransaction): Promise<TransactionSignature> {
    const id = randomUUID();
    return new Promise<TransactionSignature>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new DeviceTimeoutError(this.#timeoutMs / 1000));
      }, this.#timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { device: device.toLowerCase() as Address, request: { id, purpose, transaction }, resolve, reject, timer });
    });
  }

  /** The requests waiting for a device. */
  pendingFor(device: Address): SignRequest[] {
    const wanted = device.toLowerCase();
    return [...this.#pending.values()].filter((entry) => entry.device === wanted).map((entry) => entry.request);
  }

  /** Delivers a device's answer. Returns false if the request is unknown, expired or not its own. */
  submit(device: Address, submission: SignatureSubmission): boolean {
    const entry = this.#pending.get(submission.id);
    if (!entry || entry.device !== device.toLowerCase()) return false;
    clearTimeout(entry.timer);
    this.#pending.delete(submission.id);
    if ('refused' in submission) entry.reject(new DeviceRefusedError(submission.refused));
    else entry.resolve(submission.signature);
    return true;
  }

  get size(): number {
    return this.#pending.size;
  }
}
