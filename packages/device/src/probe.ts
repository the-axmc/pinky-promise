/**
 * Bring-up check for a board: asks every part it reports to do its job once and says, part by
 * part, whether it worked. The first thing to run after wiring something.
 */
import { writeFileSync } from 'node:fs';
import {
  type Hex,
  addressFromPublicKey,
  fromHex,
  p256Verify,
  randomBytes,
  secpRecover,
  sha256,
  toHex,
  verifyAnchorAttestation,
} from '@pinky/protocol';
import type { BoardClient } from './bridge/client';
import { BoardAnchor, BoardSecureElement, BoardWallet } from './bridge/hardware';
import { BoardError, type BoardInfo } from './bridge/protocol';

/** `ok`: true = works, false = present but failing, null = not on this board. */
export type ProbeRow = { part: string; ok: boolean | null; detail: string };

const reason = (error: unknown) => (error instanceof BoardError ? error.reason : (error as Error).message);

export async function probeBoard(
  board: BoardClient,
  options: { savePhotoTo?: string; nfcTimeoutMs?: number } = {},
): Promise<{ info: BoardInfo; rows: ProbeRow[] }> {
  const info = await board.info();
  const rows: ProbeRow[] = [];
  const digest = sha256(randomBytes(32));
  const check = async (
    part: string,
    present: boolean,
    run: () => Promise<string | { ok: boolean; detail: string }>,
  ) => {
    if (!present) return void rows.push({ part, ok: null, detail: 'not detected' });
    try {
      const result = await run();
      rows.push(typeof result === 'string' ? { part, ok: true, detail: result } : { part, ...result });
    } catch (error) {
      rows.push({ part, ok: false, detail: reason(error) });
    }
  };

  if (info.role === 'device') {
    await check('SHT31 (climate)', info.has.sht31, async () => {
      const { temp_centi, rh_centi } = await board.request('climate.read');
      return `${(temp_centi / 100).toFixed(2)} °C, ${(rh_centi / 100).toFixed(2)} %RH`;
    });

    await check('GPS', info.has.gps, async () => {
      const gps = await board.request('gps.read');
      if (gps.fix && gps.lat_e7 !== undefined && gps.lon_e7 !== undefined) {
        const age = gps.age_ms === undefined ? '' : `, ${(gps.age_ms / 1000).toFixed(1)} s old`;
        return `fix ${(gps.lat_e7 / 1e7).toFixed(7)}, ${(gps.lon_e7 / 1e7).toFixed(7)} (${gps.sats ?? '?'} satellites${age})`;
      }
      if (gps.chars === 0)
        return { ok: false, detail: 'nothing received from the module — check RX/TX and the baud rate' };
      return `module is talking, no fix yet (${gps.sats ?? 0} satellites) — it needs open sky`;
    });

    await check('ATECC608B (secure element)', info.has.atecc608b, async () => {
      const element = new BoardSecureElement(board);
      let publicKey: Uint8Array;
      try {
        publicKey = await element.publicKey();
      } catch (error) {
        if (/not provisioned/.test(reason(error))) {
          return {
            ok: false,
            detail: 'found, but blank — provision it once with `pnpm device provision-se` (irreversible)',
          };
        }
        throw error;
      }
      const signature = await element.sign(digest);
      if (!p256Verify(digest, signature, publicKey))
        return { ok: false, detail: 'its signature does not verify against its public key' };
      return `serial ${await element.serial()}, signs and verifies (P-256)`;
    });

    await check('device wallet', info.has.wallet, async () => {
      const wallet = new BoardWallet(board);
      const address = await wallet.address();
      const signature = await wallet.signDigest(digest);
      if (secpRecover(digest, signature).address !== address)
        return { ok: false, detail: 'signature does not recover to the wallet' };
      return `address ${address}, signs and recovers (secp256k1)`;
    });

    await check('camera', info.has.camera, async () => {
      const { mime, data } = await board.request('camera.capture', {}, 20_000);
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length === 0) return { ok: false, detail: 'empty frame' };
      if (options.savePhotoTo) writeFileSync(options.savePhotoTo, bytes);
      return `${mime}, ${bytes.length} bytes${options.savePhotoTo ? `, saved to ${options.savePhotoTo}` : ''}`;
    });

    await check('PN532 (NFC)', info.has.pn532, async () => {
      const timeout = options.nfcTimeoutMs ?? 2_000;
      const tag = await board.request('nfc.read', { timeout_ms: timeout }, timeout + 4_000);
      if (!tag.present) return 'reader answers; no tag in the field right now';
      return `tag ${tag.uid} (${tag.type ?? 'unknown type'}), tamper loop: ${tag.tamper ?? 'unknown'}`;
    });

    await check('enclosure switch', info.has.enclosure, async () => {
      const { closed, open_count } = await board.request('enclosure.read');
      return `${closed ? 'closed' : 'OPEN'}, opened ${open_count} time(s) so far`;
    });
  }

  await check(
    info.role === 'anchor' ? 'venue anchor' : 'venue anchor (over BLE)',
    info.has.anchor,
    async () => {
      const device = `0x${'00'.repeat(19)}01` as Hex;
      const blockhash = toHex(digest);
      let venue = '';
      if (info.role === 'anchor') {
        try {
          const about = await board.request('anchor.info');
          venue = `venue ${about.venue_id}, address ${addressFromPublicKey(fromHex(`0x${about.pubkey}`, 64))}, `;
        } catch (error) {
          if (/no venue/.test(reason(error))) {
            return { ok: false, detail: 'no venue set — run `pnpm device anchor-setup --venue <ID>`' };
          }
          throw error;
        }
      }
      let problem = '';
      const attestation = await new BoardAnchor(board, { onProblem: (why) => (problem = why) }).attest({
        device,
        blockhash,
      });
      if (!attestation) {
        // For a device, "no anchor in range" is an answer, not a fault.
        const outOfRange = /no anchor in range/.test(problem);
        return { ok: outOfRange, detail: outOfRange ? 'radio works; no anchor in range right now' : problem };
      }
      const verified = verifyAnchorAttestation(attestation);
      if (verified.attestation.device !== device || verified.attestation.blockhash !== blockhash) {
        return { ok: false, detail: 'the anchor signed something other than what was asked' };
      }
      return `${venue || `venue ${verified.attestation.venueId}, signer ${verified.signer}, `}co-signs (counter ${verified.attestation.counter})`;
    },
  );

  return { info, rows };
}
