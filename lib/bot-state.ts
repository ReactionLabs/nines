/* Shared scanner-state fetch for the v1 bot API.
 *
 * Local-first: reads the live state.json written by watcher/scanner.py
 * straight off disk (NINES_STATE_PATH, default <repo>/watcher/state.json).
 * Falls back to the bundled data/state.json snapshot. No cloud fetch.
 * If neither is readable the v1 routes return a 502.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { AlertItem, Candidate } from "./types";

export interface BotState {
  live: boolean;
  updated_at: number | null;
  candidates: Candidate[];
  alerts: AlertItem[];
}

function statePath(): string {
  const env = process.env.NINES_STATE_PATH;
  if (env) return env;
  return path.join(process.cwd(), "watcher", "state.json");
}

function snapshotPath(): string {
  return path.join(process.cwd(), "data", "state.json");
}

async function readJson(p: string): Promise<{
  updated_at?: number;
  candidates?: Candidate[];
  alerts?: AlertItem[];
} | null> {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(await readFile(p, "utf-8"));
  } catch {
    return null;
  }
}

export async function fetchBotState(): Promise<BotState | null> {
  const live = await readJson(statePath());
  const d = live ?? (await readJson(snapshotPath()));
  if (!d) return null;
  return {
    live: live != null,
    updated_at: d.updated_at ?? null,
    candidates: Array.isArray(d.candidates) ? d.candidates : [],
    alerts: Array.isArray(d.alerts) ? d.alerts : [],
  };
}
