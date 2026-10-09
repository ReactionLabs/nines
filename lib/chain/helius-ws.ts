"use client";

/**
 * Firehose-ready Helius WebSocket subscription layer.
 *
 * One persistent browser connection multiplexes many subscriptions.
 * The server never proxies this traffic: the firehose terminates in the
 * browser, where client-side filters (see filters.ts) reduce it to a
 * trickle before it touches React state.
 *
 * Design for full-chain scale:
 * - Single WS per client, many subscriptions multiplexed over it.
 * - Inbound ring buffer (drop-oldest): a slow UI never OOMs the tab.
 * - Throughput stats so the UI can show honest stream health.
 * - Auto-reconnect with backoff + jitter; all subscriptions re-registered.
 * - No dependency on React: safe to use from any module.
 */

export type ChainEventKind = "logs" | "transaction";

export interface ChainEvent {
  kind: ChainEventKind;
  /** Client subscription key (e.g. "tape:<mint>"). */
  key: string;
  /** Receive time, ms epoch. */
  at: number;
  /** Raw Helius notification params.result. */
  payload: any;
}

interface Sub {
  key: string;
  method: "logsSubscribe" | "transactionSubscribe";
  params: any[];
  cb: (e: ChainEvent) => void;
  /** Server-assigned subscription id; -1 while pending. */
  id: number;
}

export interface ChainStats {
  connected: boolean;
  /** Messages received in the last second (rolling). */
  msgPerSec: number;
  receivedTotal: number;
  subCount: number;
  reconnects: number;
  lastEventAt: number | null;
}

type StatsCb = (s: ChainStats) => void;

const RING_MAX = 5000;
const MAX_BACKOFF_MS = 30_000;

function toWsUrl(httpUrl: string): string | null {
  try {
    const u = new URL(httpUrl);
    if (u.protocol === "https:") u.protocol = "wss:";
    else if (u.protocol === "http:") u.protocol = "ws:";
    else return null;
    return u.toString();
  } catch {
    return null;
  }
}

export class ChainSocket {
  private url: string | null;
  private ws: WebSocket | null = null;
  private reqId = 1;
  private subs = new Map<string, Sub>();
  private reqToKey = new Map<number, string>();
  private ring: ChainEvent[] = [];
  private userClosed = false;
  private backoffMs = 1000;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private hits: number[] = [];
  private receivedTotal = 0;
  private reconnects = 0;
  private lastEventAt: number | null = null;
  private statsCbs = new Set<StatsCb>();
  private statsTimer: ReturnType<typeof setInterval> | null = null;

  constructor(rpcHttpUrl?: string) {
    this.url = rpcHttpUrl ? toWsUrl(rpcHttpUrl) : null;
  }

