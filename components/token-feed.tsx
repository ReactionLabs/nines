"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/empty-state";
import { TokenIcon } from "@/components/token-image";
import type { Candidate, Role, WatchEntry } from "@/lib/types";
import type { EnrichedToken } from "@/lib/dexscreener";
import type { EnrichStatus } from "@/lib/use-enrichment";
import { useTokenImages } from "@/lib/use-token-images";
import {
  fmtCompactUsd,
  fmtPct,
  fmtPrice,
  gateScore,
  shortMint,
  timeAgo,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  FilterBar,
  DEFAULT_FILTERS,
  DEFAULT_SORT,
  DEFAULT_DIR,
  parseUsd,
  parseNum,
  activeFilterCount,
  type FeedFilterState,
  type SortKey,
} from "@/components/feed-filters";

function CopyMintButton({ mint }: { mint: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      aria-label="Copy mint address"
      title="Copy full mint address"
      className="rounded p-0.5 text-mut/60 transition-colors hover:bg-raised hover:text-white"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(mint).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? (
        <svg className="h-3.5 w-3.5 text-up" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      ) : (
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

function GateDots({ candidate }: { candidate: Candidate }) {
  const score = gateScore(candidate.gates);
  const failed = (candidate.gates ?? []).filter((g) => g.passed === false).length;
  const pending = (candidate.gates ?? []).filter((g) => g.passed === null).length;
  return (
    <span
      className="flex items-center gap-2"
      title={`${score.passed} passed · ${failed} failed · ${pending} pending`}
    >
      <span className="font-mono text-xs text-white tabular-nums">
        {score.passed}/{score.total}
      </span>
      <span className="inline-flex items-center gap-1">
        {(candidate.gates ?? []).map((g) => (
          <span
            key={g.n}
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              g.passed === true && "bg-up",
              g.passed === false && "bg-down",
              g.passed === null && "bg-mut/30"
            )}
          />
        ))}
      </span>
    </span>
  );
}

function SortableHead({
  label,
  k,
  sort,
  dir,
  onSort,
  className,
}: {
  label: string;
  k: SortKey;
  sort: SortKey;
  dir: 1 | -1;
  onSort: (k: SortKey) => void;
  className?: string;
}) {
  const active = sort === k;
  return (
    <TableHead className={className}>
      <button
        onClick={() => onSort(k)}
        className={cn(
          "inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-wider transition-colors",
          active ? "text-gold" : "text-mut hover:text-white"
        )}
      >
        {label}
        <span className={cn("text-[9px]", active ? "opacity-100" : "opacity-30")}>
          {active ? (dir === 1 ? "▲" : "▼") : "△"}
        </span>
      </button>
    </TableHead>
  );
}

function num(v: number | null | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

const VALID_SORTS: SortKey[] = [
  "token",
  "price",
  "mcap",
  "liq",
  "vol",
  "gates",
  "seen",
  "change",
];
const FILTER_KEY = "tyck:feed:filters:v1";

function loadPersisted(): {
  filters: FeedFilterState;
  sort: SortKey;
  dir: 1 | -1;
} | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(FILTER_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    const filters: FeedFilterState = { ...DEFAULT_FILTERS, ...(d.filters ?? {}) };
    if (![0, 7, 8, 9].includes(filters.minGates)) filters.minGates = 0;
    filters.whaleOnly = !!filters.whaleOnly;
    filters.hasImage = !!filters.hasImage;
    for (const k of ["mcapMin", "mcapMax", "liqMin", "volMin", "ageMaxHrs"] as const) {
      if (typeof filters[k] !== "string") filters[k] = "";
    }
    const sort: SortKey = VALID_SORTS.includes(d.sort)
      ? (d.sort as SortKey)
      : DEFAULT_SORT;
    const dir: 1 | -1 = d.dir === 1 ? 1 : -1;
    return { filters, sort, dir };
  } catch {
    return null;
  }
}

export function TokenFeed({
  candidates,
  watchlist,
  byMint,
  enrichStatus,
  enrichUpdatedAt,
  role,
  query,
  onSelect,
  onExecute,
}: {
  candidates: Candidate[];
  watchlist: WatchEntry[];
  byMint: Record<string, EnrichedToken>;
  enrichStatus: EnrichStatus;
  enrichUpdatedAt: number | null;
  role: Role;
  query: string;
  onSelect: (c: Candidate) => void;
  onExecute: (c: Candidate) => void;
}) {
  const [persisted] = useState(loadPersisted);
  const [sort, setSort] = useState<SortKey>(persisted?.sort ?? DEFAULT_SORT);
  const [dir, setDir] = useState<1 | -1>(persisted?.dir ?? DEFAULT_DIR);
  const [filters, setFilters] = useState<FeedFilterState>(
    persisted?.filters ?? DEFAULT_FILTERS
  );
  const [watchOpen, setWatchOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  // Persist filter + sort state.
  useEffect(() => {
    try {
      window.localStorage.setItem(
        FILTER_KEY,
        JSON.stringify({ filters, sort, dir })
      );
    } catch {
      /* storage unavailable */
    }
  }, [filters, sort, dir]);

  // Whale-buy mints: fetched once per feed turnover when the toggle is on.
  // The pipeline is dormant until Dip supplies the whitelist, so this is
  // usually an empty set — the toggle is future-proofed, not faked.
  const [whaleMints, setWhaleMints] = useState<Set<string> | null>(null);
  const [whaleLoading, setWhaleLoading] = useState(false);
  const [whaleDormant, setWhaleDormant] = useState(false);
  const mintKey = useMemo(
    () => candidates.map((c) => c.mint).join(","),
    [candidates]
  );

  useEffect(() => {
    setWhaleMints(null);
    setWhaleDormant(false);
  }, [mintKey]);

  useEffect(() => {
    if (!filters.whaleOnly || whaleMints !== null) return;
    let cancelled = false;
    setWhaleLoading(true);
    (async () => {
      const mints = candidates.map((c) => c.mint);
      const hits = new Set<string>();
      let walletCount = 0;
      let sawResponse = false;
      const CHUNK = 12;
      for (let i = 0; i < mints.length && !cancelled; i += CHUNK) {
        const chunk = mints.slice(i, i + CHUNK);
        const results = await Promise.all(
          chunk.map((mint) =>
            fetch(`/api/whale-buys?mint=${encodeURIComponent(mint)}`)
              .then((r) => (r.ok ? r.json() : null))
              .then((d) => {
                if (!sawResponse && d) {
                  sawResponse = true;
                  walletCount = d.walletCount ?? 0;
                }
                return (d?.buys?.length ?? 0) > 0 ? mint : null;
              })
              .catch(() => null)
          )
        );
        for (const m of results) if (m) hits.add(m);
      }
      if (!cancelled) {
        setWhaleMints(hits);
        setWhaleDormant(sawResponse && walletCount === 0);
        setWhaleLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filters.whaleOnly, whaleMints, candidates]);

  function handleSort(k: SortKey) {
    if (k === sort) {
      setDir((d) => (d === 1 ? -1 : 1));
    } else {
      setSort(k);
      setDir(-1);
    }
  }

  function handleSortSelect(s: SortKey, d: 1 | -1) {
    setSort(s);
    setDir(d);
  }

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    const nowSec = Date.now() / 1000;
    const mcapMin = parseUsd(filters.mcapMin);
    const mcapMax = parseUsd(filters.mcapMax);
    const liqMin = parseUsd(filters.liqMin);
    const volMin = parseUsd(filters.volMin);
    const ageMax = parseNum(filters.ageMaxHrs);

    const list = candidates.filter((c) => {
      if (q) {
        const e0 = byMint[c.mint];
        const hit =
          c.mint.toLowerCase().includes(q) ||
          c.launchpad.toLowerCase().includes(q) ||
          (e0?.symbol ?? "").toLowerCase().includes(q) ||
          (e0?.name ?? "").toLowerCase().includes(q);
        if (!hit) return false;
      }
      const e = byMint[c.mint];
      if (mcapMin !== null && (e?.mcapUsd == null || e.mcapUsd < mcapMin))
        return false;
      if (mcapMax !== null && (e?.mcapUsd == null || e.mcapUsd > mcapMax))
        return false;
      if (liqMin !== null && (e?.liqUsd == null || e.liqUsd < liqMin))
        return false;
      if (volMin !== null && (e?.vol24h == null || e.vol24h < volMin))
        return false;
      if (ageMax !== null && (nowSec - c.first_seen) / 3600 > ageMax)
        return false;
      if (filters.minGates > 0 && gateScore(c.gates).passed < filters.minGates)
        return false;
      if (filters.whaleOnly && whaleMints !== null && !whaleMints.has(c.mint))
        return false;
      if (filters.hasImage && !(c.image_url || e?.imageUrl)) return false;
      return true;
    });

    const keyVal = (c: Candidate): number | string => {
      const e = byMint[c.mint];
      switch (sort) {
        case "token":
          return (e?.symbol ?? c.mint).toLowerCase();
        case "price":
          return num(e?.priceUsd, -1);
        case "mcap":
          return num(e?.mcapUsd, -1);
        case "liq":
          return num(e?.liqUsd, -1);
        case "vol":
          return num(e?.vol24h, -1);
        case "change":
          return num(e?.change24h, -1);
        case "gates":
          return gateScore(c.gates).passed;
        case "seen":
          return c.first_seen;
      }
    };

    const alertRank = (c: Candidate) => (c.verdict === "ALERT" ? 0 : 1);
    return [...list].sort((a, b) => {
      // ALERTs pin to the top unless the user is explicitly sorting.
      if (sort === "seen" && dir === -1 && alertRank(a) !== alertRank(b)) {
        return alertRank(a) - alertRank(b);
      }
      const va = keyVal(a);
      const vb = keyVal(b);
      if (typeof va === "string" || typeof vb === "string") {
        const cmp = String(va).localeCompare(String(vb));
        return dir === 1 ? cmp : -cmp;
      }
      if (va === vb) return b.first_seen - a.first_seen;
      return dir === 1 ? va - vb : vb - va;
    });
  }, [candidates, q, byMint, sort, dir, filters, whaleMints]);

  const hasActiveFilters = activeFilterCount(filters) > 0;

  // Logos for tokens the scanner + DexScreener didn't resolve an image for.
  // Renders don't wait on this: rows show the letter fallback until a
  // batch resolves, then the logo swaps into the same fixed-size slot.
  const needImageMints = useMemo(
    () =>
      filtered
        .filter((c) => !c.image_url && !byMint[c.mint]?.imageUrl)
        .map((c) => c.mint),
    [filtered, byMint]
  );
  const { images } = useTokenImages(needImageMints);

  const lowVolume = (watchlist ?? []).filter((w) => (w.volume_usd ?? 0) < 1000);

  if (candidates.length === 0) {
    return (
      <EmptyState
        title="Feed is empty"
        body="No candidates have cleared the scanner yet. When a fresh mint passes the gate set, it lands here with live market data."
        hint="Scanner watches pump.fun and other launchpads on a rolling poll."
      />
    );
  }

  return (
    <div className="space-y-3">
      <FilterBar
        filters={filters}
        onFilters={setFilters}
        sort={sort}
        dir={dir}
        onSort={handleSortSelect}
        shown={filtered.length}
        total={candidates.length}
        whaleLoading={whaleLoading}
        whaleDormant={whaleDormant}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((v) => !v)}
      />
      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHead label="Token" k="token" sort={sort} dir={dir} onSort={handleSort} />
              <SortableHead label="Price" k="price" sort={sort} dir={dir} onSort={handleSort} className="text-right" />
              <SortableHead label="MCap" k="mcap" sort={sort} dir={dir} onSort={handleSort} className="text-right" />
              <SortableHead label="Liq" k="liq" sort={sort} dir={dir} onSort={handleSort} className="text-right" />
              <SortableHead label="Vol 24h" k="vol" sort={sort} dir={dir} onSort={handleSort} className="text-right" />
              <SortableHead label="Gates" k="gates" sort={sort} dir={dir} onSort={handleSort} />
              <TableHead>
                <span className="font-mono text-[11px] uppercase tracking-wider text-mut">Verdict</span>
              </TableHead>
              <SortableHead label="First seen" k="seen" sort={sort} dir={dir} onSort={handleSort} />
              <TableHead>
                <span className="font-mono text-[11px] uppercase tracking-wider text-mut">Launchpad</span>
              </TableHead>
              {role === "dip" && (
                <TableHead className="text-right">
                  <span className="font-mono text-[11px] uppercase tracking-wider text-mut">Trade</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((c) => {
              const e = byMint[c.mint];
              const change = e?.change24h;
              return (
                <TableRow
                  key={c.mint}
                  className="cursor-pointer"
                  onClick={() => onSelect(c)}
                >
                  <TableCell>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <TokenIcon
                          src={c.image_url || images[c.mint] || e?.imageUrl}
                          symbol={e?.symbol}
                        />
                        <span className="truncate text-sm font-semibold text-white">
                          {e?.symbol ?? shortMint(c.mint)}
                        </span>
                        {c.verdict === "ALERT" && (
                          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-gold" />
                        )}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1">
                        <span className="font-mono text-[11px] text-mut" title={c.mint}>
                          {shortMint(c.mint)}
                        </span>
                        <CopyMintButton mint={c.mint} />
                        <Badge variant="blue" className="px-1 py-0 text-[10px]">
                          {c.tier}
                        </Badge>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="font-mono text-sm text-white tabular-nums">
                      {e ? fmtPrice(e.priceUsd) : <span className="text-mut/50">…</span>}
                    </span>
                    {change !== null && change !== undefined && (
                      <span
                        className={cn(
                          "ml-1.5 font-mono text-[11px] tabular-nums",
                          change > 0 ? "text-up" : change < 0 ? "text-down" : "text-mut"
                        )}
                      >
                        {fmtPct(change)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm text-white tabular-nums">
                    {e ? fmtCompactUsd(e.mcapUsd) : <span className="text-mut/50">…</span>}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm text-white tabular-nums">
                    {e ? fmtCompactUsd(e.liqUsd) : <span className="text-mut/50">…</span>}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm text-white tabular-nums">
                    {e ? fmtCompactUsd(e.vol24h) : <span className="text-mut/50">…</span>}
                  </TableCell>
                  <TableCell>
                    <GateDots candidate={c} />
                  </TableCell>
                  <TableCell>
                    {c.verdict === "ALERT" ? (
                      <Badge variant="gold" className="animate-pulseGold">
                        ALERT
                      </Badge>
                    ) : (
                      <Badge variant="gray">PASS</Badge>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs text-mut">
                    {timeAgo(c.first_seen)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{c.launchpad}</Badge>
                  </TableCell>
                  {role === "dip" && (
                    <TableCell className="text-right">
                      <button
                        className="rounded border border-up/50 bg-up/10 px-2.5 py-1 font-mono text-[11px] font-semibold text-up transition-colors hover:bg-up hover:text-black"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          onExecute(c);
                        }}
                      >
                        BUY
                      </button>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {filtered.length === 0 && (q || hasActiveFilters) && (
          <div className="px-4 py-8 text-center">
            <p className="font-mono text-sm text-mut">
              {q
                ? `No tokens match “${query.trim()}”.`
                : "No tokens match these filters."}
            </p>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={() => setFilters({ ...DEFAULT_FILTERS })}
                className="mt-3 rounded border border-gold/50 px-3 py-1.5 font-mono text-xs text-gold transition-colors hover:bg-gold hover:text-black"
              >
                Clear filters
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <p className="font-mono text-[11px] text-mut/70">
          {filtered.length} token{filtered.length === 1 ? "" : "s"} ·{" "}
          {enrichStatus === "loading" || enrichStatus === "idle"
            ? "loading market data…"
            : enrichStatus === "error"
              ? "market data unavailable (DexScreener unreachable)"
              : `market data via DexScreener${enrichUpdatedAt ? ` · ${timeAgo(enrichUpdatedAt)}` : ""}`}
        </p>
        <p className="font-mono text-[11px] text-mut/50">
          — = not listed on DexScreener; figures withheld, never estimated
        </p>
      </div>

      {/* watchlist: sub-$1k volume */}
      <div className="rounded-lg border border-line bg-surface">
        <button
          className="flex w-full items-center justify-between px-4 py-2.5"
          onClick={() => setWatchOpen((v) => !v)}
        >
          <span className="font-mono text-[11px] uppercase tracking-widest text-mut">
            Watching · below $1k volume ({lowVolume.length})
          </span>
          <span className="font-mono text-xs text-mut">{watchOpen ? "–" : "+"}</span>
        </button>
        {watchOpen && (
          <div className="border-t border-line px-4 py-1">
            {lowVolume.length === 0 ? (
              <p className="py-3 font-mono text-xs text-mut">Watchlist is empty.</p>
            ) : (
              lowVolume.map((w) => (
                <div
                  key={w.mint}
                  className="flex items-center justify-between border-b border-line/50 py-2 last:border-0"
                >
                  <span className="flex items-center gap-1.5 font-mono text-xs text-info" title={w.mint}>
                    {shortMint(w.mint)}
                    <CopyMintButton mint={w.mint} />
                  </span>
                  <span className="font-mono text-xs text-mut">
                    {fmtCompactUsd(w.volume_usd)} · {timeAgo(w.first_seen)}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
