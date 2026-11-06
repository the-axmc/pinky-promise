/**
 * The real transport: a USB serial port. `serialport` is loaded only here, so nothing else in
 * the package needs a serial library (or a board) to run.
 */
import type { LineTransport } from './client';

export async function listSerialPorts(): Promise<
  Array<{ path: string; manufacturer?: string; vendorId?: string; productId?: string }>
> {
  const { SerialPort } = await import('serialport');
  return SerialPort.list();
}

/** Opens a board's serial port. On macOS an ESP32-S3 shows up as /dev/cu.usbmodem… */
export async function openSerialTransport(path: string, baudRate = 115_200): Promise<LineTransport> {
  const { SerialPort, ReadlineParser } = await import('serialport');
  const port = new SerialPort({ path, baudRate, autoOpen: false });
  await new Promise<void>((resolve, reject) => port.open((error) => (error ? reject(error) : resolve())));
  const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
  return {
    send: (line) => void port.write(`${line}\n`),
    onLine: (listener) => void parser.on('data', (line: string) => listener(line)),
    close: () => new Promise<void>((resolve) => (port.isOpen ? port.close(() => resolve()) : resolve())),
  };
}
