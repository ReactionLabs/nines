import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import stateSnapshot from "@/data/state.json";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/state — scanner state for the dashboard.
 *
 * Local-first data source priority:
 *   1. NINES_STATE_PATH — the live state.json written by watcher/scanner.py
 *      on this machine. This is the primary path: the dashboard reads the
 *      scanner's output straight off disk, no network round-trip.
 *   2. data/state.json — build-time snapshot bundled with the repo.
 *
 * There is no cloud fetch in this path. The local scanner is the source
 * of truth; if it is not running, the snapshot is served with live: false.
 *
 * The `source` field tells the UI which leg served the payload.
 */
function statePath(): string {
  const env = process.env.NINES_STATE_PATH;
  if (env) return env;
  // Default: watcher/state.json next to this repo's app directory.
  return path.join(process.cwd(), "watcher", "state.json");
}

async function readLiveState(): Promise<Record<string, unknown> | null> {
  const p = statePath();
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function GET() {
  const live = await readLiveState();
  if (live) {
    return Response.json({
      live: true,
      source: "local",
      snapshot_at: null,
      ...live,
    });
  }

  // Fallback: bundled snapshot.
  return Response.json({
    live: false,
    source: "snapshot",
    snapshot_at: (stateSnapshot as { updated_at?: number }).updated_at ?? null,
    ...stateSnapshot,
  });
}
