/**
 * Shared stream event contract + server-side event bus.
 *
 * Producers: POST /api/stream-ingest (local ingestor) pushes normalized
 * events here via pushBus() and persists them durably.
 * Consumers: GET /api/stream reads the bus via a per-connection cursor
 * (readBus) and polls the durable plane, emitting events to SSE clients
 * by topic.
 *
 * Event contract (ingest accepts flexible shapes, normalizes to this):
 *   { id, ts (ms epoch), topic, mint?, data? }
 * topic is one of: status | pairs | alerts | prices | trades
 * (unknown topics are normalized to "alerts", never dropped).
 *
 * Durability note (local-first): the in-memory bus is the fast path and,
 * on a single local instance, it is also the only instance — so the bus
 * plus the local JSONL event log (NINES_STREAM_PATH, default
 * <repo>/data-live/stream-events.jsonl) is the durable plane. Neon
 * Postgres (STREAM_DB_URL) is still supported as an optional alternate
 * durable store and takes precedence when set.
 */

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { appendFile, readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export type StreamTopic = "status" | "pairs" | "alerts" | "prices" | "trades";

export interface StreamEvent {
  id: string;
  /** ms epoch */
  ts: number;
  topic: StreamTopic;
  mint?: string | null;
  data?: unknown;
}

const VALID_TOPICS: StreamTopic[] = [
  "status",
  "pairs",
  "alerts",
  "prices",
  "trades",
];

export function normalizeTopic(t: unknown): StreamTopic {
  return (VALID_TOPICS as string[]).includes(t as string)
    ? (t as StreamTopic)
    : "alerts";
}

let seq = 0;

/** Validate + normalize an inbound events array. Never throws. */
export function normalizeIncoming(raw: unknown): StreamEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: StreamEvent[] = [];
  const now = Date.now();
  for (const r of raw.slice(0, 1000)) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const topic = normalizeTopic(o.topic ?? o.type);
    let ts = Number(o.ts ?? o.at ?? 0);
    if (!Number.isFinite(ts) || ts <= 0) {
      ts = now;
    } else if (ts < 1e12) {
      ts = ts * 1000; // accept seconds
    }
    const mint = typeof o.mint === "string" ? o.mint : null;
    seq = (seq + 1) % 1_000_000;
    out.push({
      id: `evt_${ts}_${seq}`,
      ts,
      topic,
      mint,
      data: o.data ?? null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// In-memory ring buffer (same-instance fast path)
//
// Broadcast, not drain: each event gets a monotonically increasing sequence
// number when pushed. Consumers call readBus(cursor) to get everything
// after their cursor without removing it, so multiple SSE connections on
// the same instance never steal each other's events.
// ---------------------------------------------------------------------------

const MAX_BUS = 2000;
const bus: Array<StreamEvent & { seq: number }> = [];
let busSeq = 0;

export function pushBus(events: StreamEvent[]): void {
  for (const e of events) {
    busSeq = (busSeq + 1) % Number.MAX_SAFE_INTEGER;
    bus.push({ ...e, seq: busSeq });
    if (bus.length > MAX_BUS) bus.splice(0, bus.length - MAX_BUS);
  }
}

/**
 * Return the sequence number of the newest buffered event (0 when empty).
 * Consumers use this as their starting cursor.
 */
export function busHead(): number {
  return bus.length > 0 ? bus[bus.length - 1].seq : busSeq;
}

/** Return buffered events with seq > cursor, oldest first. Non-destructive. */
export function readBus(cursor: number): StreamEvent[] {
  const out: StreamEvent[] = [];
  for (const e of bus) {
    if (e.seq > cursor) {
      const { seq: _seq, ...ev } = e;
      out.push(ev);
    }
  }
  return out;
}

/**
 * Drain new events after `cursor` and advance it to the current head,
 * all in one step. Returns [events, newCursor]. Single-threaded and
 * non-destructive: other consumers' cursors are unaffected.
 */
export function readBusAdvance(cursor: number): {
  events: StreamEvent[];
  cursor: number;
} {
  return { events: readBus(cursor), cursor: busHead() };
}

/**
 * Legacy destructive drain. Deprecated: prefer readBus(cursor).
 * Kept for compatibility; not used by the SSE route.
 */
export function drainBus(): StreamEvent[] {
  return bus.splice(0, bus.length).map((e) => {
    const { seq: _seq, ...ev } = e;
    return ev;
  });
}

// ---------------------------------------------------------------------------
// Durable plane: stream_events table in Neon Postgres
// (cross-instance; the bus is only a same-instance fast path)
// ---------------------------------------------------------------------------

function dbUrl(): string | undefined {
  return process.env.STREAM_DB_URL;
}

type NeonRow = {
  id: number;
  ts: string | number;
  topic: string;
  mint: string | null;
  data: unknown;
};

function rowToEvent(row: NeonRow): StreamEvent {
  return {
    id: `neon_${row.id}`,
    ts: Number(row.ts),
    topic: normalizeTopic(row.topic),
    mint: typeof row.mint === "string" ? row.mint : null,
    data: row.data ?? null,
  };
}

/**
 * Fetch persisted events newer than `since` (ms epoch, default 0),
 * oldest first, capped at 500. Uses Neon when STREAM_DB_URL is set,
 * otherwise the local JSONL event log.
 */
export async function fetchPersistedEvents(
  since: number = 0
): Promise<StreamEvent[]> {
  const url = dbUrl();
  if (url) {
    try {
      const sql = neon(url);
      const rows = (await sql`
        SELECT id, ts, topic, mint, data
        FROM stream_events
        WHERE ts > ${Math.floor(since)}
        ORDER BY ts ASC
        LIMIT 500
      `) as unknown as NeonRow[];
      return rows.map(rowToEvent);
    } catch {
      return [];
    }
  }
  return fetchLocalEvents(since);
}

// ---------------------------------------------------------------------------
// Local durable plane: JSONL event log (local-first default)
// ---------------------------------------------------------------------------

function streamLogPath(): string {
  const env = process.env.NINES_STREAM_PATH;
  if (env) return env;
  return path.join(process.cwd(), "data-live", "stream-events.jsonl");
}

function ensureLogDir(p: string): void {
  try {
    mkdirSync(path.dirname(p), { recursive: true });
  } catch {
    /* best-effort */
  }
}

async function fetchLocalEvents(since: number = 0): Promise<StreamEvent[]> {
  const p = streamLogPath();
  if (!existsSync(p)) return [];
  try {
    const raw = await readFile(p, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    // Read from the tail: the log is append-only, newest last.
    const out: StreamEvent[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < 500; i--) {
      try {
        const e = JSON.parse(lines[i]) as StreamEvent;
        if (typeof e.ts === "number" && e.ts > since && e.topic) {
          out.push({
            id: String(e.id ?? `local_${e.ts}`),
            ts: e.ts,
            topic: normalizeTopic(e.topic),
            mint: typeof e.mint === "string" ? e.mint : null,
            data: e.data ?? null,
          });
        }
      } catch {
        /* skip malformed lines */
      }
    }
    return out.reverse(); // oldest first
  } catch {
    return [];
  }
}

async function persistLocalEvents(events: StreamEvent[]): Promise<boolean> {
  const p = streamLogPath();
  try {
    ensureLogDir(p);
    const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await appendFile(p, lines, "utf-8");
    return true;
  } catch {
    return false;
  }
}

const PRUNE_ROWS = 5000;
const PRUNE_AGE_MS = 24 * 60 * 60 * 1000;
// Prune at most once every 5 minutes, and only when enabled.
// Enabled automatically when STREAM_DB_URL is set.
let lastPrune = 0;
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

async function pruneOnce(sql: NeonQueryFunction<false, false>): Promise<void> {
  const now = Date.now();
  if (now - lastPrune < PRUNE_INTERVAL_MS) return;
  lastPrune = now;
  try {
    // Keep the newest 5000 rows AND nothing older than 24h,
    // whichever is smaller.
    await sql`
      DELETE FROM stream_events
      WHERE id NOT IN (
        SELECT id FROM stream_events ORDER BY id DESC LIMIT ${PRUNE_ROWS}
      )
      OR ts < ${now - PRUNE_AGE_MS}
    `;
  } catch {
    /* best-effort */
  }
}

/**
 * Persist a batch of events. Best-effort, returns true on success.
 * Uses Neon when STREAM_DB_URL is set, otherwise the local JSONL log.
 * Prunes old rows opportunistically (Neon only; the local log is
 * append-only and tiny enough to rotate by hand).
 */
export async function persistEvents(events: StreamEvent[]): Promise<boolean> {
  if (events.length === 0) return false;
  const url = dbUrl();
  if (!url) return persistLocalEvents(events);
  try {
    const sql = neon(url);
    // Batch insert: build one multi-row VALUES statement.
    const values: string[] = [];
    const params: unknown[] = [];
    let i = 0;
    for (const e of events) {
      i += 1;
      values.push(
        `($${i * 4 - 3}, $${i * 4 - 2}, $${i * 4 - 1}, $${i * 4}::jsonb)`
      );
      params.push(
        Math.floor(e.ts),
        e.topic,
        e.mint ?? null,
        e.data == null ? null : JSON.stringify(e.data)
      );
    }
    await sql.query(
      `INSERT INTO stream_events (ts, topic, mint, data) VALUES ${values.join(
        ", "
      )}`,
      params
    );
    void pruneOnce(sql);
    return true;
  } catch {
    return false;
  }
}
