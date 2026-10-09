export function shortMint(mint: string): string {
  if (!mint || mint.length <= 12) return mint ?? "";
  return `${mint.slice(0, 5)}...${mint.slice(-5)}`;
}

export function fmtUsd(v: number | null | undefined, decimals = 0): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "n/a";
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  const body = abs.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${sign}$${body}`;
}

export function fmtSignedUsd(v: number | null | undefined, decimals = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "n/a";
  const sign = v > 0 ? "+" : v < 0 ? "-" : "";
  const abs = Math.abs(v);
  const body = abs.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${sign}$${body}`;
}

/** "3m ago", "2h ago", "4d ago". */
export function timeAgo(epochSec: number | null | undefined): string {
  if (!epochSec) return "n/a";
  const s = Math.floor(Date.now() / 1000) - epochSec;
  if (s < 0) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Format epoch seconds in America/New_York. */
export function fmtTimeET(epochSec: number | null | undefined): string {
  if (!epochSec) return "n/a";
  return new Date(epochSec * 1000).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Compact USD: $3.2k, $1.5M, $2.10B. Returns an em dash when unknown. */
export function fmtCompactUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const neg = v < 0;
  const abs = Math.abs(v);
  let body: string;
  if (abs >= 1_000_000_000) body = `${(abs / 1_000_000_000).toFixed(2)}B`;
  else if (abs >= 1_000_000) body = `${(abs / 1_000_000).toFixed(2)}M`;
  else if (abs >= 1_000) body = `${(abs / 1_000).toFixed(1)}k`;
  else body = abs.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `${neg ? "-" : ""}$${body}`;
}

/** Price formatting that keeps tiny memecoin prices readable. Never invented. */
export function fmtPrice(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  if (v === 0) return "$0";
  const abs = Math.abs(v);
  if (abs >= 100) return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (abs >= 1)
    return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  const digits = Math.min(10, Math.max(3, -Math.floor(Math.log10(abs)) + 2));
  return `$${v.toFixed(digits)}`;
}

/** Percent change: +12.4% / -3.1% / — */
export function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const sign = v > 0 ? "+" : v < 0 ? "-" : "";
  return `${sign}${Math.abs(v).toFixed(1)}%`;
}

export function gateScore(gates: { passed: boolean | null }[] | undefined | null): {
  passed: number;
  decided: number;
  total: number;
} {
  const g = gates ?? [];
  const decided = g.filter((x) => x.passed !== null);
  return {
    passed: decided.filter((x) => x.passed === true).length,
    decided: decided.length,
    total: g.length,
  };
}
