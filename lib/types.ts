export interface Gate {
  n: number;
  name: string;
  passed: boolean | null;
  detail: string;
}

export interface Candidate {
  mint: string;
  launchpad: string;
  first_seen: number;
  tier: string;
  volume_usd: number | null;
  image_url: string | null; // on-chain metadata image (scanner-resolved), null if none
  gates: Gate[];
  verdict: "ALERT" | "PASS";
  partial: boolean;
  alerted: boolean;
  alerted_at: number | null;
  reason: string;
}

export interface WatchEntry {
  mint: string;
  launchpad: string;
  first_seen: number;
  volume_usd: number;
  last_checked: number;
}

export interface AlertItem {
  mint: string;
  tier: string;
  reason: string;
  at: number;
}

export interface LaunchpadInfo {
  enabled: boolean;
}

export interface ScannerState {
  live: boolean;
  /** Which leg served the payload: public data repo, private repo, or local snapshot. */
  source: "live" | "private" | "snapshot";
  snapshot_at: number | null;
  updated_at: number;
  scanner: {
    status: "ok" | "error";
    last_poll: number;
    mints_seen_total: number;
    new_this_poll: number;
    error: string | null;
    launchpads: Record<string, LaunchpadInfo>;
  };
  watchlist: WatchEntry[];
  candidates: Candidate[];
  alerts: AlertItem[];
}

export interface Rung {
  n: number | string;
  returned_usd: number;
}

export interface JournalEntry {
  mint: string;
  tier: string | null;
  label: "s25" | "s35" | null;
  paper: boolean;
  entry_usd: number;
  entry_time: number;
  rungs: Rung[];
  realized_usd: number | null;
  closed: boolean;
  close_time: number | null;
}

export type Journal = Record<string, JournalEntry>;

export type Role = "dip" | "johnny";
