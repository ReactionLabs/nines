/**
 * v1 bot API: token candidate feed.
 *
 * GET /api/v1/candidates
 * -> { ok, live, updated_at, count, candidates[] }
 *
 * Each candidate: mint, launchpad, first_seen, tier, volume_usd, image_url,
 * gates[] (gate-by-gate breakdown), verdict ("ALERT"|"PASS"), alerted, reason.
 * Live price/market-cap come from /api/v1/ticks per mint (or the dashboard
 * enrichment feed); the scanner record is the source of truth for gates.
 *
 * Auth: X-API-Key header or ?key= (see docs/api-v1.md).
 */
export const dynamic = "force-dynamic";

import { fetchBotState } from "@/lib/bot-state";
import { v1err } from "@/lib/bot-auth";

export async function GET() {
  const s = await fetchBotState();
  if (!s) {
    return v1err("upstream_error", "scanner state unreachable", 502);
  }
  const candidates = s.candidates.map((c) => ({
    mint: c.mint,
    launchpad: c.launchpad,
    first_seen: c.first_seen,
    tier: c.tier,
    volume_usd: c.volume_usd,
    image_url: c.image_url,
    gates: c.gates,
    verdict: c.verdict,
    partial: c.partial,
    alerted: c.alerted,
    alerted_at: c.alerted_at,
    reason: c.reason,
  }));
  return Response.json(
    {
      ok: true,
      live: s.live,
      updated_at: s.updated_at,
      count: candidates.length,
      candidates,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
