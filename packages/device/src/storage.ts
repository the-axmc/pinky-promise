import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DeviceState, DeviceStorage } from './device';

/** Keeps device state in memory. For tests. */
export class MemoryStorage implements DeviceStorage {
  #state: DeviceState | undefined;

  constructor(initial?: DeviceState) {
    this.#state = initial ? structuredClone(initial) : undefined;
  }

  load(): DeviceState | undefined {
    return this.#state ? structuredClone(this.#state) : undefined;
  }

  save(state: DeviceState): void {
    this.#state = structuredClone(state);
  }
}

/**
 * Keeps device state in a JSON file, replaced atomically on every save so a crash can never
 * leave a half-written counter behind. Stands in for the ESP32's NVS flash.
 */
export class FileStorage implements DeviceStorage {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  load(): DeviceState | undefined {
    try {
      return JSON.parse(readFileSync(this.#path, 'utf8')) as DeviceState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  save(state: DeviceState): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.tmp`;
    writeFileSync(temporary, JSON.stringify(state));
    renameSync(temporary, this.#path);
  }
}
