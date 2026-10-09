"use client";

import { useRouter } from "next/navigation";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/format";
import { TraderAvatar } from "@/components/fomo-avatar";

/** Rank badge styling: gold/silver/bronze for the podium, muted after. */
function rankBadge(rank: number): string {
  if (rank === 1)
    return "bg-gold text-black border-gold";
  if (rank === 2)
    return "bg-slate-300/20 text-slate-200 border-slate-300/40";
  if (rank === 3)
    return "bg-amber-700/25 text-amber-500 border-amber-700/50";
  return "bg-raised text-mut border-line";
}

function fmtFollowers(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

/** Verified checkmark shown next to FOMO-verified trader names. */
function VerifiedMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="inline h-3.5 w-3.5 shrink-0 text-gold"
      fill="currentColor"
      aria-label="verified"
    >
      <path d="M12 2l2.4 2.4 3.4-.5 1 3.3 3.3 1-.5 3.4L24 14l-2.4 2.4.5 3.4-3.3 1-1 3.3-3.4-.5L12 26l-2.4-2.4-3.4.5-1-3.3-3.3-1 .5-3.4L0 14l2.4-2.4-.5-3.4 3.3-1 1-3.3 3.4.5L12 2z" transform="scale(0.9167)" />
      <path
        d="M10.6 15.6l-3.1-3.1 1.4-1.4 1.7 1.7 4.5-4.5 1.4 1.4-5.9 5.9z"
        fill="#0a0c0e"
      />
    </svg>
  );
}

interface FomoTrader {
  rank: number;
  handle: string;
  displayName: string;
  pnl_usd: number;
  win_rate: number;
  trade_count: number;
  followers: number;
  volume_usd: number;
  verified: boolean;
  wallets: string[];
  avatar: string | null;
}

interface FomoWallet {
  address: string;
  chain: "solana" | "evm";
}

interface FomoHolding {
  symbol: string;
  address: string;
  chain: string;
  amount: number;
  priceUsd: number;
  valueUsd: number;
  change24h: number | null;
}

interface FomoPosition {
  token: { symbol: string; address: string };
  status: string;
  amount: number;
  avgEntryPrice: number | null;
  priceUsd: number | null;
  unrealizedPnlUsd: number | null;
  realizedPnlUsd: number | null;
  costBasisUsd: number | null;
}

interface FomoThesis {
  id: string;
  text: string;
  likes: number;
  replies: number;
  token: { symbol: string; address: string };
  createdAt: string | null;
}

interface FomoProfile {
  handle: string;
  displayName: string;
  avatar: string | null;
  description: string | null;
  pnl_usd: number;
  win_rate: number;
  trade_count: number;
  followers: number;
  verified: boolean;
  twitter: string | null;
  wallets: FomoWallet[];
  holdings: {
    totalValueUsd: number;
    byChain: Record<string, { holdings: number; valueUsd: number }>;
    tokens: FomoHolding[];
  };
  positions: FomoPosition[];
  theses: FomoThesis[];
}

function labelColor(label: string): string {
  switch (label) {
    case "SMART MONEY":
      return "bg-gold/15 text-gold border-gold/30";
    case "WHALE":
      return "bg-blue-500/15 text-blue-400 border-blue-500/30";
    case "SNIPER":
      return "bg-red-500/15 text-red-400 border-red-500/30";
    case "DEV":
      return "bg-purple-500/15 text-purple-400 border-purple-500/30";
    case "FRESH":
      return "bg-green-500/15 text-green-400 border-green-500/30";
    default:
      return "bg-raised text-mut border-line";
  }
}