  /** False when no RPC URL is configured: caller should degrade honestly. */
  get available(): boolean {
    return this.url !== null;
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (!this.url || this.ws || this.userClosed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.backoffMs = 1000;
      // Re-register every subscription on the fresh connection.
      this.subs.forEach((sub) => {
        sub.id = -1;
        this.sendSubscribe(sub);
      });
      this.emitStats();
    };
    ws.onmessage = (msg) => this.handleMessage(msg.data);
    ws.onclose = () => {
      this.ws = null;
      // Mark pending so resubscribe works cleanly.
      this.subs.forEach((sub) => { sub.id = -1; });
      this.reqToKey.clear();
      this.emitStats();
      if (!this.userClosed) {
        this.reconnects += 1;
        this.scheduleReconnect();
      }
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* onclose handles it */
      }
    };
  }

  disconnect(): void {
    this.userClosed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    this.ws = null;
  }

  /**
   * Subscribe to program/account logs. `params` is the Helius
   * logsSubscribe params array, e.g. [{ mentions: [programId] },
   * { commitment: "confirmed" }].
   */
  subscribeLogs(
    key: string,
    params: any[],
    cb: (e: ChainEvent) => void
  ): void {
    this.upsert({ key, method: "logsSubscribe", params, cb, id: -1 });
  }

  /** Subscribe to transactions mentioning the given accounts. */
  subscribeTransactions(
    key: string,
    params: any[],
    cb: (e: ChainEvent) => void
  ): void {
    this.upsert({ key, method: "transactionSubscribe", params, cb, id: -1 });
  }

  unsubscribe(key: string): void {
    const sub = this.subs.get(key);
    if (!sub) return;
    this.subs.delete(key);
    if (sub.id >= 0 && this.ws && this.ws.readyState === WebSocket.OPEN) {
      const id = this.reqId++;
      const method =
        sub.method === "logsSubscribe"
          ? "logsUnsubscribe"
          : "transactionUnsubscribe";
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: [sub.id] }));
    }
  }

  /** Recent raw events, newest last. Bounded by the ring buffer. */
  recent(kind?: ChainEventKind, limit = 100): ChainEvent[] {
    const arr = kind ? this.ring.filter((e) => e.kind === kind) : this.ring;
    return arr.slice(-limit);
  }

  onStats(cb: StatsCb): () => void {
    this.statsCbs.add(cb);
    if (!this.statsTimer) {
      this.statsTimer = setInterval(() => this.emitStats(), 1000);
    }
    cb(this.snapshot());
    return () => {
      this.statsCbs.delete(cb);
      if (this.statsCbs.size === 0 && this.statsTimer) {
        clearInterval(this.statsTimer);
        this.statsTimer = null;
      }
    };
  }

  snapshot(): ChainStats {
    const now = Date.now();
    this.hits = this.hits.filter((t) => now - t < 1000);
    return {
      connected: this.connected,
      msgPerSec: this.hits.length,
      receivedTotal: this.receivedTotal,
      subCount: this.subs.size,
      reconnects: this.reconnects,
      lastEventAt: this.lastEventAt,
    };
  }

  private upsert(sub: Sub): void {
    const existing = this.subs.get(sub.key);
    if (existing) {
      existing.cb = sub.cb;
      existing.params = sub.params;
      return;
    }
    this.subs.set(sub.key, sub);
    this.sendSubscribe(sub);
  }

  private sendSubscribe(sub: Sub): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const id = this.reqId++;
    this.reqToKey.set(id, sub.key);
    this.ws.send(
      JSON.stringify({ jsonrpc: "2.0", id, method: sub.method, params: sub.params })
    );
  }

  private handleMessage(data: unknown): void {
    let msg: any;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    // Subscription confirmation: map request id -> server subscription id.
    if (typeof msg?.result === "number" && typeof msg?.id === "number") {
      const key = this.reqToKey.get(msg.id);
      this.reqToKey.delete(msg.id);
      if (key) {
        const sub = this.subs.get(key);
        if (sub) sub.id = msg.result;
      }
      return;
    }
    // Notifications.
    const method: string | undefined = msg?.method;
    if (method !== "logsNotification" && method !== "transactionNotification") return;
    const serverId: number | undefined = msg?.params?.subscription;
    const result = msg?.params?.result;
    if (typeof serverId !== "number" || !result) return;
    let key: string | null = null;
    this.subs.forEach((sub) => {
      if (key === null && sub.id === serverId) key = sub.key;
    });
    if (!key) return;
    const sub = this.subs.get(key);
    if (!sub) return;
    const now = Date.now();
    this.receivedTotal += 1;
    this.lastEventAt = now;
    this.hits.push(now);
    const ev: ChainEvent = {
      kind: method === "logsNotification" ? "logs" : "transaction",
      key,
      at: now,
      payload: result,
    };
    // Backpressure: drop oldest, never grow unbounded.
    this.ring.push(ev);
    if (this.ring.length > RING_MAX) {
      this.ring.splice(0, this.ring.length - RING_MAX);
    }
    try {
      sub.cb(ev);
    } catch {
      /* subscriber errors must not kill the socket */
    }
  }

  private scheduleReconnect(): void {
    if (this.userClosed || this.retryTimer) return;
    const jitter = Math.random() * 500;
    const delay = Math.min(this.backoffMs + jitter, MAX_BACKOFF_MS);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private emitStats(): void {
    const s = this.snapshot();
    this.statsCbs.forEach((cb) => {
      try {
        cb(s);
      } catch {
        /* ignore */
      }
    });
  }
}
