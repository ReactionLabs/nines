"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Server-sent events subscription for terminal streams.
 *
 * The live data stream IS the connection indicator (per Dip: no separate
 * heartbeat poll, no pulsing animations). If events are flowing, the
 * terminal is alive. If the stream goes quiet, the UI degrades honestly:
 *
 *   live    — an event arrived within the last 5s. Solid green dot.
 *   stale   — quiet for 5–30s. Amber dot. Data may be old.
 *   offline — quiet 30s+ or the transport failed. Gray dot.
 *             Callers should fall back to their polling loops.
 *
 * EventSource auto-reconnects on its own; after repeated failures we stop
 * retrying SSE for the session and report offline so polling takes over.
 */

export type StreamMode = "live" | "stale" | "offline";

export interface TradeItem {
  sig: string;
  mint: string;
  isBuy: boolean;
  sol: number;
  tokens: number;
  user?: string;
  at: number;
}

export interface StreamSnapshot {
  mode: StreamMode;
  /** ms epoch of the last received event, null if none yet. */
  lastEventAt: number | null;
  reconnects: number;
  /** Latest price per mint from the prices topic. */
  prices: Record<string, number>;
  /** Recent trades from the trades topic, newest first (cap 100). */
  trades: TradeItem[];
  /** True while the SSE transport is up (even if quiet). */
  transportUp: boolean;
}

export type StreamTopic = "status" | "pairs" | "alerts" | "prices" | "trades";

export interface UseStreamOpts {
  topics?: StreamTopic[];
  /** Mints to include in the prices topic (max ~30). */
  mints?: string[];
  onEvent?: (topic: StreamTopic, data: any) => void;
  enabled?: boolean;
}

const STALE_MS = 5_000;
const OFFLINE_MS = 30_000;
const MAX_ES_FAILURES = 3;

const EMPTY: StreamSnapshot = {
  mode: "offline",
  lastEventAt: null,
  reconnects: 0,
  prices: {},
  trades: [],
  transportUp: false,
};

function asTradeItem(data: any): TradeItem | null {
  if (!data || typeof data !== "object") return null;
  // Ingest envelope shape: { id, ts, mint, data: { sig, isBuy, sol, tokens, user } }
  const inner =
    data.data && typeof data.data === "object" ? data.data : data;
  const sig = typeof inner.sig === "string" ? inner.sig : null;
  const mint =
    typeof data.mint === "string"
      ? data.mint
      : typeof inner.mint === "string"
        ? inner.mint
        : null;
  if (!sig || !mint) return null;
  const sol = Number(inner.sol);
  const tokens = Number(inner.tokens);
  if (!Number.isFinite(sol) || !Number.isFinite(tokens)) return null;
  const at = Number(data.ts ?? inner.at ?? 0);
  return {
    sig,
    mint,
    isBuy: inner.isBuy === true,
    sol,
    tokens,
    user: typeof inner.user === "string" ? inner.user : undefined,
    at: Number.isFinite(at) && at > 0 ? at : Date.now(),
  };
}

function asPriceTick(data: any): { mint: string; price: number } | null {
  if (!data || typeof data !== "object") return null;
  const inner =
    data.data && typeof data.data === "object" ? data.data : data;
  const mint = typeof data.mint === "string" ? data.mint : null;
  const price = Number(inner.price ?? data.price);
  if (!mint || !Number.isFinite(price) || price <= 0) return null;
  return { mint, price };
}

export function useStream(opts: UseStreamOpts = {}): StreamSnapshot {
  const { topics, mints, enabled = true } = opts;
  const onEventRef = useRef(opts.onEvent);
  onEventRef.current = opts.onEvent;

  const [snap, setSnap] = useState<StreamSnapshot>(EMPTY);
  const stateRef = useRef({
    lastEventAt: null as number | null,
    reconnects: 0,
    failures: 0,
    prices: {} as Record<string, number>,
    trades: [] as TradeItem[],
    seenSigs: new Set<string>(),
    transportUp: false,
    givenUp: false,
  });

  const topicsKey = (topics ?? []).join(",");
  const mintsKey = (mints ?? []).join(",");

  const computeMode = useCallback((): StreamMode => {
    const s = stateRef.current;
    if (!s.transportUp && s.failures >= MAX_ES_FAILURES) return "offline";
    if (s.lastEventAt === null) return s.transportUp ? "stale" : "offline";
    const age = Date.now() - s.lastEventAt;
    if (age <= STALE_MS) return "live";
    if (age <= OFFLINE_MS) return "stale";
    return "offline";
  }, []);

  const publish = useCallback(() => {
    const s = stateRef.current;
    setSnap({
      mode: computeMode(),
      lastEventAt: s.lastEventAt,
      reconnects: s.reconnects,
      prices: { ...s.prices },
      trades: [...s.trades],
      transportUp: s.transportUp,
    });
  }, [computeMode]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    if (typeof EventSource === "undefined") {
      stateRef.current.failures = MAX_ES_FAILURES;
      publish();
      return;
    }
    const s = stateRef.current;
    if (s.givenUp) return;

    const params = new URLSearchParams();
    if (topicsKey) params.set("topics", topicsKey);
    if (mintsKey) params.set("mints", mintsKey);
    const es = new EventSource(`/api/stream?${params.toString()}`);

    const onAnyEvent = (topic: StreamTopic, data: any) => {
      s.lastEventAt = Date.now();
      s.transportUp = true;
      if (topic === "prices") {
        const tick = asPriceTick(data);
        if (tick) s.prices[tick.mint] = tick.price;
      }
      if (topic === "trades") {
        const item = asTradeItem(data);
        if (item && !s.seenSigs.has(item.sig)) {
          s.seenSigs.add(item.sig);
          // Multi-mint subscribers filter client-side.
          if (!mints || mints.length === 0 || mints.includes(item.mint)) {
            s.trades.unshift(item);
            if (s.trades.length > 100) s.trades.length = 100;
          }
          if (s.seenSigs.size > 2000) {
            const first = s.seenSigs.values().next().value;
            if (first) s.seenSigs.delete(first);
          }
        }
      }
      try {
        onEventRef.current?.(topic, data);
      } catch {
        /* subscriber errors must not kill the stream */
      }
      publish();
    };

    const topics_ = (topics ?? ["status", "pairs", "alerts", "prices"]) as StreamTopic[];
    for (const t of topics_) {
      es.addEventListener(t, (ev) => {
        try {
          onAnyEvent(t, JSON.parse((ev as MessageEvent).data));
        } catch {
          /* malformed payload: ignore */
        }
      });
    }
    es.onopen = () => {
      s.transportUp = true;
      s.failures = 0;
      publish();
    };
    es.onerror = () => {
      s.transportUp = false;
      s.failures += 1;
      s.reconnects += 1;
      if (s.failures >= MAX_ES_FAILURES) {
        s.givenUp = true;
        try {
          es.close();
        } catch {
          /* already closed */
        }
      }
      publish();
    };

    // Watchdog: re-evaluate live/stale/offline even with no events.
    const watchdog = setInterval(publish, 1000);

    return () => {
      clearInterval(watchdog);
      try {
        es.close();
      } catch {
        /* already closed */
      }
      s.transportUp = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, topicsKey, mintsKey]);

  return snap;
}
