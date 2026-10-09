/**
 * FOMO per-trader full profile — wallets, socials, holdings, positions, theses.
 *
 * GET /api/fomo/trader?handle=frankdegods
 *
 * Credit cost per full profile: ~4,250. Server-side 10-min cache.
 * Requires FOMO_API_KEY. behind the session gate like every other /api/* route.
 */
export const dynamic = "force-dynamic";

const FOMO_API_BASE = "https://api.fomoapi.io";
const HANDLE_RE = /^[a-zA-Z0-9_.-]{1,50}$/;
const CACHE_TTL_MS = 10 * 60 * 1000;

const profileCache = new Map<string, { at: number; data: Record<string, unknown> }>();

async function fomoGet(path: string, apiKey: string): Promise<unknown> {
  const res = await fetch(`${FOMO_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fomoapi ${res.status}`);
  return res.json();
}

function asRecord(v: unknown): Record<string, unknown> {
  return (v ?? {}) as Record<string, unknown>;
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export async function GET(req: Request) {
  const apiKey = process.env.FOMO_API_KEY;
  if (!apiKey) {
    return Response.json({ ok: false, reason: "FOMO_API_KEY not configured" }, { status: 503 });
  }

  const { searchParams } = new URL(req.url);
  const rawHandle = (searchParams.get("handle") ?? "").trim().replace(/^@/, "");
  if (!rawHandle || !HANDLE_RE.test(rawHandle)) {
    return Response.json({ ok: false, reason: "handle required" }, { status: 400 });
  }

  const cacheKey = rawHandle.toLowerCase();
  const now = Date.now();
  const cached = profileCache.get(cacheKey);
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return Response.json(
      { ok: true, cached: true, ...cached.data },
      { headers: { "Cache-Control": "public, max-age=120" } }
    );
  }

  try {
    const uRaw = await fomoGet(`/v2/users/${encodeURIComponent(rawHandle)}`, apiKey);
    if (!uRaw) {
      return Response.json({ ok: false, reason: "trader not found" }, { status: 404 });
    }
    const u = asRecord(uRaw);
    const user = asRecord(u.user ?? u.data ?? u);

    const handle = (user.handle as string) ?? (user.username as string) ?? rawHandle;
    const userId = (user.userId as string) ?? (user.id as string) ?? "";

    const walletsObj = asRecord(user.wallets);
    const solAddr = walletsObj.solana as string | undefined;
    const evmAddr = walletsObj.evm as string | undefined;
    const solList = strArr(user.solana_wallets ?? user.solanaWallets);
    const evmList = strArr(user.evm_wallets ?? user.evmWallets);

    const wallets: { address: string; chain: "solana" | "evm" }[] = [
      ...(solAddr ? [{ address: solAddr, chain: "solana" as const }] : []),
      ...solList.map((a) => ({ address: a, chain: "solana" as const })),
      ...(evmAddr ? [{ address: evmAddr, chain: "evm" as const }] : []),
      ...evmList.map((a) => ({ address: a, chain: "evm" as const })),
    ];

    const [balRaw, posRaw, theRaw] = await Promise.all([
      fomoGet(`/v2/users/${encodeURIComponent(rawHandle)}/balances`, apiKey).catch(() => null),
      fomoGet(`/v2/users/${encodeURIComponent(rawHandle)}/positions?limit=25`, apiKey).catch(() => null),
      fomoGet(`/v2/thesis/user/${encodeURIComponent(userId || rawHandle)}?limit=10`, apiKey).catch(() => null),
    ]);

    const bal = asRecord(balRaw);
    const pos = asRecord(posRaw);
    const the = asRecord(theRaw);

    const holdList: unknown[] = Array.isArray(bal.holdings) ? bal.holdings : Array.isArray(bal.tokens) ? bal.tokens : [];
    const tokens = holdList.slice(0, 50).map((h) => {
      const r = asRecord(h);
      const tok = asRecord(r.token);
      return {
        symbol: (tok.symbol as string) ?? (r.symbol as string) ?? "?",
        address: (tok.address as string) ?? (r.address as string) ?? "",
        chain: (r.chain as string) ?? "?",
        amount: (r.amount as number) ?? 0,
        priceUsd: (r.priceUsd as number) ?? 0,
        valueUsd: (r.valueUsd as number) ?? 0,
        change24h: (r.change24h as number | null) ?? null,
      };
    });

    const posList: unknown[] = Array.isArray(pos.positions) ? pos.positions : Array.isArray(pos.trades) ? pos.trades : [];
    const positions = posList.slice(0, 25).map((p) => {
      const r = asRecord(p);
      const tok = asRecord(r.token);
      return {
        token: {
          symbol: (tok.symbol as string) ?? "?",
          address: (tok.address as string) ?? "",
        },
        status: (r.status as string) ?? "unknown",
        amount: (r.amount as number) ?? 0,
        avgEntryPrice: (r.avgEntryPrice as number | null) ?? null,
        priceUsd: (r.priceUsd as number | null) ?? null,
        unrealizedPnlUsd: (r.unrealizedPnlUsd as number | null) ?? null,
        realizedPnlUsd: (r.realizedPnlUsd as number | null) ?? null,
        costBasisUsd: (r.costBasisUsd as number | null) ?? null,
      };
    });

    const theList: unknown[] = Array.isArray(the.theses) ? the.theses : Array.isArray(the.data) ? the.data : [];
    const theses = theList
      .map((t) => {
        const r = asRecord(t);
        const tok = asRecord(r.token);
        return {
          id: (r.id as string) ?? "",
          text: ((r.text as string) ?? (r.thesis as string) ?? ""),
          likes: (r.likes as number) ?? (r.thesisLikes as number) ?? 0,
          replies: (r.replies as number) ?? 0,
          token: {
            symbol: (tok.symbol as string) ?? "?",
            address: (tok.address as string) ?? "",
          },
          createdAt: (r.createdAt as string | null) ?? null,
        };
      })
      .filter((t) => t.text.length > 0)
      .slice(0, 10);

    const num = (v: unknown): number => (typeof v === "number" ? v : 0);

    const profile: Record<string, unknown> = {
      handle,
      displayName: (user.displayName as string) ?? handle,
      avatar:
        (user.profilePictureLink as string) ??
        (user.profile_picture as string) ??
        (user.profilePicture as string) ??
        (user.avatar as string) ??
        (user.avatar_url as string) ??
        (user.image as string) ??
        (user.imageUrl as string) ??
        null,
      verified:
        (user.verified as boolean) ??
        (user.isVerified as boolean) ??
        (user.is_verified as boolean) ??
        false,
      description: (user.description as string) ?? (user.bio as string) ?? null,
      pnl_usd: num(user.pnlUsd ?? user.pnl_usd ?? user.realized_pnl_usd),
      win_rate: num(user.win_rate ?? user.winRate),
      trade_count: num(user.trades ?? user.numTrades ?? user.trade_count),
      followers: num(user.followers),
      twitter: (user.twitter as string) ?? null,
      wallets,
      holdings: {
        totalValueUsd: num(bal.totalValueUsd),
        byChain: bal.byChain ?? {},
        tokens,
      },
      positions,
      theses,
    };

    profileCache.set(cacheKey, { at: now, data: profile });
    if (profileCache.size > 100) {
      const first = profileCache.keys().next();
      if (!first.done) profileCache.delete(first.value);
    }

    return Response.json(
      { ok: true, cached: false, ...profile },
      { headers: { "Cache-Control": "public, max-age=120" } }
    );
  } catch (e) {
    if (cached) {
      return Response.json({ ok: true, cached: true, stale: true, ...cached.data });
    }
    return Response.json(
      { ok: false, reason: e instanceof Error ? e.message : "fomoapi unreachable" },
      { status: 502 }
    );
  }
}
