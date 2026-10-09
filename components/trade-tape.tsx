"use client";

import { useEffect, useState } from "react";
import { getChainSocket } from "@/lib/chain/use-chain-stream";
import {
  parsePumpTradeEvent,
  programDataPayloads,
  shortSig,
} from "@/lib/chain/filters";
import { useStream, type TradeItem } from "@/lib/stream/use-stream";
import { cn } from "@/lib/utils";

/**
 * Live trade tape: every buy/sell on a watched token.
 *
 * Primary path: the box ingestor streams on-chain trades via SSE
 * (topics=trades). Fallback: direct Helius WebSocket from the browser
 * when the SSE stream is offline. If neither is available, the tape
 * says so honestly instead of faking flow.
 */

interface TapeItem {
  sig: string;
  isBuy: boolean;
  sol: number;
  tokens: number;
  at: number;
  user: string;
  src: "sse" | "chain";
}

function fmtTime(at: number): string {
  const d = new Date(at);
  return d.toLocaleTimeString("en-US", { hour12: false });
}

function fromStreamItem(t: TradeItem): TapeItem {
  return {
    sig: t.sig,
    isBuy: t.isBuy,
    sol: t.sol,
    tokens: t.tokens,
    at: t.at,
    user: t.user ?? "",
    src: "sse",
  };
}

export function TradeTape({ mint }: { mint: string }) {
  const stream = useStream({ topics: ["trades"], mints: [mint] });
  const [items, setItems] = useState<TapeItem[]>([]);
  const [chainAvailable, setChainAvailable] = useState<boolean | null>(null);

  // SSE path: trades arrive via useStream.
  useEffect(() => {
    if (stream.trades.length === 0) return;
    setItems((prev) => {
      const seen = new Set(prev.map((t) => t.sig));
      const fresh = stream.trades
        .filter((t) => !seen.has(t.sig))
        .map(fromStreamItem);
      if (fresh.length === 0) return prev;
      return [...fresh, ...prev].slice(0, 50);
    });
  }, [stream.trades]);

  // Fallback path: direct chain socket when SSE is offline.
  useEffect(() => {
    if (stream.mode !== "offline") {
      setChainAvailable(null);
      return;
    }
    const sock = getChainSocket();
    if (!sock || !sock.available) {
      setChainAvailable(false);
      return;
    }
    setChainAvailable(true);
    const key = `tape:${mint}`;
    sock.subscribeLogs(key, [{ mentions: [mint] }, { commitment: "confirmed" }], (e) => {
      const logs: string[] = e.payload?.value?.logs ?? [];
      const sig: string = e.payload?.value?.signature ?? "";
      if (e.payload?.value?.err) return; // failed txs aren't trades
      const payloads = programDataPayloads(logs);
      if (payloads.length === 0 || !sig) return;
      (async () => {
        for (const p of payloads) {
          const t = await parsePumpTradeEvent(p);
          if (!t || t.mint !== mint) continue;
          setItems((prev) => {
            if (prev.some((x) => x.sig === sig)) return prev;
            return [
              {
                sig,
                isBuy: t.isBuy,
                sol: t.solAmount,
                tokens: t.tokenAmount,
                at: Date.now(),
                user: t.user,
                src: "chain" as const,
              },
              ...prev,
            ].slice(0, 50);
          });
        }
      })();
    });
    return () => {
      sock.unsubscribe(key);
    };
  }, [mint, stream.mode]);

  const live = stream.mode === "live";

  if (stream.mode === "offline" && chainAvailable === false) {
    return (
      <p className="font-mono text-[11px] text-mut">
        Live tape unavailable: stream offline and chain stream not configured.
      </p>
    );
  }

  return (
    <div>
      <p className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-mut">
        Trade tape
        <span
          className={cn(
            "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]",
            live ? "bg-up/10 text-up" : "bg-amber-500/10 text-amber-500"
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              live ? "bg-up" : "bg-amber-500"
            )}
          />
          {live ? "live" : stream.mode}
        </span>
      </p>
      {items.length === 0 ? (
        <p className="font-mono text-[11px] text-mut/70">
          Listening for on-chain trades…
        </p>
      ) : (
        <ul className="max-h-48 space-y-1 overflow-y-auto font-mono text-[11px]">
          {items.map((t) => (
            <li
              key={t.sig}
              className="flex items-center justify-between gap-2 rounded bg-raised px-2 py-1"
            >
              <span
                className={cn(
                  "w-10 shrink-0 font-bold",
                  t.isBuy ? "text-up" : "text-down"
                )}
              >
                {t.isBuy ? "BUY" : "SELL"}
              </span>
              <span className="text-white">
                {t.sol < 0.01 ? t.sol.toFixed(4) : t.sol.toFixed(2)} SOL
              </span>
              <span className="truncate text-mut">{shortSig(t.sig)}</span>
              <span className="shrink-0 text-mut/70">{fmtTime(t.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
