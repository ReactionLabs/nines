"use client";

import { useRouter } from "next/navigation";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Header } from "@/components/header";
import { NavDrawer } from "@/components/nav-drawer";
import { EstablishedCoins } from "@/components/established-coins";
import { MobileDock } from "@/components/mobile-dock";
import { Trenches } from "@/components/trenches";
import { NinesWatch } from "@/components/nines-watch";
import { RobotStatusBar } from "@/components/robot-status-bar";
import { TokenDrawer } from "@/components/token-drawer";
import { ExecuteTicket } from "@/components/execute-ticket";
import { AlertsTab } from "@/components/alerts-tab";
import { JournalTab } from "@/components/journal-tab";
import { PnlTab } from "@/components/pnl-tab";
import { StopTestTab } from "@/components/stop-test-tab";
import { PortfolioTab } from "@/components/portfolio-tab";
import { WatchedTab } from "@/components/watched-tab";
import { WatchlistTab } from "@/components/watchlist-tab";
import { SmartMoneyTab } from "@/components/smart-money-tab";
import { useEnrichment } from "@/lib/use-enrichment";
import { useHolderIntel } from "@/lib/use-holder-intel";
import { useLifecycle } from "@/lib/use-lifecycle";
import { useStream } from "@/lib/stream/use-stream";
import type { Candidate, Journal, Role, ScannerState } from "@/lib/types";
import {
  loadWatchlist,
  saveWatchlist,
  toggleWatchlist,
  removeFromWatchlist,
  type WatchlistEntry,
} from "@/lib/watchlist";
import { cn } from "@/lib/utils";

const SEEN_KEY = "tyck:alerts:seen_at";

function readSeen(): number {
  if (typeof window === "undefined") return 0;
  const v = Number(window.localStorage.getItem(SEEN_KEY));
  return Number.isFinite(v) ? v : 0;
}

