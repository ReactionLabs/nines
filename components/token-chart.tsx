"use client";

import { useEffect, useRef, useState } from "react";
import {
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { cn } from "@/lib/utils";
import { useStream } from "@/lib/stream/use-stream";

type TfKey = "1s" | "5s" | "15s" | "30s" | "1m" | "5m" | "15m" | "1H";
const TFS: TfKey[] = ["1s", "5s", "15s", "30s", "1m", "5m", "15m", "1H"];
const TICK_TFS: ReadonlySet<string> = new Set(["1s", "5s", "15s", "30s"]);
// API quirk: the history map keys the hour timeframe "1h".
const apiTf = (tf: TfKey): string => (tf === "1H" ? "1h" : tf);

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

const UP = "#26a69a";
const DOWN = "#ef5350";
const WHALE_GOLD = "#f0b90b";

// Bucket seconds per timeframe, for snapping whale-buy markers to candles.
const WHALE_TF_SECS: Record<TfKey, number> = {
  "1s": 1,
  "5s": 5,
  "15s": 15,
  "30s": 30,
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1H": 3600,
};

type Status = "loading" | "collecting" | "ready" | "empty" | "error";

/**
 * Native price chart for the token drawer. TradingView Lightweight Charts,
 * dark terminal styling, fed by REAL data only.
 *
 * Two provenances, always labeled:
 * - HISTORY (5m/15m/1H): GeckoTerminal OHLCV via /api/candles.
 * - LIVE TICKS (1s/5s/15s/30s): our own tick feed. Prices stream in over
 *   SSE (/api/stream, prices topic) and accumulate CLIENT-side, bucketed
 *   into candles locally. If the stream drops, a 1s /api/ticks fallback
 *   poll takes over automatically. Browser-side accumulation keeps the
 *   candle set consistent (serverless instances can't share state).
 *   Candles aggregate from real ticks only — never synthesized,
 *   interpolated, or backfilled, so a fresh session shows
 *   "collecting live ticks…" until ticks land.
 *
 * Phone-native: touch drag pans horizontally, pinch zooms, vertical drag
 * scrolls the drawer (chart doesn't steal it), crosshair on touch-drag.
 */
export function TokenChart({
  mint,
  whaleBuys,
}: {
  mint: string;
  /** Buy timestamps (unix seconds) by tracked wallets — rendered as markers. */
  whaleBuys?: number[];
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const [tf, setTf] = useState<TfKey>("5m");
  const [status, setStatus] = useState<Status>("loading");
  const [tickMeta, setTickMeta] = useState<{
    tickCount: number;
    degraded: boolean;
  } | null>(null);

  const isTickTf = TICK_TFS.has(tf);

  /**
   * Live stream replaces the 1s /api/ticks poll: prices arrive via SSE and
   * feed the same client-side tick store. The poll below is fallback only.
   */
  const stream = useStream({
    topics: ["prices"],
    mints: [mint],
    enabled: isTickTf,
  });
  const streamLive = stream.mode === "live";
  const streamLiveRef = useRef(streamLive);
  streamLiveRef.current = streamLive;

  /** Shared tick ingester: fed by the stream or the fallback poll. */
  const ingestRef = useRef<(price: number, degraded: boolean) => void>(() => {});

  // Create the chart once per mount.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#7d8590",
        fontSize: 10,
        fontFamily:
          "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
      },
      grid: {
        vertLines: { color: "rgba(148,163,184,0.06)" },
        horzLines: { color: "rgba(148,163,184,0.06)" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          width: 1,
          color: "rgba(148,163,184,0.45)",
          style: 2,
          labelBackgroundColor: "#2d333b",
        },
        horzLine: {
          width: 1,
          color: "rgba(148,163,184,0.45)",
          style: 2,
          labelBackgroundColor: "#2d333b",
        },
      },
      rightPriceScale: { borderColor: "rgba(148,163,184,0.12)" },
      timeScale: {
        borderColor: "rgba(148,163,184,0.12)",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
      },
      // Phone-native gestures: horizontal drag pans the chart,
      // vertical drag is left to the drawer scroll, pinch zooms.
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: true,
      },
      kineticScroll: { mouse: false, touch: true },
    });

    const candles = chart.addCandlestickSeries({
      upColor: UP,
      downColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      borderVisible: false,
      priceLineVisible: true,
      lastValueVisible: true,
    });
    const volume = chart.addHistogramSeries({
      priceScaleId: "vol",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart
      .priceScale("vol")
      .applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    chartRef.current = chart;
    candleRef.current = candles;
    volRef.current = volume;

    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) {
        chart.applyOptions({
          width: Math.max(10, Math.floor(r.width)),
          height: Math.max(10, Math.floor(r.height)),
        });
      }
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volRef.current = null;
    };
  }, []);

  // Show seconds on the time axis for sub-minute timeframes.
  useEffect(() => {
    chartRef.current?.applyOptions({
      timeScale: { secondsVisible: isTickTf },
    });
  }, [isTickTf]);

  // Shared: paint rows onto the chart.
  const lastRowsRef = useRef<Candle[]>([]);
  // Client-side tick store for sub-minute timeframes. Ticks accumulate in
  // the browser (one instance — no fragmented server state), keyed by mint
  // so switching timeframes re-buckets the same ticks instead of restarting.
  const tickStoreRef = useRef<{ mint: string; ticks: { t: number; p: number }[] }>({
    mint: "",
    ticks: [],
  });
  const paint = (rows: Candle[], withVolume: boolean) => {
    if (rows.length === 0) return false;
    lastRowsRef.current = rows;
    const lastClose = rows[rows.length - 1].close;
    const precision = lastClose >= 1 ? 4 : lastClose >= 0.01 ? 6 : 8;
    candleRef.current?.applyOptions({
      priceFormat: {
        type: "price",
        precision,
        minMove: Number(`1e-${precision}`),
      },
    });
    // Defensive: the chart requires ascending time order.
    const sorted = [...rows].sort((a, b) => a.time - b.time);
    candleRef.current?.setData(
      sorted.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }))
    );
    if (withVolume) {
      volRef.current?.setData(
        sorted.map((c) => ({
          time: c.time as UTCTimestamp,
          value: c.volume ?? 0,
          color:
            c.close >= c.open
              ? "rgba(38,166,154,0.4)"
              : "rgba(239,83,80,0.4)",
        }))
      );
    } else {
      // Tick candles carry no volume (price-only feed) — never fake it.
      volRef.current?.setData([]);
    }
    chartRef.current?.timeScale().fitContent();
    return true;
  };

  // Whale-buy markers: snap each tracked buy to its candle bucket and
  // drop a gold arrow under the bar. Buys with no matching candle are
  // skipped (never placed at a fabricated time).
  const applyWhaleMarkers = (rows: Candle[], buys: number[] | undefined) => {
    const series = candleRef.current;
    if (!series) return;
    const secs = WHALE_TF_SECS[tf] ?? 300;
    const have = new Set(rows.map((c) => c.time));
    const seen = new Set<number>();
    const markers: Array<{
      time: UTCTimestamp;
      position: "belowBar";
      color: string;
      shape: "arrowUp";
      text: string;
    }> = [];
    for (const t of buys ?? []) {
      if (!Number.isFinite(t)) continue;
      const bucket = Math.floor(t / secs) * secs;
      if (have.has(bucket) && !seen.has(bucket)) {
        seen.add(bucket);
        markers.push({
          time: bucket as UTCTimestamp,
          position: "belowBar",
          color: WHALE_GOLD,
          shape: "arrowUp",
          text: "W",
        });
      }
    }
    markers.sort((a, b) => a.time - b.time);
    series.setMarkers(markers);
  };

  // Re-apply whale markers when the buys arrive (async, after candles).
  useEffect(() => {
    applyWhaleMarkers(lastRowsRef.current, whaleBuys);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whaleBuys]);

  // Load candles: history (one shot) or live ticks (1s streaming loop).
  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    setTickMeta(null);

    if (!isTickTf) {
      setStatus("loading");
      fetch(`/api/candles?mint=${encodeURIComponent(mint)}&tf=${apiTf(tf)}`, {
        signal: ctrl.signal,
      })
        .then(async (r) => {
          const d = await r.json().catch(() => null);
          if (cancelled) return;
          if (!d || d.ok !== true) {
            setStatus("error");
            return;
          }
          const rows: Candle[] =
            Array.isArray(d.candles) ? d.candles : [];
          if (rows.length === 0) {
            candleRef.current?.setData([]);
            volRef.current?.setData([]);
            candleRef.current?.setMarkers([]);
            setStatus("empty");
            return;
          }
          paint(rows, true);
          applyWhaleMarkers(rows, whaleBuys);
          setStatus("ready");
        })
        .catch((e) => {
          if (!cancelled && e?.name !== "AbortError") setStatus("error");
        });
      return () => {
        cancelled = true;
        ctrl.abort();
      };
    }

    // Sub-minute: stream. Each poll fetches one live price from /api/ticks
    // (stateless) and accumulates ticks CLIENT-side, bucketing them into
    // candles locally. The browser is a single instance, so unlike the old
    // server-side registry (fragmented across serverless instances) the
    // candle set is always consistent. Candles form from real ticks only —
    // never synthesized or backfilled.
    setStatus("collecting");
    if (tickStoreRef.current.mint !== mint) {
      tickStoreRef.current = { mint, ticks: [] };
    }
    const tickSecs = WHALE_TF_SECS[tf] ?? 5;
    const aggregateTicks = (): Candle[] => {
      const ticks = tickStoreRef.current.ticks;
      const buckets = new Map<number, { t: number; p: number }[]>();
      for (const t of ticks) {
        const b = Math.floor(t.t / 1000 / tickSecs);
        const arr = buckets.get(b);
        if (arr) arr.push(t);
        else buckets.set(b, [t]);
      }
      const keys = Array.from(buckets.keys())
        .sort((a, b) => a - b)
        .slice(-120);
      return keys.map((k) => {
        const arr = buckets.get(k) as { t: number; p: number }[];
        let high = -Infinity;
        let low = Infinity;
        for (const x of arr) {
          if (x.p > high) high = x.p;
          if (x.p < low) low = x.p;
        }
        return {
          time: k * tickSecs,
          open: arr[0].p,
          high,
          low,
          close: arr[arr.length - 1].p,
        };
      });
    };
    const load = async () => {
      try {
        const r = await fetch(`/api/ticks?mint=${encodeURIComponent(mint)}`, {
          signal: ctrl.signal,
          cache: "no-store",
        });
        const d = await r.json().catch(() => null);
        if (cancelled) return;
        if (!d || d.ok !== true || typeof d.price !== "number" || d.price <= 0) {
          setStatus("error");
          return;
        }
        ingestRef.current(d.price, d.degraded === true);
      } catch (e) {
        if (!cancelled && (e as Error)?.name !== "AbortError")
          setStatus("error");
      }
    };
    // Shared ingester: stream prices and the fallback poll converge here.
    ingestRef.current = (price: number, degraded: boolean) => {
      if (cancelled) return;
      const store = tickStoreRef.current;
      store.ticks.push({ t: Date.now(), p: price });
      if (store.ticks.length > 3600) {
        store.ticks.splice(0, store.ticks.length - 3600);
      }
      setTickMeta({
        tickCount: store.ticks.length,
        degraded,
      });
      const rows = aggregateTicks();
      if (rows.length === 0) {
        // Fresh session: ticks haven't landed yet. Honest, not broken.
        setStatus(degraded ? "error" : "collecting");
        return;
      }
      paint(rows, false);
      applyWhaleMarkers(rows, whaleBuys);
      setStatus("ready");
    };
    load();
    // Fallback poll: only while the stream is down. When live, SSE feeds
    // the store and polling would just double-ingest.
    let id: ReturnType<typeof setInterval> | undefined;
    if (!streamLiveRef.current) {
      id = setInterval(load, 1000);
    }
    return () => {
      cancelled = true;
      ctrl.abort();
      if (id) clearInterval(id);
      // Unsubscribe: drawer closed or timeframe switched away.
      fetch("/api/ticks", {
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mint }),
      }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mint, tf, streamLive]);

  // Stream-fed ticks: when the SSE stream is live, prices flow straight
  // into the tick store (no polling). The fallback poll above stays off.
  const lastStreamPrice = stream.prices[mint];
  useEffect(() => {
    if (!isTickTf || !streamLive || !lastStreamPrice) return;
    ingestRef.current(lastStreamPrice, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastStreamPrice]);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-mut">
          Chart
          {isTickTf ? (
            <span className="flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-400">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
              </span>
              Live ticks
            </span>
          ) : (
            <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-mut">
              History
            </span>
          )}
        </p>
        <div className="flex gap-1 rounded-md border border-line bg-bg p-0.5">
          {TFS.map((t) => (
            <button
              key={t}
              onClick={() => setTf(t)}
              className={cn(
                "rounded px-2.5 py-1 font-mono text-[11px] tabular-nums transition-colors",
                tf === t
                  ? "bg-white/10 text-white"
                  : "text-mut hover:text-white"
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      <div className="relative">
        <div ref={wrapRef} className="h-64 w-full md:h-80" />
        {status !== "ready" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-md border border-line bg-bg/80 px-6 text-center">
            {(status === "loading" || status === "collecting") && (
              <>
                <p className="font-mono text-xs text-mut">
                  {status === "collecting"
                    ? "Collecting live ticks…"
                    : "Loading chart…"}
                </p>
                {status === "collecting" && (
                  <p className="font-mono text-[11px] text-mut/60">
                    Candles form as real prices print — a few seconds.
                    Nothing is estimated or backfilled.
                  </p>
                )}
              </>
            )}
            {status === "empty" && (
              <>
                <p className="font-mono text-xs text-mut">
                  Price history not available yet
                </p>
                <p className="font-mono text-[11px] text-mut/60">
                  This token is brand new — candles appear once trading
                  history exists. Figures are never estimated.
                </p>
              </>
            )}
            {status === "error" && (
              <p className="font-mono text-xs text-mut">
                {isTickTf
                  ? "Tick feed interrupted — reopen the token to retry."
                  : "Chart unavailable right now — reopen the token to retry."}
              </p>
            )}
          </div>
        )}
      </div>
      {isTickTf && status === "ready" && tickMeta && (
        <p className="mt-1 text-right font-mono text-[10px] text-mut/60">
          {tickMeta.tickCount} ticks this session
          {tickMeta.degraded ? " · feed degraded" : ""}
        </p>
      )}
    </div>
  );
}
