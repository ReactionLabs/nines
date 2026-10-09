import { NextResponse } from "next/server";
import { readCurveState } from "@/lib/pump-curve";
import { classifyLifecycle, type LifecycleInfo } from "@/lib/lifecycle";

/**
 * GET /api/lifecycle?mints=<csv, max 30>
 *
 * Real token lifecycle status per mint, from on-chain bonding-curve state
 * and DexScreener pair data. Never derived from Nines gate scores.
 *
 * Response: { [mint]: LifecycleInfo & { checkedAt: number } }
 *
 * Results are cached server-side for 5 minutes. Curve RPCs are the
 * expensive leg; DexScreener is one batched call for all mints.
 */

// pump.fun graduation math: the curve opens with 30 virtual SOL and
// graduates when 85 real SOL are raised, so virtualSolReserves tops out
// near 115 SOL. Progress is the raised fraction, clamped to [0,1].
const VIRTUAL_SOL_INITIAL = BigInt(30_000_000_000);
const REAL_SOL_GRADUATION = BigInt(85_000_000_000);

const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; info: LifecycleInfo }>();

async function dexIds(mints: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const m of mints) out[m] = null;
  if (mints.length === 0) return out;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let res: Response;
    try {
      res = await fetch(
        `https://api.dexscreener.com/tokens/v1/solana/${mints.join(",")}`,
        { signal: ctrl.signal, headers: { Accept: "application/json" } }
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return out;
    const pairs = (await res.json()) as Array<{
      baseToken?: { address?: string };
      dexId?: string;
      liquidity?: { usd?: number };
    }>;
    const best: Record<string, { dexId: string; liq: number }> = {};
    for (const p of pairs ?? []) {
      const mint = p?.baseToken?.address;
      const dexId = p?.dexId;
      if (!mint || !dexId || !out.hasOwnProperty(mint)) continue;
      const liq = p?.liquidity?.usd ?? 0;
      if (!best[mint] || liq > best[mint].liq) best[mint] = { dexId, liq };
    }
    for (const [mint, b] of Object.entries(best)) out[mint] = b.dexId;
  } catch {
    /* DexScreener down: dexId stays null, curve state still works */
  }
  return out;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const mints = (url.searchParams.get("mints") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 30);

  if (mints.length === 0) {
    return NextResponse.json({ error: "mints required" }, { status: 400 });
  }

  const now = Date.now();
  const result: Record<string, LifecycleInfo & { checkedAt: number }> = {};
  const needCurve: string[] = [];

  for (const m of mints) {
    const hit = cache.get(m);
    if (hit && now - hit.at < CACHE_MS) {
      result[m] = { ...hit.info, checkedAt: hit.at };
    } else {
      needCurve.push(m);
    }
  }

  if (needCurve.length > 0) {
    const ids = await dexIds(needCurve);
    // Curve RPCs in parallel; each has its own timeout inside readCurveState.
    const curves = await Promise.all(
      needCurve.map(async (m) => {
        try {
          return await readCurveState(m);
        } catch {
          return null;
        }
      })
    );
    needCurve.forEach((m, i) => {
      const curve = curves[i];
      let progress: number | null = null;
      let complete: boolean | null = null;
      if (curve) {
        complete = curve.complete;
        const raised =
          curve.virtualSolReserves > VIRTUAL_SOL_INITIAL
            ? curve.virtualSolReserves - VIRTUAL_SOL_INITIAL
            : BigInt(0);
        progress = Math.min(
          1,
          Math.max(0, Number(raised) / Number(REAL_SOL_GRADUATION))
        );
      }
      const info = classifyLifecycle(progress, complete, ids[m] ?? null);
      cache.set(m, { at: now, info });
      result[m] = { ...info, checkedAt: now };
    });
  }

  return NextResponse.json(result, {
    headers: { "Cache-Control": "public, max-age=60" },
  });
}
