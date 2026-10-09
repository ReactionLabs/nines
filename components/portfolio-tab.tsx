"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { WalletConnectButton } from "@/components/wallet-connect";
import {
  computeTokenPnl,
  type CostLot,
  type TokenPnl,
  type ValuePoint,
} from "@/lib/wallet-pnl";
import {
  fmtCompactUsd,
  fmtPrice,
  fmtSignedUsd,
  fmtUsd,
  shortMint,
} from "@/lib/format";
import { cn } from "@/lib/utils";

const GOLD = "#e7b84b";
const UP = "#55d187";
const DOWN = "#ff6868";
const MUT = "#8a94a3";
const LINE = "#232a33";

type TokenBalance = {
  mint: string;
  amount: string;
  decimals: number;
  uiAmount: number;
};

interface PriceInfo {
  priceUsd: number | null;
  symbol: string | null;
  name: string | null;
  change24h: number | null;
  imageUrl: string | null;
}

interface PnlResponse {
  ok: boolean;
  computedAt: number;
  txnsScanned: number;
  solPriceUsd: number | null;
  costs: Record<string, CostLot>;
  prices: Record<string, PriceInfo>;
  series: ValuePoint[];
  cached?: boolean;
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "up" | "down";
}) {
  return (
    <div className="rounded-md border border-line bg-surface p-4">
      <p className="font-mono text-[11px] uppercase tracking-widest text-mut">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 font-mono text-2xl font-semibold",
          tone === "up" && "text-up",
          tone === "down" && "text-down",
          !tone && "text-white"
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-1 font-mono text-[11px] text-mut">{sub}</p>}
    </div>
  );
}

function ChartCard({
  title,
  hint,
  children,
  loading,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  loading?: boolean;
}) {
  return (
    <div className="rounded-md border border-line bg-surface p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <p className="font-mono text-[11px] uppercase tracking-widest text-mut">
          {title}
        </p>
        {hint && (
          <p className="font-mono text-[10px] text-mut/60">{hint}</p>
        )}
      </div>
      {loading ? (
        <p className="py-10 text-center font-mono text-xs text-mut">
          Computing…
        </p>
      ) : (
        children
      )}
    </div>
  );
}

const tooltipStyle = {
  background: "#14171b",
  border: "1px solid #232a33",
  borderRadius: 6,
  fontFamily: "monospace",
  fontSize: 11,
};

