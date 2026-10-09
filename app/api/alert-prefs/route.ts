import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import watchStateSnapshot from "@/data/watchlist-state.json";

/**
 * Alert preferences (OWNER/dip role only).
 *
 * Dip toggles alert categories, per-wallet watched-wallet alerts, and quiet
 * hours here. The box-side alert cron (check_alerts.py) reads this same file
 * from the private repo and enforces it before printing alerts, so prefs
 * live server-side, never in localStorage.
 *
 *   GET /api/alert-prefs  -> { ok, prefs, live }
 *   PUT /api/alert-prefs  { prefs } -> { ok }
 *
 * Writes go through the GitHub Contents API with optimistic locking (same
 * pattern as /api/access-request). GITHUB_TOKEN is not configured on Vercel
 * yet, so PUT returns 503 with a clear message until Dip provides it; GET
 * falls back to sensible defaults seeded from the watchlist snapshot.
 *
 * Non-dip roles get 403. Middleware already verified tyck_sig for the
 * tyck_role cookie before this route runs.
 */

export const dynamic = "force-dynamic";

const OWNER = "ReactionLabs";
const REPO = "tyck-trade";
const PREFS_FILE = "data/alert-prefs.json";
const WATCH_FILE = "data/watchlist-state.json";
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface WalletPref {
  label: string;
  enabled: boolean;
}

export interface AlertPrefs {
  version: 1;
  updated_at: number;
  categories: { nines: boolean; watchlist: boolean; smartmoney: boolean };
  wallets: Record<string, WalletPref>;
  quiet_hours: { enabled: boolean; start: string; end: string; tz: string };
}

function isOwner(): boolean {
  return cookies().get("tyck_role")?.value === "dip";
}

function defaults(): AlertPrefs {
  return {
    version: 1,
    updated_at: 0,
    categories: { nines: true, watchlist: true, smartmoney: true },
    wallets: {},
    quiet_hours: {
      enabled: false,
      start: "23:00",
      end: "07:00",
      tz: "America/New_York",
    },
  };
}

/** Wallets currently watched, from a watchlist-state.json payload. */
function walletsFromWatchState(src: unknown): Record<string, WalletPref> {
  const out: Record<string, WalletPref> = {};
  const list =
    typeof src === "object" && src !== null
      ? ((src as { wallets?: unknown }).wallets as Array<{
          address?: unknown;
          label?: unknown;
        }>)
      : null;
  if (!Array.isArray(list)) return out;
  for (const w of list) {
    const address = typeof w?.address === "string" ? w.address : "";
    if (!address) continue;
    const label =
      typeof w?.label === "string" && w.label.length > 0
        ? w.label
        : address.slice(0, 8);
    out[address] = { label, enabled: true };
  }
  return out;
}

/** Seed any watched wallets missing from the prefs file (default: on). */
function mergeWallets(
  prefs: AlertPrefs,
  seeded: Record<string, WalletPref>
): AlertPrefs {
  const wallets = { ...prefs.wallets };
  for (const [address, w] of Object.entries(seeded)) {
    if (!wallets[address]) wallets[address] = w;
  }
  return { ...prefs, wallets };
}

async function ghRead(
  token: string,
  path: string
): Promise<{ sha: string | null; json: unknown }> {
  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
      cache: "no-store",
    }
  );
  if (res.status === 404) return { sha: null, json: null };
  if (!res.ok) throw new Error(`prefs read failed: ${res.status}`);
  const d = (await res.json()) as { sha?: string; content?: string };
  const raw = Buffer.from(d.content ?? "", "base64").toString("utf8");
  return { sha: d.sha ?? null, json: JSON.parse(raw) };
}

function coercePrefs(raw: unknown): AlertPrefs {
  const base = defaults();
  if (typeof raw !== "object" || raw === null) return base;
  const r = raw as Record<string, unknown>;
  const cats = (r.categories as Record<string, unknown>) ?? {};
  const qh = (r.quiet_hours as Record<string, unknown>) ?? {};
  const wallets: Record<string, WalletPref> = {};
  const rw = (r.wallets as Record<string, unknown>) ?? {};
  for (const [address, w] of Object.entries(rw)) {
    if (typeof w !== "object" || w === null) continue;
    const e = w as Record<string, unknown>;
    wallets[address] = {
      label: typeof e.label === "string" ? e.label : address.slice(0, 8),
      enabled: e.enabled !== false,
    };
  }
  const start = typeof qh.start === "string" && TIME_RE.test(qh.start) ? qh.start : base.quiet_hours.start;
  const end = typeof qh.end === "string" && TIME_RE.test(qh.end) ? qh.end : base.quiet_hours.end;
  return {
    version: 1,
    updated_at: typeof r.updated_at === "number" ? r.updated_at : 0,
    categories: {
      nines: cats.nines !== false,
      watchlist: cats.watchlist !== false,
      smartmoney: cats.smartmoney !== false,
    },
    wallets,
    quiet_hours: {
      enabled: qh.enabled === true,
      start,
      end,
      tz: "America/New_York",
    },
  };
}

