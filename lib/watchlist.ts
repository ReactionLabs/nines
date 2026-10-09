/**
 * Personal watchlist: coins Dip stars while scanning, to check back on
 * the next day. Per-device localStorage only — no backend, no account.
 */

export interface WatchlistEntry {
  mint: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  /** USD price at the moment the star was tapped. Null when unknown. */
  priceAtAdd: number | null;
  /** Epoch seconds when added. */
  addedAt: number;
}

const KEY = "nines:watchlist:v1";
const MAX_ENTRIES = 200;

function valid(e: unknown): e is WatchlistEntry {
  if (!e || typeof e !== "object") return false;
  const x = e as Record<string, unknown>;
  return (
    typeof x.mint === "string" &&
    x.mint.length > 0 &&
    typeof x.addedAt === "number" &&
    Number.isFinite(x.addedAt)
  );
}

export function loadWatchlist(): WatchlistEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const d = JSON.parse(raw);
    if (!Array.isArray(d)) return [];
    return d.filter(valid).slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

export function saveWatchlist(entries: WatchlistEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    /* storage unavailable */
  }
}

/** Toggle: returns the new list and whether the mint is now watched. */
export function toggleWatchlist(
  entries: WatchlistEntry[],
  entry: WatchlistEntry
): { list: WatchlistEntry[]; watched: boolean } {
  if (entries.some((e) => e.mint === entry.mint)) {
    return {
      list: entries.filter((e) => e.mint !== entry.mint),
      watched: false,
    };
  }
  return { list: [entry, ...entries].slice(0, MAX_ENTRIES), watched: true };
}

export function removeFromWatchlist(
  entries: WatchlistEntry[],
  mint: string
): WatchlistEntry[] {
  return entries.filter((e) => e.mint !== mint);
}
