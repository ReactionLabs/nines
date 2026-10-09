"use client";

import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { shortMint, fmtUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

type Holding = { mint: string; amount: number; usd_value: number | null };
type Wallet = {
  address: string;
  label: string;
  total_usd: number;
  holding_count: number;
  holdings: Holding[];
};
type RecentBuy = {
  label: string;
  mint: string;
  usd_value: number | null;
  time: number;
  signature: string;
};
type WatchData = {
  ok: boolean;
  live: boolean;
  updatedAt: number;
  wallets: Wallet[];
  recentBuys: RecentBuy[];
};

const FRESH_SECS = 15 * 60;

function ago(ts: number): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function FreshPill({ updatedAt, live }: { updatedAt: number; live: boolean }) {
  const fresh =
    live && updatedAt > 0 && Date.now() / 1000 - updatedAt < FRESH_SECS;
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wide",
        fresh ? "bg-[#55d187]/15 text-[#55d187]" : "bg-[#e7b84b]/15 text-[#e7b84b]"
      )}
      title={
        fresh
          ? "Holdings snapshot is current"
          : "Snapshot is stale or missing — check the watcher"
      }
    >
      {fresh ? `LIVE · ${ago(updatedAt)}` : updatedAt > 0 ? `STALE · ${ago(updatedAt)}` : "NO DATA"}
    </span>
  );
}

export function WatchedTab({ onSelectMint }: { onSelectMint: (mint: string) => void }) {
  const [data, setData] = useState<WatchData | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/watchlist");
      if (res.ok) setData(await res.json());
    } catch {
      /* keep last data */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  if (data === null) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-mut">
          Signal wallets, not gates. Buys here trigger push alerts; they never
          touch the nine checks.
        </p>
        <FreshPill updatedAt={data.updatedAt} live={data.live} />
      </div>

      {data.wallets.length === 0 && (
        <Card className="p-6 text-center text-sm text-mut">
          No watched wallets yet. Add addresses to wallets/watchlist.txt
          box-side.
        </Card>
      )}

      {data.wallets.map((w) => (
        <Card key={w.address} className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <p className="font-semibold">{w.label || shortMint(w.address)}</p>
              <p className="font-mono text-[11px] text-mut">{w.address}</p>
            </div>
            <div className="text-right">
              <p className="font-mono text-lg font-semibold">
                {fmtUsd(w.total_usd)}
              </p>
              <p className="text-[11px] text-mut">
                {w.holding_count} position{w.holding_count === 1 ? "" : "s"}
              </p>
            </div>
          </div>
          {w.holdings.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-mut">
                    <th className="py-1 pr-3 font-medium">Mint</th>
                    <th className="py-1 pr-3 text-right font-medium">Amount</th>
                    <th className="py-1 text-right font-medium">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {w.holdings.map((h) => (
                    <tr key={h.mint} className="border-t border-line/60">
                      <td className="py-1.5 pr-3 font-mono text-[12px]">
                        <button
                          onClick={() => onSelectMint(h.mint)}
                          className="text-gold hover:underline"
                          title="Open chart"
                        >
                          {shortMint(h.mint)}
                        </button>{" "}
                        <a
                          href={`https://solscan.io/token/${h.mint}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-mut hover:text-gold"
                          title="Open in Solscan"
                        >
                          &#8599;
                        </a>
                      </td>
                      <td className="py-1.5 pr-3 text-right font-mono text-[12px]">
                        {h.amount >= 1_000_000
                          ? `${(h.amount / 1_000_000).toFixed(1)}M`
                          : h.amount >= 1_000
                            ? `${(h.amount / 1_000).toFixed(1)}K`
                            : h.amount.toFixed(2)}
                      </td>
                      <td className="py-1.5 text-right font-mono text-[12px]">
                        {h.usd_value != null ? fmtUsd(h.usd_value) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {w.holding_count > w.holdings.length && (
                <p className="mt-2 text-[11px] text-mut">
                  Showing top {w.holdings.length} of {w.holding_count} by value.
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-mut">No current positions.</p>
          )}
        </Card>
      ))}

      {data.recentBuys.length > 0 && (
        <Card className="p-4">
          <p className="mb-2 font-semibold">Recent buys</p>
          <div className="space-y-1.5">
            {data.recentBuys.map((b) => (
              <div
                key={b.signature}
                className="flex items-center justify-between text-sm"
              >
                <p>
                  <span className="font-medium">{b.label}</span>
                  <span className="text-mut"> bought </span>
                  <button
                    onClick={() => onSelectMint(b.mint)}
                    className="font-mono text-[12px] text-gold hover:underline"
                    title="Open chart"
                  >
                    {shortMint(b.mint)}
                  </button>
                  {b.usd_value != null && (
                    <span className="font-mono text-[12px] text-mut">
                      {" "}
                      ({fmtUsd(b.usd_value)})
                    </span>
                  )}
                </p>
                <p className="font-mono text-[11px] text-mut">{ago(b.time)}</p>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
