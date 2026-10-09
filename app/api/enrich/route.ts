import { emptyEnriched, fetchBatch, mergePairs } from "@/lib/dexscreener";

/**
 * Server-side fallback for DexScreener enrichment.
 *
 * The primary path is a direct client-side fetch to the DexScreener free
 * API (see lib/use-enrichment.ts). When that fails from the browser
 * (TLS-intercepting proxies, DNS/adblock interference), the client
 * retries through this route, which fans out server-side. Same batch
 * limit (<=30 mints), same merge rules, same honesty: tokens DexScreener
 * has no record of get nulls, never estimates.
 *
 * behind the session gate like every other /api/* route.
 */
export const dynamic = "force-dynamic";

const MAX_MINTS = 30;
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const raw = (searchParams.get("mints") ?? "").split(",").filter(Boolean);
  const mints = Array.from(new Set(raw)).slice(0, MAX_MINTS);

  if (mints.length === 0) {
    return Response.json({ ok: false, reason: "mints required" }, { status: 400 });
  }
  if (!mints.every((m) => MINT_RE.test(m))) {
    return Response.json({ ok: false, reason: "invalid mint" }, { status: 400 });
  }

  try {
    const pairs = await fetchBatch(mints);
    const merged = mergePairs(pairs);
    const out: Record<string, unknown> = {};
    for (const m of mints) out[m] = merged[m] ?? emptyEnriched(m);
    return Response.json(
      { ok: true, tokens: out },
      { headers: { "Cache-Control": "public, max-age=60" } }
    );
  } catch {
    return Response.json({ ok: false, reason: "dexscreener unreachable" }, { status: 502 });
  }
}
