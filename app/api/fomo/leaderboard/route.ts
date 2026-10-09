/**
 * FOMO leaderboard proxy — verified smart money wallets.
 *
 * GET /api/fomo/leaderboard?limit=20&window=all
 * -> {
 *      ok: true,
 *      cached: boolean,
 *      updatedAt: number,
 *      traders: Array<{
 *        rank: number,
 *        handle: string,
 *        displayName: string,
 *        pnl_usd: number,
 *        win_rate: number,      // 0-1
 *        trade_count: number,
 *        followers: number,
 *        volume_usd: number,
 *        verified: boolean,
 *        wallets: string[],     // verified Solana wallet addresses
 *        avatar: string | null,
 *      }>
 *    }
 *
 * Proxies api.fomoapi.io (independent FOMO data layer). Server-side 5-min
 * cache so we don't burn credits on every tab open. Requires FOMO_API_KEY.
 *
 * behind the session gate like every other /api/* route.
 */
export const dynamic = "force-dynamic";

const FOMO_API_BASE = "https://api.fomoapi.io";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// In-memory cache (per serverless instance). Good enough at our scale;
// the 5-min TTL keeps credit burn low even across instances.
let cache: { at: number; window: string; limit: number; data: unknown } | null = null;

const VALID_WINDOWS = new Set(["24h", "7d", "30d", "all"]);

interface FomoTrader {
  rank?: number;
  handle?: string;
  username?: string;
  displayName?: string;
  display_name?: string;
  name?: string;
  pnl?: number;
  pnl_usd?: number;
  pnlUsd?: number;
  realized_pnl_usd?: number;
  realizedPnlUsd?: number;
  volume_usd?: number;
  volumeUsd?: number;
  volume?: number;
  win_rate?: number;
  winRate?: number;
  winrate?: number;
  trade_count?: number;
  tradeCount?: number;
  trades?: number;
  numTrades?: number;
  followers?: number;
  followerCount?: number;
  follower_count?: number;
  verified?: boolean;
  isVerified?: boolean;
  is_verified?: boolean;
  wallets?: string[];
  solana_wallets?: string[];
  solanaWallets?: string[];
  avatar?: string;
  avatar_url?: string;
  avatarUrl?: string;
  profilePictureLink?: string;
  profile_picture?: string;
  profilePicture?: string;
  image?: string;
  imageUrl?: string;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function shapeTrader(t: FomoTrader, idx: number) {
  const wallets =
    t.wallets ?? t.solana_wallets ?? t.solanaWallets ?? [];
  const handle = t.handle ?? t.username ?? "unknown";
  return {
    rank: t.rank ?? idx + 1,
    handle,
    displayName: t.displayName ?? t.display_name ?? t.name ?? handle,
    pnl_usd: num(t.pnl_usd ?? t.pnlUsd ?? t.realized_pnl_usd ?? t.realizedPnlUsd ?? t.pnl),
    volume_usd: num(t.volume_usd ?? t.volumeUsd ?? t.volume),
    win_rate: num(t.win_rate ?? t.winRate ?? t.winrate),
    trade_count: Math.round(num(t.trade_count ?? t.tradeCount ?? t.trades ?? t.numTrades)),
    followers: Math.round(num(t.followers ?? t.followerCount ?? t.follower_count)),
    verified: Boolean(t.verified ?? t.isVerified ?? t.is_verified ?? false),
    wallets: Array.isArray(wallets) ? wallets.filter(Boolean) : [],
    avatar:
      t.avatar ??
      t.avatar_url ??
      t.avatarUrl ??
      t.profilePictureLink ??
      t.profile_picture ??
      t.profilePicture ??
      t.image ??
      t.imageUrl ??
      null,
  };
}

export async function GET(req: Request) {
  const apiKey = process.env.FOMO_API_KEY;
  if (!apiKey) {
    return Response.json(
      { ok: false, reason: "FOMO_API_KEY not configured" },
      { status: 503 }
    );
  }

  const { searchParams } = new URL(req.url);
  const window = searchParams.get("window") ?? "all";
  const limit = Math.min(Math.max(parseInt(searchParams.get("limit") ?? "20", 10) || 20, 1), 100);

  if (!VALID_WINDOWS.has(window)) {
    return Response.json({ ok: false, reason: "invalid window" }, { status: 400 });
  }

  // Serve from cache if fresh.
  const now = Date.now();
  if (cache && cache.window === window && cache.limit === limit && now - cache.at < CACHE_TTL_MS) {
    return Response.json(
      { ok: true, cached: true, updatedAt: Math.floor(cache.at / 1000), traders: cache.data },
      { headers: { "Cache-Control": "public, max-age=60" } }
    );
  }

  try {
    const res = await fetch(
      `${FOMO_API_BASE}/v2/leaderboard/${window}?limit=${limit}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        // Don't hang the route on a slow upstream.
        signal: AbortSignal.timeout(15000),
      }
    );

    if (!res.ok) {
      // If upstream fails but we have stale cache, serve it.
      if (cache && cache.window === window && cache.limit === limit) {
        return Response.json(
          { ok: true, cached: true, stale: true, updatedAt: Math.floor(cache.at / 1000), traders: cache.data },
          { headers: { "Cache-Control": "public, max-age=60" } }
        );
      }
      return Response.json(
        { ok: false, reason: `fomoapi error: ${res.status}` },
        { status: 502 }
      );
    }

    const json = await res.json();
    const rows: FomoTrader[] = json.leaderboard ?? json.traders ?? json.data ?? [];
    const traders = rows.map((t, i) => shapeTrader(t, i));

    cache = { at: now, window, limit, data: traders };

    return Response.json(
      { ok: true, cached: false, updatedAt: Math.floor(now / 1000), traders },
      { headers: { "Cache-Control": "public, max-age=60" } }
    );
  } catch {
    if (cache && cache.window === window && cache.limit === limit) {
      return Response.json(
        { ok: true, cached: true, stale: true, updatedAt: Math.floor(cache.at / 1000), traders: cache.data }
      );
    }
    return Response.json({ ok: false, reason: "fomoapi unreachable" }, { status: 502 });
  }
}
