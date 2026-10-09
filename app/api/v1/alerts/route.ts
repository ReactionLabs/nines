/**
 * v1 bot API: fired alerts.
 *
 * GET /api/v1/alerts
 * -> { ok, live, updated_at, count, alerts[] }
 *    alerts[]: { mint, tier, reason, at (unix s) } — newest first.
 *
 * Alerts fire only when a candidate passes every gate. Poll this to drive
 * bot attention; never trade on it directly without your own checks.
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
  const alerts = [...s.alerts]
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    .map((a) => ({ mint: a.mint, tier: a.tier, reason: a.reason, at: a.at }));
  return Response.json(
    {
      ok: true,
      live: s.live,
      updated_at: s.updated_at,
      count: alerts.length,
      alerts,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
