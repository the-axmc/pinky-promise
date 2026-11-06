export const shortHex = (value: string, head = 6, tail = 4) => (value.length > head + tail + 3 ? `${value.slice(0, head + 2)}…${value.slice(-tail)}` : value);
export const celsius = (centi: number) => `${(centi / 100).toFixed(centi % 100 === 0 ? 0 : 1)} °C`;
export const percent = (centi: number) => `${(centi / 100).toFixed(0)} %`;
export const clock = (unixSeconds: number) => new Date(unixSeconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const dateTime = (unixSeconds: number) => new Date(unixSeconds * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
/** A native-token amount with 18 decimals, trimmed. */
export function coins(value: bigint, digits = 4): string {
  const whole = value / 10n ** 18n;
  const fraction = (value % 10n ** 18n).toString().padStart(18, '0').slice(0, digits).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}
