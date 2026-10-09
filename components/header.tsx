"use client";

import { Badge } from "@/components/ui/badge";
import type { Role, ScannerState } from "@/lib/types";
import type { StreamSnapshot } from "@/lib/stream/use-stream";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { WalletConnectButton } from "@/components/wallet-connect";

/**
 * The scanner pipeline writes state.json roughly every 6-18 minutes.
 * Flag the scanner feed as aging only when it is genuinely overdue
 * (2x the normal cadence), not on every quiet stretch.
 */
const SCANNER_WARN_SECONDS = 30 * 60;

function agoMs(epochMs: number | null | undefined): string {
  if (!epochMs) return "n/a";
  return timeAgo(Math.floor(epochMs / 1000));
}

/**
 * STREAM pill: reflects ACTUAL SSE stream activity from the useStream
 * snapshot. Never the scanner's data age, never faked.
 *
 *   LIVE    — an event arrived within the last 5s. Solid green dot.
 *   STALE   — quiet for 5-30s. Amber dot.
 *   OFFLINE — quiet 30s+ or the transport failed. Gray dot.
 *
 * The "ago" timestamp is the time since the last stream EVENT, measured
 * honestly. No events flowing means no LIVE, even if the socket is open.
 */
function StreamPill({ snap }: { snap: StreamSnapshot }) {
  let dot = "bg-mut";
  let label = "OFFLINE";
  let tone = "text-mut";

  if (snap.mode === "live") {
    dot = "bg-up";
    label = `LIVE · ${agoMs(snap.lastEventAt)}`;
    tone = "text-up";
  } else if (snap.mode === "stale") {
    dot = "bg-gold";
    label = `STALE · ${agoMs(snap.lastEventAt)}`;
    tone = "text-gold";
  } else if (snap.lastEventAt === null && !snap.transportUp) {
    dot = "bg-mut animate-pulse";
    label = "CONNECTING";
    tone = "text-mut";
  } else {
    dot = "bg-mut";
    label = snap.lastEventAt ? `OFFLINE · ${agoMs(snap.lastEventAt)}` : "OFFLINE";
    tone = "text-mut";
  }

  const title = [
    `stream: ${snap.mode}`,
    `transport: ${snap.transportUp ? "up" : "down"}`,
    `last event: ${snap.lastEventAt ? new Date(snap.lastEventAt).toLocaleTimeString() : "never"}`,
    `reconnects: ${snap.reconnects}`,
  ].join(" · ");

  return (
    <span
      className="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5"
      title={title}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", dot)} />
      <span className={cn("font-mono text-[11px] font-medium", tone)}>
        {label}
      </span>
    </span>
  );
}

/**
 * SCANNER pill: a SEPARATE, clearly labeled signal for scanner data
 * freshness (how recently the pipeline wrote state.json). This is data
 * age, not stream health — the two are never conflated.
 */
function ScannerPill({ state }: { state: ScannerState | null }) {
  if (!state) {
    return (
      <span className="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-mut" />
        <span className="font-mono text-[11px] text-mut">SCANNER · …</span>
      </span>
    );
  }
  const ageSec = Math.floor(Date.now() / 1000) - (state.updated_at ?? 0);
  const scannerOk = state.scanner?.status === "ok";

  let dot = "bg-up";
  let label = `SCANNER · ${timeAgo(state.updated_at)}`;
  let tone = "text-mut";
  if (!scannerOk) {
    dot = "bg-down";
    label = "SCANNER ERROR";
    tone = "text-down";
  } else if (ageSec > SCANNER_WARN_SECONDS) {
    dot = "bg-gold";
    tone = "text-gold";
  }

  return (
    <span
      className="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5"
      title={`scanner: ${state.scanner?.status ?? "unknown"} · last poll ${timeAgo(state.scanner?.last_poll)} · ${state.scanner?.mints_seen_total ?? 0} mints seen · data ${timeAgo(state.updated_at)} old`}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", dot)} />
      <span className={cn("font-mono text-[11px] font-medium", tone)}>
        {label}
      </span>
    </span>
  );
}

function BellButton({
  unread,
  onClick,
}: {
  unread: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={unread > 0 ? `${unread} unread alerts` : "alerts"}
      className="relative rounded-md border border-line bg-surface p-2 text-mut transition-colors hover:text-white"
    >
      <svg
        className="h-4 w-4"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
      {unread > 0 && (
        <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-gold px-1 font-mono text-[10px] font-semibold text-black">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </button>
  );
}

function HamburgerButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      aria-label="Open menu"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-mut transition-colors hover:text-white"
    >
      <svg
        className="h-4 w-4"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path d="M4 7h16M4 12h16M4 17h16" />
      </svg>
    </button>
  );
}

export function Header({
  role,
  state,
  stream,
  unread,
  onBell,
  onOpenMenu,
}: {
  role: Role;
  state: ScannerState | null;
  stream: StreamSnapshot;
  unread: number;
  onBell: () => void;
  onOpenMenu: () => void;
}) {
  function signOut() {
    document.cookie = "tyck_role=; Path=/; Max-Age=0";
    document.cookie = "tyck_sig=; Path=/; Max-Age=0";
    window.location.href = "/login";
  }

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/95 backdrop-blur">
      <div className="mx-auto max-w-7xl px-3 sm:px-4">
        <div className="flex h-12 items-center gap-2">
          <HamburgerButton onOpen={onOpenMenu} />
          <div className="flex shrink-0 items-baseline">
            <span className="font-mono text-base font-bold tracking-tight">
              <span className="text-gold">THE</span>
              <span className="text-white"> NINES</span>
            </span>
          </div>

          <div className="min-w-0 flex-1" />

          <div className="hidden md:block">
            <WalletConnectButton />
          </div>
          <StreamPill snap={stream} />
          <div className="hidden sm:block">
            <ScannerPill state={state} />
          </div>
          <BellButton unread={unread} onClick={onBell} />

          <Badge
            variant={role === "dip" ? "gold" : "blue"}
            className="hidden sm:inline-flex"
          >
            {role === "dip" ? "OWNER" : "VIEWER"}
          </Badge>
          <button
            className="hidden font-mono text-xs text-mut transition-colors hover:text-white sm:block"
            onClick={signOut}
          >
            sign out
          </button>
        </div>
      </div>
    </header>
  );
}
