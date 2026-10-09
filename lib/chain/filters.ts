/**
 * Client-side chain event filters and pump.fun log parsers.
 *
 * The firehose terminates in the browser (see helius-ws.ts). This module
 * reduces it to a trickle: pure functions that turn raw program logs into
 * typed trade/mint events. No RPC calls, no network: safe at firehose
 * throughput.
 */

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

const B58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let zeroes = 0;
  while (zeroes < bytes.length && bytes[zeroes] === 0) zeroes++;
  const digits: number[] = [0];
  for (let i = zeroes; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (let i = 0; i < zeroes; i++) out += "1";
  // digits is little-endian base58; a lone [0] means the value itself is
  // zero, which the leading-one run already represents.
  const isZero = digits.length === 1 && digits[0] === 0;
  if (!isZero) {
    for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]];
  } else if (zeroes === 0) {
    out = "1";
  }
  return out;
}

export function base58Decode(s: string): Uint8Array | null {
  const out: number[] = [0];
  for (const ch of s) {
    const v = B58_ALPHABET.indexOf(ch);
    if (v < 0) return null;
    let carry = v;
    for (let j = 0; j < out.length; j++) {
      carry += out[j] * 58;
      out[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      out.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeroes = 0;
  while (zeroes < s.length && s[zeroes] === "1") zeroes++;
  const bytes = new Uint8Array(zeroes + out.length);
  for (let i = 0; i < out.length; i++) bytes[bytes.length - 1 - i] = out[i];
  return bytes;
}

/**
 * On-chain discriminator of the pump.fun program's trade event.
 *
 * Hardcoded, not derived: the program's IDL names the event differently
 * from the classic "global:TradeEvent", but the discriminator is stable
 * at bddb7fd34ee661ee and the 97-byte prefix layout (mint through
 * timestamp) is unchanged. The program appends extra fields (holder
 * rewards etc.) after the classic 129-byte body, so we only require the
 * prefix and ignore the tail.
 */
const TRADE_DISC = new Uint8Array([
  0xbd, 0xdb, 0x7f, 0xd3, 0x4e, 0xe6, 0x61, 0xee,
]);

function b64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export interface PumpTrade {
  mint: string;
  /** SOL moved, in SOL (not lamports). */
  solAmount: number;
  /** Tokens moved. Pump.fun mints use 6 decimals. */
  tokenAmount: number;
  isBuy: boolean;
  user: string;
  /** On-chain unix seconds. */
  timestamp: number;
}

const TRADE_EVENT_LEN = 8 + 32 + 8 + 8 + 1 + 32 + 8; // through timestamp

/**
 * Parse a pump.fun TradeEvent from a "Program data:" base64 log line.
 * Layout prefix: mint(32) sol_amount(u64) token_amount(u64) is_buy(u8)
 *         user(32) timestamp(i64). The current program appends extra
 *         fields after the classic body; only the prefix is parsed.
 */
export async function parsePumpTradeEvent(
  dataB64: string
): Promise<PumpTrade | null> {
  const raw = b64ToBytes(dataB64);
  if (!raw || raw.length < TRADE_EVENT_LEN) return null;
  for (let i = 0; i < 8; i++) if (raw[i] !== TRADE_DISC[i]) return null;
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let o = 8;
  const mint = base58Encode(raw.slice(o, o + 32));
  o += 32;
  const solAmount = Number(v.getBigUint64(o, true)) / 1e9;
  o += 8;
  const tokenAmount = Number(v.getBigUint64(o, true)) / 1e6;
  o += 8;
  const isBuy = raw[o] === 1;
  o += 1;
  const user = base58Encode(raw.slice(o, o + 32));
  o += 32;
  const timestamp = Number(v.getBigInt64(o, true));
  return { mint, solAmount, tokenAmount, isBuy, user, timestamp };
}

export interface PumpCreate {
  mint: string;
  name: string;
  symbol: string;
}

/**
 * Parse a pump.fun CreateEvent.
 *
 * Not implemented for the current program revision: its create-event
 * discriminator is unverified. New pairs are detected via first-seen
 * trade mints instead (see the box ingestor). Kept for API compat.
 */
export async function parsePumpCreateEvent(
  _dataB64: string
): Promise<PumpCreate | null> {
  return null;
}

const PROGRAM_DATA_RE = /Program data:\s*([A-Za-z0-9+/=]+)/;

/** Pull candidate "Program data:" payloads out of Helius log lines. */
export function programDataPayloads(logs: string[]): string[] {
  const out: string[] = [];
  for (const line of logs ?? []) {
    const m = PROGRAM_DATA_RE.exec(line);
    if (m && m[1].length >= 32) out.push(m[1]);
  }
  return out;
}

/** Short signature for display: first 4 + … + last 4. */
export function shortSig(sig: string): string {
  if (!sig || sig.length < 12) return sig;
  return `${sig.slice(0, 4)}…${sig.slice(-4)}`;
}
