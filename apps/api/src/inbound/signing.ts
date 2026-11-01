import { createHmac } from 'node:crypto';
import { INBOUND_SOURCES, INBOUND_WINDOW_SECONDS, type InboundSource } from '@mawsool/types';
import { hashesEqual } from '../security';

/** The four headers of a signed inbound request. */
export const INBOUND_HEADERS = {
  source: 'x-mawsool-source',
  timestamp: 'x-mawsool-timestamp',
  nonce: 'x-mawsool-nonce',
  signature: 'x-mawsool-signature',
} as const;

/** A nonce is 16 to 64 URL-safe characters, chosen by the sender and used once. */
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;
const TIMESTAMP_PATTERN = /^\d{10}$/;

/** What is signed: the source, the timestamp, the nonce and the exact bytes of the body, one per line. */
function signingInput(source: string, timestamp: string, nonce: string, body: string): string {
  return [source, timestamp, nonce, body].join('\n');
}

export interface SignInput {
  key: string;
  source: InboundSource;
  /** Seconds since the epoch. */
  timestamp: number;
  nonce: string;
  /** The body exactly as it is sent. */
  body: string;
}

/** The headers a front door sends with a body, signed with its key (HMAC-SHA256 over the source, time, nonce and body). */
export function signInbound({ key, source, timestamp, nonce, body }: SignInput): Record<string, string> {
  const stamp = String(timestamp);
  return {
    [INBOUND_HEADERS.source]: source,
    [INBOUND_HEADERS.timestamp]: stamp,
    [INBOUND_HEADERS.nonce]: nonce,
    [INBOUND_HEADERS.signature]: createHmac('sha256', key).update(signingInput(source, stamp, nonce, body)).digest('hex'),
  };
}

export type InboundCheck =
  | { ok: true; source: InboundSource; nonce: string }
  /** Anything wrong with the request: a missing or malformed header, an unknown source, a stale time or a signature that does not match. */
  | { ok: false };

type Headers = Record<string, string | string[] | undefined>;

function single(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Checks a request's headers and raw body against the keys on file, without touching the database. A request passes
 * only when its source has a key, its timestamp is within the window of `nowSeconds`, and the signature matches the
 * exact body bytes. Every failure looks the same to the caller.
 */
export function checkInbound(options: { headers: Headers; body: string; keys: Partial<Record<InboundSource, string>>; nowSeconds: number }): InboundCheck {
  const { headers, body, keys, nowSeconds } = options;
  const source = single(headers[INBOUND_HEADERS.source]);
  const timestamp = single(headers[INBOUND_HEADERS.timestamp]);
  const nonce = single(headers[INBOUND_HEADERS.nonce]);
  const signature = single(headers[INBOUND_HEADERS.signature]);
  if (source === null || timestamp === null || nonce === null || signature === null) return { ok: false };
  const known = (INBOUND_SOURCES as readonly string[]).includes(source) ? (source as InboundSource) : null;
  const key = known ? keys[known] : undefined;
  if (!known || key === undefined) return { ok: false };
  if (!TIMESTAMP_PATTERN.test(timestamp) || !NONCE_PATTERN.test(nonce) || !SIGNATURE_PATTERN.test(signature)) return { ok: false };
  if (Math.abs(nowSeconds - Number(timestamp)) > INBOUND_WINDOW_SECONDS) return { ok: false };
  const expected = createHmac('sha256', key).update(signingInput(known, timestamp, nonce, body)).digest('hex');
  return hashesEqual(expected, signature) ? { ok: true, source: known, nonce } : { ok: false };
}
