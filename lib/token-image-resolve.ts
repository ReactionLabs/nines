/**
 * Server-side token image resolution with aggressive in-memory caching.
 *
 * Cascade per mint (first non-null wins):
 *   1. pump.fun coin API (pump mints end in "pump") -> image_uri
 *   2. Metaplex on-chain metadata via RPC: derive the metadata PDA,
 *      read the borsh-encoded URI, fetch the metadata JSON -> image
 *      (pump.fun tokens generally have no on-chain metadata account;
 *      this step covers classic SPL mints)
 *   3. DexScreener icon CDN probe:
 *      https://dd.dexscreener.com/ds-data/tokens/solana/{mint}.png
 *      (301s to cdn.dexscreener.com with a resized webp; works for far
 *      more tokens than the paid-only info.imageUrl field)
 *   4. DexScreener token info.imageUrl (paid tokens) as a last resort
 *
 * The feed already prefers scanner-resolved `image_url` and DexScreener
 * enrichment; this module only fills the gap for tokens the scanner
 * didn't resolve (new mints, non-pump launchpads).
 *
 * Cache: positive hits 24h, misses 6h. Keyed by mint. In-memory per
 * serverless instance is fine for v1; the client dedupes on top.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchBatch, mergePairs } from "@/lib/dexscreener";

const META_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const RPC_URL = "https://api.mainnet-beta.solana.com";
const PUMP_API = "https://frontend-api.pump.fun/coins";
const DS_ICON = "https://dd.dexscreener.com/ds-data/tokens/solana";
const PUMP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 8000;
const TTL_HIT_MS = 24 * 3600 * 1000;
const TTL_MISS_MS = 6 * 3600 * 1000;

interface CacheEntry {
  url: string | null;
  exp: number;
}
const cache = new Map<string, CacheEntry>();

const connection = new Connection(RPC_URL, "confirmed");

/** Normalize a raw image value into a loadable https URL, or null. */
function normalizeImage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().replace(/\0+$/, "");
  if (v.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${v.slice("ipfs://".length)}`;
  }
  return /^https?:\/\//i.test(v) ? v : null;
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      "User-Agent": PUMP_UA,
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.json();
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/**
 * Step 1: Birdeye token_overview -> logoURI (works for all Solana
 * tokens including pump.fun mints). Replaces the dead pump.fun coin
 * API (frontend-api.pump.fun returns 530 Origin DNS error as of
 * 2026-10-09). Falls back to the legacy pump.fun endpoint in case it
 * recovers.
 *
 * Direct fetch (no lib/birdeye.ts dependency): the full Birdeye client
 * with Redis caching isn't merged yet. This module already caches
 * aggressively (24h hits, 6h misses), so a direct call is fine.
 */
async function pumpImage(mint: string): Promise<string | null> {
  // Primary: Birdeye token_overview.
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (apiKey) {
    try {
      const res = await fetch(
        `https://public-api.birdeye.so/defi/token_overview?address=${encodeURIComponent(mint)}`,
        {
          headers: {
            "X-API-KEY": apiKey,
            "x-chain": "solana",
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        }
      );
      if (res.ok) {
        const d = (await res.json()) as Record<string, unknown>;
        const data = d?.data as Record<string, unknown> | undefined;
        const url = normalizeImage(data?.logoURI);
        if (url) return url;
      }
    } catch {
      /* fall through to legacy */
    }
  }
  // Legacy: pump.fun coin API (pump mints end in "pump").
  if (!mint.endsWith("pump")) return null;
  try {
    const d = (await fetchJson(`${PUMP_API}/${mint}`)) as Record<
      string,
      unknown
    >;
    return normalizeImage(d?.image_uri);
  } catch {
    return null;
  }
}