function fmtPnl(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "+";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function shortAddr(a: string): string {
  return a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

function copyAddr(a: string) {
  try {
    navigator.clipboard.writeText(a);
  } catch {
    /* clipboard unavailable */
  }
}

/**
 * Smart Money: FOMO leaderboard of verified top traders.
 * Tap a trader to open their full profile (wallets, holdings, socials).
 */
export function SmartMoneyTab({
  onSelectMint,
}: {
  onSelectMint: (mint: string) => void;
}) {
  const router = useRouter();

  // FOMO state
  const [fomoTraders, setFomoTraders] = useState<FomoTrader[]>([]);
  const [fomoLoading, setFomoLoading] = useState(false);
  const [fomoError, setFomoError] = useState<string | null>(null);
  const [fomoUpdatedAt, setFomoUpdatedAt] = useState(0);
  const [selectedTrader, setSelectedTrader] = useState<string | null>(null);
  const [traderProfile, setTraderProfile] = useState<FomoProfile | null>(null);
  const [traderWallets, setTraderWallets] = useState<FomoWallet[]>([]);
  const [traderLoading, setTraderLoading] = useState(false);
  const [profileTab, setProfileTab] = useState<"wallets" | "holdings" | "positions" | "theses">("wallets");
  const [tracking, setTracking] = useState<Set<string>>(new Set());
  const [trackedOk, setTrackedOk] = useState<Set<string>>(new Set());

  const loadFomo = useCallback(async () => {
    setFomoLoading(true);
    setFomoError(null);
    try {
      const res = await fetch("/api/fomo/leaderboard?limit=20&window=all");
      const d = await res.json();
      if (d.ok) {
        setFomoTraders(d.traders ?? []);
        setFomoUpdatedAt(d.updatedAt ?? 0);
      } else {
        setFomoError(d.reason ?? "failed to load");
      }
    } catch {
      setFomoError("unreachable");
    } finally {
      setFomoLoading(false);
    }
  }, []);

  const loadTrader = useCallback(async (handle: string) => {
    setSelectedTrader(handle);
    setTraderLoading(true);
    setTraderProfile(null);
    setTraderWallets([]);
    setProfileTab("wallets");
    try {
      const res = await fetch(`/api/fomo/trader?handle=${encodeURIComponent(handle)}`);
      const d = await res.json();
      if (d.ok) {
        setTraderProfile(d as FomoProfile);
        setTraderWallets((d.wallets ?? []).filter((w: FomoWallet) => w.chain === "solana"));
      }
    } catch {
      /* keep empty */
    } finally {
      setTraderLoading(false);
    }
  }, []);

  const trackWallet = useCallback(async (address: string, handle: string) => {
    if (tracking.has(address) || trackedOk.has(address)) return;
    setTracking((s) => new Set(s).add(address));
    try {
      const res = await fetch("/api/fomo/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, handle, label: `FOMO:${handle}` }),
      });
      const d = await res.json();
      if (d.ok && d.tracked) {
        setTrackedOk((s) => new Set(s).add(address));
      }
    } catch {
      /* stay untracked */
    } finally {
      setTracking((s) => {
        const n = new Set(s);
        n.delete(address);
        return n;
      });
    }
  }, [tracking, trackedOk]);

  // Load FOMO leaderboard on mount, refresh every 2 min.
  useEffect(() => {
    loadFomo();
    const t = setInterval(loadFomo, 120_000);
    return () => clearInterval(t);
  }, [loadFomo]);

  return (
    <div>
      {selectedTrader ? (
          /* trader profile */
          <div>
            <button
              onClick={() => setSelectedTrader(null)}
              className="mb-3 font-mono text-[12px] text-gold hover:underline"
            >
              ← back to leaderboard
            </button>
            {traderLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : traderProfile ? (
              <div>
                {/* profile header */}
                <div className="mb-4 rounded-lg border border-line bg-card p-4">
                  <div className="flex items-start gap-3">
                    <TraderAvatar
                      handle={traderProfile.handle}
                      avatar={traderProfile.avatar}
                      size={52}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 truncate font-mono text-[15px] font-bold text-white">
                        <span className="truncate">{traderProfile.displayName}</span>
                        {traderProfile.verified && <VerifiedMark />}
                      </p>
                      <p className="font-mono text-[11px] text-mut">
                        @{traderProfile.handle}
                        {traderProfile.followers > 0 && (
                          <span className="ml-2 text-gold">
                            {fmtFollowers(traderProfile.followers)} followers
                          </span>
                        )}
                        {traderProfile.twitter && (
                          <a
                            href={`https://x.com/${traderProfile.twitter.replace(/^@/, "")}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="ml-2 text-blue-400 hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            𝕏 {traderProfile.twitter.replace(/^@/, "")}
                          </a>
                        )}
                      </p>
                      {traderProfile.description && (
                        <p className="mt-1 line-clamp-2 font-mono text-[11px] text-mut">
                          {traderProfile.description}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-5 gap-2">
                    <div>
                      <p className={cn("font-mono text-[14px] font-bold", traderProfile.pnl_usd >= 0 ? "text-green-400" : "text-red-400")}>
                        {fmtPnl(traderProfile.pnl_usd)}
                      </p>
                      <p className="font-mono text-[9px] text-mut">PNL</p>
                    </div>
                    <div>
                      <p className="font-mono text-[14px] font-bold text-gold">
                        {fmtFollowers(traderProfile.followers)}
                      </p>
                      <p className="font-mono text-[9px] text-mut">FOLLOWERS</p>
                    </div>
                    <div>
                      <p className="font-mono text-[14px] font-bold text-white">
                        {(traderProfile.win_rate * 100).toFixed(0)}%
                      </p>
                      <p className="font-mono text-[9px] text-mut">WIN</p>
                    </div>
                    <div>
                      <p className="font-mono text-[14px] font-bold text-white">
                        {traderProfile.trade_count}
                      </p>
                      <p className="font-mono text-[9px] text-mut">TRADES</p>
                    </div>
                    <div>
                      <p className="font-mono text-[14px] font-bold text-white">
                        {traderProfile.holdings.totalValueUsd >= 1000
                          ? `$${(traderProfile.holdings.totalValueUsd / 1000).toFixed(0)}K`
                          : `$${traderProfile.holdings.totalValueUsd.toFixed(0)}`}
                      </p>
                      <p className="font-mono text-[9px] text-mut">HOLDING</p>
                    </div>
                  </div>
                </div>

                {/* profile tabs */}
                <div className="mb-3 flex gap-1 overflow-x-auto">
                  {(
                    [
                      ["wallets", `Wallets (${traderWallets.length})`],
                      ["holdings", `Holdings (${traderProfile.holdings.tokens.length})`],
                      ["positions", `Positions (${traderProfile.positions.length})`],
                      ["theses", `Theses (${traderProfile.theses.length})`],
                    ] as ["wallets" | "holdings" | "positions" | "theses", string][]
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      onClick={() => setProfileTab(id)}
                      className={cn(
                        "shrink-0 rounded-lg px-3 py-1.5 font-mono text-[11px] font-semibold",
                        profileTab === id
                          ? "bg-gold text-black"
                          : "bg-raised text-mut hover:text-white"
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {profileTab === "wallets" && (
                  traderWallets.length === 0 ? (
                    <p className="font-mono text-[12px] text-mut">
                      No Solana wallets found for this trader.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {traderWallets.map((w) => {
                        const isTracking = tracking.has(w.address);
                        const isTracked = trackedOk.has(w.address);
                        return (
                          <div
                            key={w.address}
                            className="flex items-center gap-3 rounded-lg border border-line bg-card p-3"
                          >
                            <div className="min-w-0 flex-1">
                              <p className="font-mono text-[13px] text-white">
                                {shortAddr(w.address)}
                              </p>
                              <p className="font-mono text-[10px] text-mut">solana</p>
                            </div>
                            <button
                              onClick={() => copyAddr(w.address)}
                              className="rounded-md bg-raised px-2 py-1 font-mono text-[11px] text-mut hover:text-white"
                              title="Copy address"
                            >
                              Copy
                            </button>
                            <button
                              onClick={() => trackWallet(w.address, selectedTrader)}
                              disabled={isTracking || isTracked}
                              className={cn(
                                "rounded-md px-3 py-1 font-mono text-[11px] font-semibold",
                                isTracked
                                  ? "bg-green-500/15 text-green-400"
                                  : "bg-gold text-black hover:opacity-90 disabled:opacity-50"
                              )}
                            >
                              {isTracked ? "Tracked ✓" : isTracking ? "…" : "Track"}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )
                )}

                {profileTab === "holdings" && (
                  traderProfile.holdings.tokens.length === 0 ? (
                    <p className="font-mono text-[12px] text-mut">No holdings data.</p>
                  ) : (
                    <div className="space-y-2">
                      {traderProfile.holdings.tokens.map((h, i) => (
                        <div
                          key={`${h.address}-${i}`}
                          className="flex items-center gap-3 rounded-lg border border-line bg-card p-3"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="font-mono text-[13px] font-semibold text-white">
                              {h.symbol}
                            </p>
                            <p className="font-mono text-[10px] text-mut">
                              {h.amount.toLocaleString()} · {h.chain}
                            </p>
                          </div>
                          <div className="shrink-0 text-right">
                            <p className="font-mono text-[13px] text-white">
                              ${h.valueUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                            </p>
                            {h.change24h !== null && (
                              <p className={cn("font-mono text-[10px]", h.change24h >= 0 ? "text-green-400" : "text-red-400")}>
                                {h.change24h >= 0 ? "+" : ""}{h.change24h.toFixed(1)}%
                              </p>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                )}

                {profileTab === "positions" && (
                  traderProfile.positions.length === 0 ? (
                    <p className="font-mono text-[12px] text-mut">No positions data.</p>
                  ) : (
                    <div className="space-y-2">
                      {traderProfile.positions.map((p, i) => {
                        const pnl = p.status === "open" ? p.unrealizedPnlUsd : p.realizedPnlUsd;
                        return (
                          <button
                            key={i}
                            onClick={() => p.token.address && onSelectMint(p.token.address)}
                            className="flex w-full items-center gap-3 rounded-lg border border-line bg-card p-3 text-left hover:border-gold/40"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <p className="font-mono text-[13px] font-semibold text-white">
                                  {p.token.symbol}
                                </p>
                                <Badge className={cn(
                                  "border px-1 py-0 font-mono text-[9px]",
                                  p.status === "open"
                                    ? "border-green-500/30 bg-green-500/15 text-green-400"
                                    : "border-line bg-raised text-mut"
                                )}>
                                  {p.status.toUpperCase()}
                                </Badge>
                              </div>
                              <p className="mt-0.5 font-mono text-[10px] text-mut">
                                entry {p.avgEntryPrice !== null ? `$${p.avgEntryPrice.toFixed(6)}` : "—"}
                                {" → "}
                                {p.priceUsd !== null ? `$${p.priceUsd.toFixed(6)}` : "now —"}
                              </p>
                            </div>
                            {pnl !== null && (
                              <p className={cn("shrink-0 font-mono text-[13px] font-bold", pnl >= 0 ? "text-green-400" : "text-red-400")}>
                                {fmtPnl(pnl)}
                              </p>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )
                )}

                {profileTab === "theses" && (
                  traderProfile.theses.length === 0 ? (
                    <p className="font-mono text-[12px] text-mut">
                      No written theses from this trader yet.
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {traderProfile.theses.map((t) => (
                        <div
                          key={t.id}
                          className="rounded-lg border border-line bg-card p-3"
                        >
                          <div className="mb-1 flex items-center gap-2">
                            <button
                              onClick={() => t.token.address && router.push(`/coin/${encodeURIComponent(t.token.address)}`)}
                              className="font-mono text-[12px] font-semibold text-gold hover:underline"
                            >
                              ${t.token.symbol} ↗
                            </button>
                            <span className="font-mono text-[10px] text-mut">
                              ♥ {t.likes}{t.replies > 0 && ` · 💬 ${t.replies}`}
                            </span>
                          </div>
                          <p className="font-mono text-[12px] leading-relaxed text-white/90">
                            {t.text.length > 300 ? `${t.text.slice(0, 300)}…` : t.text}
                          </p>
                        </div>
                      ))}
                    </div>
                  )
                )}
              </div>
            ) : (
              <p className="font-mono text-[12px] text-mut">
                Could not load trader profile.
              </p>
            )}
          </div>
        ) : fomoLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : fomoError ? (
          <div className="rounded-lg border border-dashed border-line p-10 text-center">
            <p className="text-[14px] font-semibold text-white">
              FOMO leaderboard unavailable
            </p>
            <p className="mt-1 font-mono text-[11px] text-mut">
              {fomoError === "FOMO_API_KEY not configured"
                ? "Add a FOMO_API_KEY to enable the leaderboard."
                : fomoError}
            </p>
            <button
              onClick={loadFomo}
              className="mt-3 rounded-lg bg-raised px-4 py-2 font-mono text-[12px] text-white hover:bg-line"
            >
              Retry
            </button>
          </div>
        ) : (
          <div>
            <div className="mb-3 flex items-center justify-between rounded-lg border border-gold/25 bg-gold/5 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[13px] font-bold tracking-wide text-gold">
                  FOMO
                </span>
                <span className="font-mono text-[11px] text-mut">
                  top traders · verified wallets
                </span>
              </div>
              {fomoUpdatedAt > 0 && (
                <span className="font-mono text-[10px] text-mut">
                  {timeAgo(fomoUpdatedAt)}
                </span>
              )}
            </div>
            <div className="space-y-2">
              {fomoTraders.map((t) => (
                <button
                  key={t.handle}
                  onClick={() => loadTrader(t.handle)}
                  className="flex w-full items-center gap-3 rounded-lg border border-line bg-card p-3 text-left hover:border-gold/40"
                >
                  <span
                    className={cn(
                      "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border font-mono text-[12px] font-bold",
                      rankBadge(t.rank)
                    )}
                  >
                    {t.rank}
                  </span>
                  <TraderAvatar handle={t.handle} avatar={t.avatar} size={40} />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1 truncate font-mono text-[13px] font-semibold text-white">
                      <span className="truncate">{t.displayName || `@${t.handle}`}</span>
                      {t.verified && <VerifiedMark />}
                    </p>
                    <p className="truncate font-mono text-[10px] text-mut">
                      @{t.handle}
                      {t.followers > 0 && ` · ${fmtFollowers(t.followers)} followers`}
                      {` · ${t.trade_count} trades`}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p
                      className={cn(
                        "font-mono text-[14px] font-bold",
                        t.pnl_usd >= 0 ? "text-green-400" : "text-red-400"
                      )}
                    >
                      {fmtPnl(t.pnl_usd)}
                    </p>
                    <p className="font-mono text-[11px] text-mut">
                      {t.trade_count} trades
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
    </div>
  );
}
