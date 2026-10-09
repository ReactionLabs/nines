import type { NextRequest } from "next/server";
import {
  readBusAdvance,
  busHead,
  fetchPersistedEvents,
  type StreamEvent,
} from "@/lib/stream/events";

/**
 * GET /api/stream — Server-Sent Events for terminal live streams.
 *
 * Topics (comma-separated ?topics=):
 *   status — scanner status + data freshness (on change)
 *   pairs   — newly discovered candidate mints (as they appear in state.json)
 *   alerts  — scanner alerts (as they fire)
 *   prices  — live USD prices for ?mints= (DexScreener batch, ~3s)
 *
 * Design notes:
 * - One SSE connection per client replaces N polling loops. The browser
 *   EventSource auto-reconnects; ?since= cursor replays missed alerts.
 * - Vercel serverless kills long connections (maxDuration): the client
 *   reconnects transparently, so a 60s connection lifetime is fine.
 * - Cookie auth applies via middleware (EventSource sends same-origin
 *   cookies). No key material here.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEXSCREENER = "https://api.dexscreener.com/tokens/v1/solana";

function localStatePath(): string {
  const env = process.env.NINES_STATE_PATH;
  if (env) return env;
  return path.join(process.cwd(), "watcher", "state.json");
}

const PRICE_TICK_MS = 3_000;
const STATE_TICK_MS = 10_000;
const KEEPALIVE_MS = 15_000;

function encode(event: string, data: unknown, id?: string | number): string {
  let s = "";
  if (id !== undefined) s += `id: ${id}\n`;
  s += `event: ${event}\n`;
  s += `data: ${JSON.stringify(data)}\n\n`;
  return s;
}

async function fetchState(): Promise<any | null> {
  // Local-first: read the scanner's state.json straight off disk.
  const p = localStatePath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(await readFile(p, "utf-8"));
  } catch {
    return null;
  }
}

async function fetchPrices(
  mints: string[]
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (mints.length === 0) return out;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let res: Response;
    try {
      res = await fetch(`${DEXSCREENER}/${mints.join(",")}`, {
        signal: ctrl.signal,
        headers: { Accept: "application/json" },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return out;
    const pairs = (await res.json()) as Array<{
      baseToken?: { address?: string };
      priceUsd?: string | number;
      liquidity?: { usd?: number };
    }>;
    const best: Record<string, { price: number; liq: number }> = {};
    for (const p of pairs ?? []) {
      const mint = p?.baseToken?.address;
      const price = Number(p?.priceUsd);
      if (!mint || !Number.isFinite(price) || price <= 0) continue;
      const liq = Number(p?.liquidity?.usd ?? 0);
      if (!best[mint] || liq > best[mint].liq) best[mint] = { price, liq };
    }
    for (const [mint, b] of Object.entries(best)) out[mint] = b.price;
  } catch {
    /* DexScreener down: no prices this tick */
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const topics = new Set(
    (url.searchParams.get("topics") ?? "status,pairs,alerts,prices")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
  const mints = (url.searchParams.get("mints") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 30);
  const since = Number(url.searchParams.get("since") ?? 0) || 0;

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      let alive = true;
      req.signal.addEventListener("abort", () => {
        alive = false;
      });
      const send = (s: string) => {
        if (alive) controller.enqueue(enc.encode(s));
      };

      const seenMints = new Set<string>();
      let lastAlertAt = since;
      let lastStatusJson = "";
      let lastStreamTs = since;
      // Broadcast cursor into the in-memory bus: this connection only
      // reads events newer than its cursor, so co-located SSE consumers
      // never steal each other's events (drainBus was destructive).
      let busCursor = busHead();
      const emitStreamEvent = (ev: StreamEvent) => {
        if (!topics.has(ev.topic)) return;
        if (!(ev.ts > lastStreamTs)) return;
        lastStreamTs = ev.ts;
        send(
          encode(ev.topic, {
            id: ev.id,
            ts: ev.ts,
            mint: ev.mint ?? null,
            data: ev.data ?? null,
          })
        );
      };

      // Initial snapshot: status + recent alerts replay.
      const boot = await fetchState();
      if (boot) {
        for (const c of boot?.candidates ?? []) {
          if (c?.mint) seenMints.add(c.mint);
        }
        if (topics.has("status")) {
          const payload = {
            updated_at: boot.updated_at ?? null,
            scanner: boot.scanner ?? null,
            candidateCount: (boot.candidates ?? []).length,
          };
          lastStatusJson = JSON.stringify(payload);
          send(encode("status", payload));
        }
        if (topics.has("alerts")) {
          const recent = (boot?.alerts ?? [])
            .filter((a: any) => (a?.at ?? 0) * 1000 > since)
            .slice(-20);
          for (const a of recent) send(encode("alerts", a));
          for (const a of recent) {
            const at = (a?.at ?? 0) * 1000;
            if (at > lastAlertAt) lastAlertAt = at;
          }
        }
      }

      let lastPriceTick = 0;
      let lastStateTick = 0;
      let lastKeepalive = 0;
      let lastStreamFileTick = 0;

      while (alive) {
        const now = Date.now();
        try {
          // Prices: every ~3s for the requested mints.
          if (
            topics.has("prices") &&
            mints.length > 0 &&
            now - lastPriceTick >= PRICE_TICK_MS
          ) {
            lastPriceTick = now;
            const prices = await fetchPrices(mints);
            for (const [mint, price] of Object.entries(prices)) {
              send(encode("prices", { mint, price, at: now }));
            }
          }

          // State: every ~10s, diff pairs/alerts/status.
          if (now - lastStateTick >= STATE_TICK_MS) {
            lastStateTick = now;
            const st = await fetchState();
            if (st) {
              if (topics.has("pairs")) {
                for (const c of st?.candidates ?? []) {
                  if (c?.mint && !seenMints.has(c.mint)) {
                    seenMints.add(c.mint);
                    send(encode("pairs", c));
                  }
                }
              }
              if (topics.has("alerts")) {
                for (const a of st?.alerts ?? []) {
                  const at = (a?.at ?? 0) * 1000;
                  if (at > lastAlertAt) {
                    lastAlertAt = at;
                    send(encode("alerts", a));
                  }
                }
              }
              if (topics.has("status")) {
                const payload = {
                  updated_at: st.updated_at ?? null,
                  scanner: st.scanner ?? null,
                  candidateCount: (st.candidates ?? []).length,
                };
                const j = JSON.stringify(payload);
                if (j !== lastStatusJson) {
                  lastStatusJson = j;
                  send(encode("status", payload));
                }
              }
            }
          }

          // Ingested events: in-memory bus (same instance) every loop,
          // Neon table (cross-instance) on the state cadence.
          const busRead = readBusAdvance(busCursor);
          busCursor = busRead.cursor;
          for (const ev of busRead.events) emitStreamEvent(ev);
          if (now - lastStreamFileTick >= STATE_TICK_MS) {
            lastStreamFileTick = now;
            const persisted = await fetchPersistedEvents(lastStreamTs);
            for (const ev of persisted) emitStreamEvent(ev);
          }

          if (now - lastKeepalive >= KEEPALIVE_MS) {
            lastKeepalive = now;
            send(": keep-alive\n\n");
          }
        } catch {
          /* one bad tick must not kill the stream */
        }
        await sleep(1000);
      }

      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
