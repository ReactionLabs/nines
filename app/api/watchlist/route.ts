import stateSnapshot from "@/data/watchlist-state.json";

export const dynamic = "force-dynamic";

/**
 * Watched-wallet signal state (frank et al): current holdings per watched
 * wallet plus recent detected buys. Written box-side by
 * watcher/watchlist.py and published to the PRIVATE repo at
 * data/watchlist-state.json (wallet membership is Dip's IP, never public).
 *
 * Runtime data source priority:
 *   1. Private repo data/watchlist-state.json via GITHUB_TOKEN (live).
 *   2. Local build-time snapshot in data/watchlist-state.json.
 *
 * NOTE (2026-10-08): no GITHUB_TOKEN is configured on Vercel yet, so this
 * route currently serves the build-time snapshot. The snapshot is refreshed
 * on every code deploy; push alerts for new buys are real-time via the
 * box-side cron regardless. Set GITHUB_TOKEN (repo-read PAT) to go live
 * with zero code changes.
 *
 * The `live` field + `updatedAt` drive the UI freshness pill.
 */
const PRIVATE_URL =
  "https://api.github.com/repos/ReactionLabs/tyck-trade/contents/data/watchlist-state.json";

type Holding = {
  mint?: string;
  amount?: number;
  decimals?: number;
  usd_value?: number | null;
};

type WalletState = {
  address?: string;
  label?: string;
  holdings?: Holding[];
  total_usd?: number;
};

type WatchPayload = {
  updated_at?: number;
  wallets?: WalletState[];
  recent_buys?: Array<{
    wallet?: string;
    label?: string;
    mint?: string;
    amount?: number;
    usd_value?: number | null;
    time?: number;
    signature?: string;
  }>;
};

function shape(src: WatchPayload, live: boolean) {
  const wallets = (src.wallets ?? []).map((w) => ({
    address: w.address ?? "",
    label: w.label ?? "",
    total_usd: w.total_usd ?? 0,
    holding_count: (w.holdings ?? []).length,
    // Top 50 by USD value first (unpriced sink to the bottom).
    holdings: (w.holdings ?? [])
      .slice()
      .sort((a, b) => (b.usd_value ?? -1) - (a.usd_value ?? -1))
      .slice(0, 50)
      .map((h) => ({
        mint: h.mint ?? "",
        amount: h.amount ?? 0,
        usd_value: h.usd_value ?? null,
      })),
  }));
  return {
    ok: true,
    live,
    updatedAt: src.updated_at ?? 0,
    wallets,
    recentBuys: (src.recent_buys ?? []).slice(0, 20).map((b) => ({
      label: b.label ?? "",
      mint: b.mint ?? "",
      usd_value: b.usd_value ?? null,
      time: b.time ?? 0,
      signature: b.signature ?? "",
    })),
  };
}

export async function GET() {
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    try {
      const res = await fetch(PRIVATE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.raw",
        },
        next: { revalidate: 60 },
      });
      if (res.ok) {
        const data = (await res.json()) as WatchPayload;
        return Response.json(shape(data, true));
      }
    } catch {
      // fall through to snapshot
    }
  }
  return Response.json(shape(stateSnapshot as WatchPayload, false));
}
