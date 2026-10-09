"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";
import { TokenIcon } from "@/components/token-image";
import { cn } from "@/lib/utils";

interface EstablishedCoin {
  mint: string;
  symbol: string;
  name: string;
  priceUsd: number;
  mcapUsd: number;
  vol24h: number;
  change24h: number;
  imageUrl: string | null;
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtPrice(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.0001) return `$${n.toExponential(2)}`;
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/**
 * Established coins: blue-chip meme coins that made it.
 * Tapping a coin goes to its full detail page.
 */
export function EstablishedCoins() {
  const router = useRouter();
  const [coins, setCoins] = useState<EstablishedCoin[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/established")
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled && d.ok) setCoins(d.coins ?? []);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (coins.length === 0) return null;

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <span className="font-mono text-[13px] font-bold tracking-wide text-gold">
          ESTABLISHED
        </span>
        <span className="font-mono text-[11px] text-mut">
          blue chips · made it
        </span>
      </div>
      <div className="space-y-2">
        {coins.map((c) => (
          <button
            key={c.mint}
            onClick={() => router.push(`/coin/${encodeURIComponent(c.mint)}`)}
            className="flex w-full items-center gap-3 rounded-lg border border-line bg-card p-3 text-left hover:border-gold/40"
          >
            <TokenIcon src={c.imageUrl} symbol={c.symbol} size="md" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-[13px] font-semibold text-white">
                {c.symbol}
              </p>
              <p className="truncate font-mono text-[10px] text-mut">
                {fmtPrice(c.priceUsd)} · MCap {fmtUsd(c.mcapUsd)}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p
                className={cn(
                  "font-mono text-[13px] font-bold",
                  c.change24h >= 0 ? "text-green-400" : "text-red-400"
                )}
              >
                {c.change24h >= 0 ? "+" : ""}
                {c.change24h.toFixed(1)}%
              </p>
              <p className="font-mono text-[10px] text-mut">
                Vol {fmtUsd(c.vol24h)}
              </p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