export function PortfolioTab() {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();

  // Phase 1: balances (fast, from RPC).
  const [sol, setSol] = useState<number | null>(null);
  const [tokens, setTokens] = useState<TokenBalance[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Phase 2: PnL (fills in after balances).
  const [pnl, setPnl] = useState<PnlResponse | null>(null);
  const [pnlLoading, setPnlLoading] = useState(false);
  const [pnlError, setPnlError] = useState<string | null>(null);

  useEffect(() => {
    if (!connected || !publicKey) {
      setSol(null);
      setTokens([]);
      setPnl(null);
      setError(null);
      setPnlError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const lamports = await connection.getBalance(publicKey);
        const parsed = await connection.getParsedTokenAccountsByOwner(
          publicKey,
          {
            programId: new PublicKey(
              "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
            ),
          }
        );
        if (cancelled) return;
        const list: TokenBalance[] = parsed.value
          .map((acc) => acc.account.data.parsed.info as any)
          .map((info) => ({
            mint: info.mint as string,
            amount: info.tokenAmount.amount as string,
            decimals: info.tokenAmount.decimals as number,
            uiAmount: info.tokenAmount.uiAmount as number,
          }))
          .filter((t) => t.uiAmount > 0);
        setSol(lamports / 1_000_000_000);
        setTokens(list);
        setError(null);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load balances");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, publicKey, connected]);

  const loadPnl = useCallback(
    async (refresh = false) => {
      if (!publicKey) return;
      setPnlLoading(true);
      setPnlError(null);
      try {
        const res = await fetch(
          `/api/wallet/pnl?address=${publicKey.toBase58()}${
            refresh ? "&refresh=1" : ""
          }`
        );
        const data = (await res.json()) as PnlResponse & { error?: string };
        if (!res.ok || !data.ok) {
          throw new Error(data.error ?? `PnL lookup failed (${res.status})`);
        }
        setPnl(data);
      } catch (e) {
        setPnlError(e instanceof Error ? e.message : "PnL lookup failed");
      } finally {
        setPnlLoading(false);
      }
    },
    [publicKey]
  );

  // Phase 2 kicks off once balances are in.
  useEffect(() => {
    if (connected && !loading && sol !== null && !pnl && !pnlLoading) {
      loadPnl(false);
    }
  }, [connected, loading, sol, pnl, pnlLoading, loadPnl]);

  // Merge RPC balances + PnL costs/prices.
  const enriched: TokenPnl[] = useMemo(() => {
    if (!pnl) return [];
    const inputs = tokens.map((t) => {
      const p = pnl.prices[t.mint];
      return {
        mint: t.mint,
        symbol: p?.symbol ?? null,
        name: p?.name ?? null,
        balance: t.uiAmount,
        priceUsd: p?.priceUsd ?? null,
        change24h: p?.change24h ?? null,
        imageUrl: p?.imageUrl ?? null,
      };
    });
    return computeTokenPnl(inputs, pnl.costs, pnl.solPriceUsd).sort(
      (a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0)
    );
  }, [tokens, pnl]);

  const summary = useMemo(() => {
    let totalValue = 0;
    let totalCost = 0;
    let priced = 0;
    let best: TokenPnl | null = null;
    let worst: TokenPnl | null = null;
    for (const t of enriched) {
      if (t.valueUsd !== null) {
        totalValue += t.valueUsd;
        priced++;
      }
      if (t.costUsd !== null) totalCost += t.costUsd;
      if (t.pnlPct !== null) {
        if (!best || (t.pnlPct ?? 0) > (best.pnlPct ?? 0)) best = t;
        if (!worst || (t.pnlPct ?? 0) < (worst.pnlPct ?? 0)) worst = t;
      }
    }
    // Add SOL to total value.
    const solValue =
      sol !== null && pnl?.solPriceUsd ? sol * pnl.solPriceUsd : null;
    if (solValue !== null) totalValue += solValue;
    const tokenPnlUsd = enriched.reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
    const tokenPnlPct = totalCost > 1e-9 ? tokenPnlUsd / totalCost : null;
    return {
      totalValue,
      totalCost,
      tokenPnlUsd,
      tokenPnlPct,
      solValue,
      priced,
      best,
      worst,
    };
  }, [enriched, sol, pnl]);

  const barData = useMemo(
    () =>
      enriched
        .filter((t) => t.pnlUsd !== null)
        .map((t) => ({
          name: t.symbol ?? shortMint(t.mint),
          pnl: t.pnlUsd as number,
        }))
        .sort((a, b) => b.pnl - a.pnl)
        .slice(0, 12),
    [enriched]
  );

  const allocData = useMemo(() => {
    const rows = enriched
      .filter((t) => (t.valueUsd ?? 0) > 0)
      .map((t) => ({
        name: t.symbol ?? shortMint(t.mint),
        value: t.valueUsd as number,
      }));
    if (summary.solValue && summary.solValue > 0)
      rows.push({ name: "SOL", value: summary.solValue });
    return rows.sort((a, b) => b.value - a.value).slice(0, 10);
  }, [enriched, summary.solValue]);

  const seriesData = useMemo(
    () =>
      (pnl?.series ?? []).map((p) => ({
        ...p,
        date: new Date(p.t).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        }),
      })),
    [pnl]
  );

  const DONUT_COLORS = [
    GOLD,
    "#72a9c9",
    "#55d187",
    "#b48be0",
    "#e08b9a",
    "#8bd1c9",
    "#d1c48b",
    "#9a8be0",
    "#8be09a",
    "#e0b48b",
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="font-mono text-[11px] uppercase tracking-widest text-mut">
          Portfolio · read-only
        </p>
        <div className="flex items-center gap-2">
          {connected && pnl && (
            <button
              onClick={() => loadPnl(true)}
              disabled={pnlLoading}
              className="rounded border border-line bg-surface px-3 py-1.5 font-mono text-[11px] text-mut hover:text-white disabled:opacity-50"
            >
              {pnlLoading ? "Refreshing…" : "Refresh PnL"}
            </button>
          )}
          <WalletConnectButton />
        </div>
      </div>

      {!connected && (
        <div className="rounded-md border border-line bg-surface px-4 py-8 text-center">
          <p className="font-mono text-xs text-mut">
            Connect a wallet to view holdings and PnL.
          </p>
          <p className="mt-1 font-mono text-[11px] text-mut/60">
            Jupiter, Phantom, Solflare, or Backpack. Nothing is signed.
          </p>
        </div>
      )}

      {connected && loading && (
        <p className="font-mono text-xs text-mut">Loading balances…</p>
      )}

      {error && <p className="font-mono text-xs text-down">{error}</p>}

      {connected && !loading && sol !== null && (
        <div className="space-y-4">
          {/* Summary header */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label="Total value"
              value={fmtCompactUsd(summary.totalValue)}
              sub={
                summary.solValue !== null
                  ? `incl. ${fmtCompactUsd(summary.solValue)} SOL`
                  : undefined
              }
            />
            <Stat
              label="Token PnL"
              value={fmtSignedUsd(summary.tokenPnlUsd)}
              sub={
                summary.tokenPnlPct !== null
                  ? `${(summary.tokenPnlPct * 100).toFixed(1)}% unrealized`
                  : "cost basis pending"
              }
              tone={
                summary.tokenPnlUsd > 0
                  ? "up"
                  : summary.tokenPnlUsd < 0
                    ? "down"
                    : undefined
              }
            />
            <Stat
              label="SOL balance"
              value={`${sol.toFixed(4)}`}
              sub={
                pnl?.solPriceUsd
                  ? `${fmtUsd(pnl.solPriceUsd, 2)} / SOL`
                  : undefined
              }
            />
            <Stat
              label="Positions"
              value={String(tokens.length)}
              sub={
                pnl
                  ? `${pnl.txnsScanned} txns scanned${pnl.cached ? " · cached" : ""}`
                  : pnlLoading
                    ? "scanning history…"
                    : undefined
              }
            />
          </div>

          {pnlError && (
            <p className="font-mono text-xs text-down">
              PnL unavailable: {pnlError}
            </p>
          )}

          {/* Charts */}
          {(pnl || pnlLoading) && (
            <>
              <ChartCard
                title="Holdings value over time"
                hint="at current prices"
                loading={pnlLoading && !pnl}
              >
                {seriesData.length > 1 ? (
                  <div className="h-52 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart
                        data={seriesData}
                        margin={{ top: 5, right: 10, left: 0, bottom: 0 }}
                      >
                        <defs>
                          <linearGradient id="pnlVal" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={GOLD} stopOpacity={0.35} />
                            <stop offset="100%" stopColor={GOLD} stopOpacity={0.02} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid stroke={LINE} strokeDasharray="3 3" />
                        <XAxis
                          dataKey="date"
                          tick={{ fill: MUT, fontSize: 10, fontFamily: "monospace" }}
                          stroke={LINE}
                          minTickGap={30}
                        />
                        <YAxis
                          tickFormatter={(v: number) =>
                            `$${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : Math.round(v)}`
                          }
                          tick={{ fill: MUT, fontSize: 10, fontFamily: "monospace" }}
                          stroke={LINE}
                          width={55}
                        />
                        <Tooltip
                          contentStyle={tooltipStyle}
                          labelStyle={{ color: MUT }}
                          formatter={(v, name) => [
                            fmtUsd(Number(v), 2),
                            name === "value" ? "holdings" : "cost",
                          ]}
                        />
                        <Area
                          type="monotone"
                          dataKey="value"
                          stroke={GOLD}
                          strokeWidth={2}
                          fill="url(#pnlVal)"
                        />
                        <Area
                          type="monotone"
                          dataKey="cost"
                          stroke={MUT}
                          strokeWidth={1}
                          strokeDasharray="4 4"
                          fill="none"
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <p className="py-10 text-center font-mono text-xs text-mut/60">
                    Not enough history for a chart yet.
                  </p>
                )}
              </ChartCard>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <ChartCard title="PnL by token" loading={pnlLoading && !pnl}>
                  {barData.length > 0 ? (
                    <div className="h-52 w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          data={barData}
                          margin={{ top: 5, right: 10, left: 0, bottom: 0 }}
                          layout="vertical"
                        >
                          <CartesianGrid stroke={LINE} strokeDasharray="3 3" />
                          <XAxis
                            type="number"
                            tickFormatter={(v: number) =>
                              v >= 1000 || v <= -1000
                                ? `$${(v / 1000).toFixed(1)}k`
                                : `$${Math.round(v)}`
                            }
                            tick={{ fill: MUT, fontSize: 10, fontFamily: "monospace" }}
                            stroke={LINE}
                          />
                          <YAxis
                            type="category"
                            dataKey="name"
                            tick={{ fill: MUT, fontSize: 10, fontFamily: "monospace" }}
                            stroke={LINE}
                            width={70}
                          />
                          <Tooltip
                            contentStyle={tooltipStyle}
                            formatter={(v) => [
                              fmtSignedUsd(Number(v)),
                              "PnL",
                            ]}
                          />
                          <Bar dataKey="pnl" radius={[0, 3, 3, 0]}>
                            {barData.map((d, i) => (
                              <Cell
                                key={i}
                                fill={d.pnl >= 0 ? UP : DOWN}
                              />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <p className="py-10 text-center font-mono text-xs text-mut/60">
                      No cost basis yet — PnL bars appear once swap history loads.
                    </p>
                  )}
                </ChartCard>

                <ChartCard title="Allocation" loading={pnlLoading && !pnl}>
                  {allocData.length > 0 ? (
                    <div className="h-52 w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={allocData}
                            dataKey="value"
                            nameKey="name"
                            innerRadius="55%"
                            outerRadius="85%"
                            strokeWidth={0}
                            paddingAngle={2}
                          >
                            {allocData.map((_, i) => (
                              <Cell
                                key={i}
                                fill={DONUT_COLORS[i % DONUT_COLORS.length]}
                              />
                            ))}
                          </Pie>
                          <Tooltip
                            contentStyle={tooltipStyle}
                            formatter={(v, name) => [
                              fmtUsd(Number(v), 2),
                              name,
                            ]}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <p className="py-10 text-center font-mono text-xs text-mut/60">
                      Nothing priced yet.
                    </p>
                  )}
                </ChartCard>
              </div>
            </>
          )}

          {/* Token table */}
          <div className="rounded-md border border-line bg-surface p-4">
            <p className="mb-2 font-mono text-[11px] uppercase tracking-widest text-mut">
              Tokens ({tokens.length})
            </p>
            {tokens.length === 0 && (
              <p className="font-mono text-xs text-mut/60">No token balances.</p>
            )}
            {tokens.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] font-mono text-xs">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-mut/70">
                      <th className="pb-2 pr-3 font-normal">Token</th>
                      <th className="pb-2 pr-3 text-right font-normal">Balance</th>
                      <th className="pb-2 pr-3 text-right font-normal">Price</th>
                      <th className="pb-2 pr-3 text-right font-normal">Value</th>
                      <th className="pb-2 pr-3 text-right font-normal">Cost basis</th>
                      <th className="pb-2 pr-3 text-right font-normal">PnL $</th>
                      <th className="pb-2 pr-3 text-right font-normal">PnL %</th>
                      <th className="pb-2 text-right font-normal">24h</th>
                    </tr>
                  </thead>
                  <tbody>
                    {enriched.map((t) => (
                      <tr key={t.mint} className="border-t border-line/50">
                        <td className="py-2 pr-3">
                          <div className="flex items-center gap-2">
                            {t.imageUrl && (
                              <img
                                src={t.imageUrl}
                                alt=""
                                className="h-5 w-5 rounded-full"
                                loading="lazy"
                              />
                            )}
                            <div>
                              <p className="text-white">
                                {t.symbol ?? shortMint(t.mint)}
                              </p>
                              {t.symbol && (
                                <p className="text-[10px] text-mut/60">
                                  {shortMint(t.mint)}
                                </p>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="py-2 pr-3 text-right text-white">
                          {t.balance.toLocaleString(undefined, {
                            maximumFractionDigits: 2,
                          })}
                        </td>
                        <td className="py-2 pr-3 text-right text-mut">
                          {t.priceUsd !== null ? fmtPrice(t.priceUsd) : "—"}
                        </td>
                        <td className="py-2 pr-3 text-right text-white">
                          {t.valueUsd !== null ? fmtUsd(t.valueUsd, 2) : "—"}
                        </td>
                        <td className="py-2 pr-3 text-right text-mut">
                          {t.basisStatus === "ok" && t.costUsd !== null ? (
                            fmtUsd(t.costUsd, 2)
                          ) : t.basisStatus === "transfer-in" ? (
                            <span title="Received via transfer, no buy history">
                              transfer-in
                            </span>
                          ) : pnlLoading ? (
                            "…"
                          ) : (
                            <span title="No swap history found for this token">
                              unknown
                            </span>
                          )}
                        </td>
                        <td
                          className={cn(
                            "py-2 pr-3 text-right",
                            (t.pnlUsd ?? 0) > 0 && "text-up",
                            (t.pnlUsd ?? 0) < 0 && "text-down",
                            t.pnlUsd === null && "text-mut/50"
                          )}
                        >
                          {t.pnlUsd !== null ? fmtSignedUsd(t.pnlUsd) : "—"}
                        </td>
                        <td
                          className={cn(
                            "py-2 pr-3 text-right",
                            (t.pnlPct ?? 0) > 0 && "text-up",
                            (t.pnlPct ?? 0) < 0 && "text-down",
                            t.pnlPct === null && "text-mut/50"
                          )}
                        >
                          {t.pnlPct !== null
                            ? `${(t.pnlPct * 100).toFixed(1)}%`
                            : "—"}
                        </td>
                        <td
                          className={cn(
                            "py-2 text-right",
                            (t.change24h ?? 0) > 0 && "text-up",
                            (t.change24h ?? 0) < 0 && "text-down",
                            t.change24h === null && "text-mut/50"
                          )}
                        >
                          {t.change24h !== null
                            ? `${t.change24h > 0 ? "+" : ""}${t.change24h.toFixed(1)}%`
                            : "—"}
                        </td>
                      </tr>
                    ))}
                    {/* Tokens still loading PnL (balances known, API pending) */}
                    {!pnl &&
                      pnlLoading &&
                      tokens.length > 0 &&
                      enriched.length === 0 && (
                        <tr>
                          <td
                            colSpan={8}
                            className="py-4 text-center text-mut"
                          >
                            Scanning swap history for cost basis…
                          </td>
                        </tr>
                      )}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {summary.best && (
            <div className="flex flex-wrap gap-3 font-mono text-[11px] text-mut">
              <span>
                Best:{" "}
                <span className="text-up">
                  {summary.best.symbol ?? shortMint(summary.best.mint)}{" "}
                  {summary.best.pnlPct !== null
                    ? `+${(summary.best.pnlPct * 100).toFixed(1)}%`
                    : ""}
                </span>
              </span>
              {summary.worst && summary.worst.mint !== summary.best.mint && (
                <span>
                  Worst:{" "}
                  <span className="text-down">
                    {summary.worst.symbol ?? shortMint(summary.worst.mint)}{" "}
                    {summary.worst.pnlPct !== null
                      ? `${(summary.worst.pnlPct * 100).toFixed(1)}%`
                      : ""}
                  </span>
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