export async function GET() {
  if (!isOwner()) {
    return NextResponse.json(
      { ok: false, error: "Alert settings are restricted to the dip role." },
      { status: 403 }
    );
  }

  const token = process.env.GITHUB_TOKEN;
  let prefs = defaults();
  let live = false;

  if (token) {
    try {
      const { json } = await ghRead(token, PREFS_FILE);
      if (json) prefs = coercePrefs(json);
      try {
        const watch = await ghRead(token, WATCH_FILE);
        if (watch.json) {
          prefs = mergeWallets(prefs, walletsFromWatchState(watch.json));
          live = true;
        }
      } catch {
        // live watchlist unreadable; snapshot fallback below
      }
    } catch {
      return NextResponse.json(
        { ok: false, error: "Could not read alert prefs." },
        { status: 502 }
      );
    }
  }

  // Seed wallet list from the build-time snapshot whenever the prefs file
  // (or the live watchlist) didn't supply it.
  prefs = mergeWallets(prefs, walletsFromWatchState(watchStateSnapshot));

  return NextResponse.json({ ok: true, prefs, live });
}

function validateBody(body: unknown): { prefs?: AlertPrefs; error?: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "Request body must be an object." };
  }
  const b = (body as { prefs?: unknown }).prefs ?? body;
  if (typeof b !== "object" || b === null) {
    return { error: "Missing prefs object." };
  }
  const p = b as Record<string, unknown>;
  const cats = p.categories as Record<string, unknown> | undefined;
  for (const k of ["nines", "watchlist", "smartmoney"]) {
    if (cats && typeof cats[k] !== "undefined" && typeof cats[k] !== "boolean") {
      return { error: `categories.${k} must be a boolean.` };
    }
  }
  const wallets = p.wallets as Record<string, unknown> | undefined;
  if (wallets && typeof wallets === "object") {
    for (const [address, w] of Object.entries(wallets)) {
      if (typeof w !== "object" || w === null) {
        return { error: `wallets.${address} must be an object.` };
      }
      const e = w as Record<string, unknown>;
      if (typeof e.label !== "string" || typeof e.enabled !== "boolean") {
        return { error: `wallets.${address} needs {label, enabled}.` };
      }
    }
  }
  const qh = p.quiet_hours as Record<string, unknown> | undefined;
  if (qh) {
    if (typeof qh.enabled !== "boolean") {
      return { error: "quiet_hours.enabled must be a boolean." };
    }
    if (!TIME_RE.test(String(qh.start)) || !TIME_RE.test(String(qh.end))) {
      return { error: "quiet_hours.start/end must be HH:MM (24h)." };
    }
  }
  const coerced = coercePrefs(b);
  coerced.updated_at = Date.now();
  return { prefs: coerced };
}

export async function PUT(req: Request) {
  if (!isOwner()) {
    return NextResponse.json(
      { ok: false, error: "Alert settings are restricted to the dip role." },
      { status: 403 }
    );
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "saving unavailable — missing server token" },
      { status: 503 }
    );
  }

  const body = await req.json().catch(() => null);
  const { prefs, error } = validateBody(body);
  if (!prefs) {
    return NextResponse.json({ ok: false, error }, { status: 400 });
  }

  // Optimistic-locking write: refetch on sha conflict.
  for (let attempt = 0; attempt < 3; attempt++) {
    let sha: string | null;
    try {
      ({ sha } = await ghRead(token, PREFS_FILE));
    } catch {
      return NextResponse.json(
        { ok: false, error: "Could not reach the prefs store." },
        { status: 502 }
      );
    }

    const put = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PREFS_FILE}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: "alert-prefs: update",
          content: Buffer.from(JSON.stringify(prefs, null, 2)).toString(
            "base64"
          ),
          ...(sha ? { sha } : {}),
          branch: "main",
        }),
      }
    ).catch(() => null);

    if (!put) {
      return NextResponse.json(
        { ok: false, error: "Could not reach the prefs store." },
        { status: 502 }
      );
    }
    if (put.status === 422 || put.status === 409) continue; // sha moved: refetch
    if (!put.ok) {
      return NextResponse.json(
        { ok: false, error: "Prefs write failed." },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: true, prefs });
  }

  return NextResponse.json(
    { ok: false, error: "Prefs store is busy. Try again." },
    { status: 503 }
  );
}
