/**
 * The controls of a hosted demo. They exist only where the page is served by `pnpm showcase`; a
 * plain gateway answers 404 here and the page simply has no controls.
 */
export type JourneyStatus = {
  mode: 'stand-in' | 'live';
  steps: Array<{ title: string; does: string; look: string }>;
  step: number;
  running: string | null;
  assetId: string | null;
  log: string[];
  error: string | null;
  driving: 'open' | 'key' | 'off';
  decisions: string;
};

export async function fetchJourney(gatewayUrl: string): Promise<JourneyStatus | undefined> {
  const response = await fetch(`${gatewayUrl}/v1/showcase`);
  return response.ok ? ((await response.json()) as JourneyStatus) : undefined;
}

export async function driveJourney(
  gatewayUrl: string,
  action: 'next' | 'restart',
  key: string | undefined,
): Promise<void> {
  const response = await fetch(`${gatewayUrl}/v1/showcase/${action}`, {
    method: 'POST',
    ...(key ? { headers: { 'x-drive-key': key } } : {}),
  });
  if (response.ok) return;
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? `the demo answered ${response.status}`);
}

/** The key from `?drive=<key>`, kept for the tab so the address bar can be shared without it. */
export function driveKeyFromPage(): string | undefined {
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get('drive');
    if (fromUrl) {
      sessionStorage.setItem('pinky-drive-key', fromUrl);
      url.searchParams.delete('drive');
      window.history.replaceState(null, '', url);
      return fromUrl;
    }
    return sessionStorage.getItem('pinky-drive-key') ?? undefined;
  } catch {
    return undefined;
  }
}
