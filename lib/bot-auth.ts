/* API key authentication + per-key rate limiting for the v1 bot API.
 *
 * Edge-safe (Web Crypto + in-memory only, no node:crypto) so it can run in
 * middleware as well as route handlers.
 *
 * Keys: `lt_<base64url>` tokens. Only SHA-256 hashes are stored, in the
 * BOT_API_KEY_HASHES env var (comma-separated hex). The plaintext key is
 * shown once at issuance (see scripts/issue-api-key.mjs) and never stored.
 *
 * Rate limiting is per-instance in-memory (best-effort on serverless):
 * 60 requests/minute per key. Exceeding it returns 429 + Retry-After.
 */

import { sha256Hex, timingSafeEqualHex } from "./auth";

export const V1_RATE_LIMIT_PER_MIN = 60;
const WINDOW_MS = 60_000;

type Bucket = { count: number; windowStart: number };
const buckets = new Map<string, Bucket>();

function keyHashes(): string[] {
  const raw = process.env.BOT_API_KEY_HASHES ?? "";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Extract the presented API key from the X-API-Key header or ?key= param. */
export function extractKey(req: Request): string | null {
  const h = req.headers.get("x-api-key");
  if (h && h.trim()) return h.trim();
  try {
    const q = new URL(req.url).searchParams.get("key");
    if (q && q.trim()) return q.trim();
  } catch {
    /* ignore malformed URL */
  }
  return null;
}

/**
 * Validate a presented key against the stored hashes.
 * Returns a stable key id (hash prefix) for rate limiting, or null.
 */
export async function validateKey(key: string): Promise<string | null> {
  const hashes = keyHashes();
  if (hashes.length === 0) return null;
  const digest = await sha256Hex(key);
  for (const h of hashes) {
    if (timingSafeEqualHex(digest, h)) return h.slice(0, 12);
  }
  return null;
}

/**
 * Check the per-key rate limit. Returns null when the request may proceed,
 * or the Retry-After seconds when the limit is exceeded.
 */
export function checkRateLimit(keyId: string): number | null {
  const now = Date.now();
  const b = buckets.get(keyId);
  if (!b || now - b.windowStart >= WINDOW_MS) {
    buckets.set(keyId, { count: 1, windowStart: now });
    return null;
  }
  if (b.count >= V1_RATE_LIMIT_PER_MIN) {
    return Math.max(1, Math.ceil((b.windowStart + WINDOW_MS - now) / 1000));
  }
  b.count += 1;
  return null;
}

/** Machine-readable v1 error response. */
export function v1err(code: string, message: string, status: number): Response {
  return Response.json({ ok: false, error: code, message }, { status });
}
