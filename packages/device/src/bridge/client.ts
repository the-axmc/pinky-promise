/**
 * The host end of the board bridge: frames requests as JSON lines, matches responses by id,
 * and times out a board that stops answering. It works over any line transport; serial.ts
 * provides the real one and mock-board.ts an in-process one for tests.
 */
import { type BoardCommand, type BoardCommands, BoardError, type BoardInfo } from './protocol';

/** Something that carries text lines both ways. */
export interface LineTransport {
  send(line: string): void;
  onLine(listener: (line: string) => void): void;
  close(): Promise<void>;
}

type Waiting = {
  command: string;
  resolve(value: any): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

export class BoardClient {
  readonly #transport: LineTransport;
  readonly #waiting = new Map<number, Waiting>();
  readonly #onLog: ((line: string) => void) | undefined;
  #nextId = 1;
  #info: BoardInfo | undefined;
  #closed = false;

  constructor(transport: LineTransport, options: { onLog?: (line: string) => void } = {}) {
    this.#transport = transport;
    this.#onLog = options.onLog;
    transport.onLine((line) => this.#receive(line));
  }

  #receive(raw: string): void {
    const line = raw.trim();
    if (!line.startsWith('{')) {
      if (line) this.#onLog?.(line);
      return;
    }
    let message: { id?: number; ok?: boolean; error?: string } & Record<string, unknown>;
    try {
      message = JSON.parse(line);
    } catch {
      this.#onLog?.(`(unparseable) ${line.slice(0, 120)}`);
      return;
    }
    const waiting = typeof message.id === 'number' ? this.#waiting.get(message.id) : undefined;
    if (!waiting) return;
    clearTimeout(waiting.timer);
    this.#waiting.delete(message.id as number);
    if (message.ok) {
      const { id: _id, ok: _ok, ...result } = message;
      waiting.resolve(result);
    } else {
      waiting.reject(new BoardError(waiting.command, String(message.error ?? 'failed')));
    }
  }

  /** Sends one command and resolves with its response. */
  request<C extends BoardCommand>(
    command: C,
    params: BoardCommands[C]['request'] = {} as BoardCommands[C]['request'],
    timeoutMs = 5_000,
  ): Promise<BoardCommands[C]['response']> {
    if (this.#closed) return Promise.reject(new BoardError(command, 'connection closed'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id);
        reject(new BoardError(command, `no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      this.#waiting.set(id, { command, resolve, reject, timer });
      this.#transport.send(JSON.stringify({ id, cmd: command, ...params }));
    });
  }

  /** What the board is and which parts it has. Fetched once. */
  async info(): Promise<BoardInfo> {
    this.#info ??= await this.request('info', {}, 3_000);
    return this.#info;
  }

  /**
   * Waits for the board to answer. Opening a serial port resets most ESP32 boards, so the first
   * requests can fall into the boot sequence; this keeps asking until the firmware is up.
   */
  async waitReady(timeoutMs = 10_000): Promise<BoardInfo> {
    const deadline = Date.now() + timeoutMs;
    let last: Error | undefined;
    while (!this.#closed && Date.now() < deadline) {
      try {
        this.#info = await this.request('info', {}, Math.min(1_000, Math.max(100, deadline - Date.now())));
        return this.#info;
      } catch (error) {
        last = error as Error;
      }
    }
    throw new BoardError(
      'info',
      `the board did not answer within ${timeoutMs} ms (${last?.message ?? 'no response'})`,
    );
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const [id, waiting] of this.#waiting) {
      clearTimeout(waiting.timer);
      waiting.reject(new BoardError(waiting.command, 'connection closed'));
      this.#waiting.delete(id);
    }
    await this.#transport.close();
  }
}