export default function Dashboard({ role }: { role: Role }) {
  const [state, setState] = useState<ScannerState | null>(null);
  const [journal, setJournal] = useState<Journal | null>(null);
  const [tab, setTab] = useState("trenches");
  const [selected, setSelected] = useState<Candidate | null>(null);
  const router = useRouter();
  // Tap a coin -> full coin page (drawer kept for quick view elsewhere)
  const openCoin = (c: Candidate | null) => {
    if (c) router.push(`/coin/${encodeURIComponent(c.mint)}`);
  };
  const [ticket, setTicket] = useState<Candidate | null>(null);
  const [seenAt, setSeenAt] = useState<number>(() => readSeen());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>(() =>
    loadWatchlist()
  );

  // Persist the personal watchlist per device.
  useEffect(() => {
    saveWatchlist(watchlist);
  }, [watchlist]);

  const watchedMints = useMemo(
    () => new Set(watchlist.map((w) => w.mint)),
    [watchlist]
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/state");
      if (res.ok) setState(await res.json());
    } catch {
      /* keep last state */
    }
    try {
      const res = await fetch("/api/journal");
      if (res.ok) setJournal(await res.json());
    } catch {
      /* keep last journal */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Live stream replaces the 60s poll: status/pairs/alerts events trigger
   * an immediate state reload. The interval below is fallback only — it
   * runs while the stream is offline.
   */
  const stream = useStream({
    topics: ["status", "pairs", "alerts"],
    onEvent: (topic) => {
      if (topic === "status" || topic === "pairs" || topic === "alerts") {
        load();
      }
    },
  });

  useEffect(() => {
    if (stream.mode === "offline") {
      const t = setInterval(load, 60_000);
      return () => clearInterval(t);
    }
  }, [load, stream.mode]);

  const mints = useMemo(
    () => [
      ...(state?.candidates ?? []).map((c) => c.mint),
      ...watchlist.map((w) => w.mint),
    ],
    [state, watchlist]
  );
  const { byMint, refresh: refreshEnrich } = useEnrichment(mints);
  // Compact holder intel for the feed cards (best-effort; cards render
  // without it while it loads or if the scan fails).
  const { byMint: intelByMint } = useHolderIntel(
    (state?.candidates ?? []).map((c) => c.mint)
  );

  // Shared lifecycle map: dashboard owns it, Trenches consumes via prop
  // (no duplicate fetches), and the robot status bar counts final-stretch.
  const life = useLifecycle(mints);
  const finalCount = useMemo(
    () => Object.values(life).filter((l) => l.stage === "final").length,
    [life]
  );

  useEffect(() => {
    refreshEnrich();
  }, [state?.updated_at, refreshEnrich]);

  const alerts = state?.alerts ?? [];
  const unread = alerts.filter((a) => (a.at ?? 0) > seenAt).length;

  function goToAlerts() {
    setTab("alerts");
    const now = Math.floor(Date.now() / 1000);
    setSeenAt(now);
    try {
      window.localStorage.setItem(SEEN_KEY, String(now));
    } catch {
      /* storage unavailable */
    }
  }

  function openExecute(c: Candidate) {
    setTicket(c);
  }

  const candidatesByMint = useMemo(() => {
    const out: Record<string, Candidate> = {};
    for (const c of state?.candidates ?? []) out[c.mint] = c;
    return out;
  }, [state]);

  /** Star toggle: snapshots the live price at tap time. */
  function toggleWatch(c: Candidate) {
    const e = byMint[c.mint];
    const { list } = toggleWatchlist(watchlist, {
      mint: c.mint,
      symbol: e?.symbol ?? null,
      name: e?.name ?? null,
      imageUrl: c.image_url || e?.imageUrl || null,
      priceAtAdd:
        typeof e?.priceUsd === "number" && Number.isFinite(e.priceUsd)
          ? e.priceUsd
          : null,
      addedAt: Math.floor(Date.now() / 1000),
    });
    setWatchlist(list);
  }

  function removeWatch(mint: string) {
    setWatchlist((w) => removeFromWatchlist(w, mint));
  }

  /** Open the chart drawer for a watchlist coin, even if it left the feed. */
  function openWatchlistMint(mint: string) {
    const c = candidatesByMint[mint];
    if (c) {
      openCoin(c);
      return;
    }
    const w = watchlist.find((x) => x.mint === mint);
    openCoin({
      mint,
      launchpad: "watchlist",
      first_seen: w?.addedAt ?? 0,
      tier: "watch",
      volume_usd: null,
      image_url: w?.imageUrl ?? null,
      gates: [],
      verdict: "PASS",
      partial: false,
      alerted: false,
      alerted_at: null,
      reason: "Personal watchlist",
    });
  }

  return (
    <div className="min-h-screen bg-bg">
      <Header
        role={role}
        state={state}
        stream={stream}
        unread={unread}
        onBell={goToAlerts}
        onOpenMenu={() => setDrawerOpen(true)}
      />

      <NavDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        role={role}
        activeTab={tab}
        onNavigate={setTab}
        onSignOut={() => {
          document.cookie = "tyck_role=; Path=/; Max-Age=0";
          document.cookie = "tyck_sig=; Path=/; Max-Age=0";
          window.location.href = "/login";
        }}
      />

      <main className="mx-auto max-w-7xl px-4 pb-28 pt-4 md:pb-4">
        {state === null ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <>
            {/* Robot status: stream-driven, tap to expand */}
            <div className="mb-4 mt-1">
              <RobotStatusBar
                streamMode={stream.mode}
                lastEventAt={stream.lastEventAt}
                newCount={state.scanner?.new_this_poll ?? 0}
                finalCount={finalCount}
                state={state}
              />
            </div>

            <Tabs value={tab} onValueChange={setTab}>
              {/* Desktop tab bar — the mobile dock replaces this on small screens */}
              <div className="mb-3 hidden items-center justify-between gap-3 overflow-x-auto md:flex">
                <TabsList>
                  <TabsTrigger value="trenches">Trenches</TabsTrigger>
                  <TabsTrigger value="nines">
                    <span className="mr-1 font-bold text-gold">9</span>
                    The Nines
                  </TabsTrigger>
                  <TabsTrigger value="alerts">
                    Alerts
                    {alerts.length > 0 && (
                      <span
                        className={cn(
                          "ml-1.5 rounded-full px-1.5 py-px font-mono text-[10px]",
                          unread > 0
                            ? "bg-gold text-black"
                            : "bg-raised text-mut"
                        )}
                      >
                        {alerts.length}
                      </span>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="smart-money">
                    <span className="mr-1 font-bold text-gold">$</span>
                    Smart Money
                  </TabsTrigger>
                  <TabsTrigger value="watched">Watched</TabsTrigger>
                  <TabsTrigger value="watchlist">
                    Watchlist
                    {watchlist.length > 0 && (
                      <span className="ml-1.5 rounded-full bg-gold px-1.5 py-px font-mono text-[10px] text-black">
                        {watchlist.length}
                      </span>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="journal">Journal</TabsTrigger>
                  <TabsTrigger value="pnl">PnL</TabsTrigger>
                  <TabsTrigger value="stop-test">Stop-test</TabsTrigger>
                  <TabsTrigger value="portfolio">Portfolio</TabsTrigger>
                </TabsList>
                <p className="hidden shrink-0 font-mono text-[11px] text-mut/60 lg:block">
                  {state.scanner?.mints_seen_total ?? 0} mints seen ·{" "}
                  {(state.scanner?.new_this_poll ?? 0) > 0 && (
                    <span className="text-gold">
                      +{state.scanner.new_this_poll} new ·{" "}
                    </span>
                  )}
                  paper phase
                </p>
              </div>

              <TabsContent value="trenches">
                <Trenches
                  candidates={state.candidates ?? []}
                  byMint={byMint}
                  onBuy={openExecute}
                  onSelect={openCoin}
                  watchedMints={watchedMints}
                  onToggleWatch={toggleWatch}
                  intelByMint={intelByMint}
                  life={life}
                />
                <div className="mt-6">
                  <EstablishedCoins />
                </div>
              </TabsContent>
              <TabsContent value="nines">
                <NinesWatch
                  candidates={state.candidates ?? []}
                  byMint={byMint}
                  onSelect={openCoin}
                  watchedMints={watchedMints}
                  onToggleWatch={toggleWatch}
                />
              </TabsContent>
              <TabsContent value="alerts">
                <AlertsTab
                  alerts={alerts}
                  candidates={state.candidates ?? []}
                  onOpen={openCoin}
                />
              </TabsContent>
              <TabsContent value="smart-money">
                <SmartMoneyTab onSelectMint={openWatchlistMint} />
              </TabsContent>
              <TabsContent value="watched">
                <WatchedTab
                  onSelectMint={(mint) =>
                    openCoin({
                      mint,
                      launchpad: "watchlist",
                      first_seen: 0,
                      tier: "watch",
                      volume_usd: null,
                      image_url: null,
                      gates: [],
                      verdict: "PASS",
                      partial: false,
                      alerted: false,
                      alerted_at: null,
                      reason: "Watched wallet holding",
                    })
                  }
                />
              </TabsContent>
              <TabsContent value="watchlist">
                <WatchlistTab
                  entries={watchlist}
                  byMint={byMint}
                  candidatesByMint={candidatesByMint}
                  onSelectMint={openWatchlistMint}
                  onRemove={removeWatch}
                />
              </TabsContent>
              <TabsContent value="journal">
                <JournalTab journal={journal} />
              </TabsContent>
              <TabsContent value="pnl">
                <PnlTab journal={journal} />
              </TabsContent>
              <TabsContent value="stop-test">
                <StopTestTab journal={journal} />
              </TabsContent>
              <TabsContent value="portfolio">
                <PortfolioTab />
              </TabsContent>
            </Tabs>
          </>
        )}
      </main>

      {/* token detail drawer */}
      <TokenDrawer
        candidate={selected}
        enriched={selected ? byMint[selected.mint] ?? null : null}
        role={role}
        watched={selected ? watchedMints.has(selected.mint) : false}
        onToggleWatch={() => selected && toggleWatch(selected)}
        onClose={() => setSelected(null)}
        onExecute={openExecute}
      />

      {/* execute ticket (dip only; endpoint 403s johnny server-side) */}
      <ExecuteTicket
        open={ticket !== null}
        onOpenChange={(o) => !o && setTicket(null)}
        candidate={ticket}
        enriched={ticket ? byMint[ticket.mint] ?? null : null}
      />

      {/* mobile bottom dock: all 9 tabs */}
      <MobileDock
        tab={tab}
        onTabChange={setTab}
        alertsCount={alerts.length}
        unreadAlerts={unread}
        watchlistCount={watchlist.length}
      />
    </div>
  );
}
