/**
 * Full-precision price feed from pump.fun bonding curves.
 *
 * Why this exists: DexScreener's priceUsd rounds to ~4 significant digits
 * (e.g. "0.000003117"), which quantizes away the tiny moves that 1s/5s/15s/30s
 * candles need — every tick in a session can share the identical price,
 * producing perfectly flat (invisible) candles. The bonding curve holds u64
 * virtual reserves, so price = virtualSolReserves / virtualTokenReserves has
 * effectively unlimited precision: every trade moves it visibly.
 *
 * Only works for pump.fun tokens still on the bonding curve (not graduated).
 * Graduated tokens are detected via the curve's `complete` flag and return
 * null so callers fall through to Jupiter/DexScreener — a graduated curve's
 * reserves are frozen (or zeroed) and would otherwise serve identical,
 * increasingly stale prices forever.
 */

import { PublicKey } from "@solana/web3.js";

const PUMP_PROGRAM_ID = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Public RPCs, raced (first success wins). No key needed; getAccountInfo is cheap.
const RPCS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
  "https://rpc.ankr.com/solana",
];

// Short timeout: sub-second tick cadence needs fast upstream. The race means
// the typical case is ~150-300ms; the timeout only bounds the worst case.
const RPC_TIMEOUT_MS = 4000;

// Cached SOL/USD (Jupiter, full precision). Only a multiplier for the curve
// ratio, so a 60s-old quote is fine — candle SHAPES come from the curve.
let solPriceCache: { at: number; price: number } | null = null;
const SOL_CACHE_MS = 60_000;

async function fetchWithTimeout(
  url: string,
  body: unknown,
  timeoutMs = RPC_TIMEOUT_MS
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`rpc ${res.status}`);
    const d = (await res.json()) as { result?: unknown; error?: unknown };
    if (d.error) throw new Error("rpc error");
    return d.result;
  } finally {
    clearTimeout(timer);
  }
}

export async function solPriceUsd(): Promise<number | null> {
  const now = Date.now();
  if (solPriceCache && now - solPriceCache.at < SOL_CACHE_MS) {
    return solPriceCache.price;
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
    try {
      const res = await fetch(
        `https://api.jup.ag/price/v3?ids=${SOL_MINT}`,
        { headers: { Accept: "application/json" }, signal: ctrl.signal }
      );
      if (!res.ok) return solPriceCache?.price ?? null;
      const d = (await res.json()) as Record<string, { usdPrice?: number }>;
      const p = d?.[SOL_MINT]?.usdPrice;
      if (typeof p === "number" && p > 0) {
        solPriceCache = { at: now, price: p };
        return p;
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // fall through to stale cache
  }
  return solPriceCache?.price ?? null;
}

function curvePdas(mint: string): PublicKey[] {
  const mintPk = new PublicKey(mint);
  const pdas: PublicKey[] = [];
  for (const seed of ["bonding-curve", "bonding-curve-v2"]) {
    try {
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from(seed), mintPk.toBuffer()],
        PUMP_PROGRAM_ID
      );
      pdas.push(pda);
    } catch {
      continue;
    }
  }
  return pdas;
}

export type CurveState = {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  /** True once the token graduated — reserves are frozen, price is stale. */
  complete: boolean;
};

/**
 * Raw bonding-curve state. Tries the v1 PDA then the v2 PDA; RPC endpoints
 * are raced so one slow provider can't stall the tick loop. Returns null
 * when no curve account exists or all RPCs fail.
 */
export async function readCurveState(
  mint: string
): Promise<CurveState | null> {
  let pdas: PublicKey[];
  try {
    pdas = curvePdas(mint);
  } catch {
    return null; // invalid mint
  }
  if (pdas.length === 0) return null;

  for (const pda of pdas) {
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [pda.toBase58(), { encoding: "base64" }],
    };
    // Race all RPCs; first success wins. Individual failures are swallowed
    // by the race — only an all-fail rejects.
    const result = await Promise.any(
      RPCS.map((rpc) => fetchWithTimeout(rpc, body))
    ).catch(() => null);
    const b64 = (
      result as { value?: { data?: [string, string] } | null } | null
    )?.value?.data?.[0];
    if (typeof b64 !== "string" || b64.length === 0) continue; // try next PDA
    const raw = Buffer.from(b64, "base64");
    if (raw.length < 49) continue; // need discriminator + 6 u64s + complete flag
    return {
      virtualTokenReserves: raw.readBigUInt64LE(8),
      virtualSolReserves: raw.readBigUInt64LE(16),
      complete: raw[48] !== 0,
    };
  }
  return null;
}

/**
 * Full-precision USD price from the pump.fun bonding curve.
 * Returns null when the curve is unreadable OR the token graduated
 * (complete=true: reserves are frozen, price would be stale forever).
 */
export async function curvePriceUsd(mint: string): Promise<number | null> {
  const state = await readCurveState(mint);
  if (!state) return null;
  if (state.complete) return null; // graduated — curve is frozen
  const { virtualTokenReserves: vtr, virtualSolReserves: vsr } = state;
  if (vtr === BigInt(0) || vsr === BigInt(0)) return null;

  // SOL per token = (vsr / 1e9) / (vtr / 1e6). Use float division on the
  // u64 values directly — full double precision (~15-16 sig digits).
  const solPerToken = Number(vsr) / Number(vtr) / 1000;
  if (!Number.isFinite(solPerToken) || solPerToken <= 0) return null;

  const solUsd = await solPriceUsd();
  if (solUsd === null) return null;

  const usd = solPerToken * solUsd;
  return Number.isFinite(usd) && usd > 0 ? usd : null;
}