function readBorshString(
  buf: Buffer,
  offset: number
): { value: string; next: number } | null {
  if (offset + 4 > buf.length) return null;
  const len = buf.readUInt32LE(offset);
  const start = offset + 4;
  if (len > 512 || start + len > buf.length) return null;
  return {
    value: buf
      .subarray(start, start + len)
      .toString("utf8")
      .replace(/\0+$/, ""),
    next: start + len,
  };
}

/** Step 2: Metaplex on-chain metadata -> metadata URI -> JSON -> image. */
async function metaplexImage(mint: string): Promise<string | null> {
  try {
    const metaProgram = new PublicKey(META_PROGRAM_ID);
    const mintKey = new PublicKey(mint);
    const [pda] = await PublicKey.findProgramAddress(
      [Buffer.from("metadata"), metaProgram.toBuffer(), mintKey.toBuffer()],
      metaProgram
    );
    const info = await withTimeout(
      connection.getAccountInfo(pda),
      FETCH_TIMEOUT_MS
    );
    if (!info?.data) return null;
    const buf = Buffer.from(info.data);
    // Layout: key u8 (1) + update_authority (32) + mint (32) = 65,
    // then borsh strings: name, symbol, uri.
    const name = readBorshString(buf, 65);
    if (!name) return null;
    const symbol = readBorshString(buf, name.next);
    if (!symbol) return null;
    const uri = readBorshString(buf, symbol.next);
    if (!uri) return null;
    const uriUrl = normalizeImage(uri.value);
    if (!uriUrl) return null;
    const meta = (await fetchJson(uriUrl)) as Record<string, unknown>;
    return normalizeImage(meta?.image);
  } catch {
    return null;
  }
}

/**
 * Step 3: DexScreener icon CDN probe. The dd.* URL 301-redirects to a
 * resized webp on cdn.dexscreener.com for tokens they have an icon for
 * (far broader than the paid-only info.imageUrl). Returns the final
 * CDN URL, or null on 404.
 */
async function dexScreenerCdnImage(mint: string): Promise<string | null> {
  try {
    const res = await fetch(`${DS_ICON}/${mint}.png`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": PUMP_UA },
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.startsWith("image/")) return null;
    return res.url; // final URL after the 301 (resized webp)
  } catch {
    return null;
  }
}

/** Step 4 (batch): DexScreener info.imageUrl for whatever is still missing. */
async function dexscreenerImages(
  mints: string[]
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  if (mints.length === 0) return out;
  try {
    const merged = mergePairs(await fetchBatch(mints));
    for (const m of mints) out[m] = merged[m]?.imageUrl ?? null;
  } catch {
    for (const m of mints) out[m] = null;
  }
  return out;
}

/**
 * Resolve image URLs for a batch of mints. Never throws; unresolved
 * mints map to null. Results are cached aggressively (hits 24h, misses 6h).
 */
export async function resolveTokenImages(
  mints: string[]
): Promise<Record<string, string | null>> {
  const now = Date.now();
  const out: Record<string, string | null> = {};
  const todo: string[] = [];
  for (const m of mints) {
    const hit = cache.get(m);
    if (hit && hit.exp > now) {
      out[m] = hit.url;
    } else {
      todo.push(m);
    }
  }
  if (todo.length === 0) return out;

  // Steps 1-3 in parallel per mint; first non-null wins.
  const phase123 = await Promise.all(
    todo.map(async (m) => {
      const [p, x, c] = await Promise.all([
        pumpImage(m),
        metaplexImage(m),
        dexScreenerCdnImage(m),
      ]);
      return { m, url: p ?? x ?? c };
    })
  );
  const stillMissing = phase123.filter((r) => !r.url).map((r) => r.m);
  const phase4 = await dexscreenerImages(stillMissing);

  for (const r of phase123) {
    const url = r.url ?? phase4[r.m] ?? null;
    out[r.m] = url;
    cache.set(r.m, { url, exp: now + (url ? TTL_HIT_MS : TTL_MISS_MS) });
  }
  return out;
}
