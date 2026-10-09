"use client";

import { useState } from "react";
import { Mascot } from "@/components/mascot";
import type { ScannerState } from "@/lib/types";
import type { StreamMode } from "@/lib/stream/use-stream";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

export type RobotMode = "watching" | "idle" | "offline";

interface RobotStatusBarProps {
  /**
   * Stream state from useStream: the stream IS the connection indicator.
   * live = events flowing (solid dot). stale = quiet 5-30s (amber).
   * offline = quiet 30s+ or transport failed (gray). Never faked.
   */
  streamMode: StreamMode;
  /** ms epoch of the last stream event, null if none yet. */
  lastEventAt: number | null;
  /** Live counts from the feed. */
  newCount: number;
  finalCount: number;
  state: ScannerState | null;
}

/** Derive the robot's mode from stream state + scanner state. Never faked. */
export function robotMode(
  streamMode: StreamMode,
  state: ScannerState | null
): RobotMode {
  if (streamMode === "offline") return "offline";
  if (streamMode === "stale") return "idle";
  if (!state) return "idle";
  const scannerOk = state.scanner?.status === "ok";
  const ageSec = Math.floor(Date.now() / 1000) - (state.updated_at ?? 0);
  if (scannerOk && ageSec <= 120) return "watching";
  return "idle";
}

const MODE_STYLE: Record<RobotMode, { dot: string; label: string; tone: string }> = {
  watching: {
    dot: "bg-up",
    label: "WATCHING",
    tone: "text-up",
  },
  idle: {
    dot: "bg-gold",
    label: "IDLE",
    tone: "text-gold",
  },
  offline: {
    dot: "bg-down",
    label: "OFFLINE",
    tone: "text-down",
  },
};

/**
 * Compact robot status bar. Replaces the large mascot block on mobile:
 * solid stream-state dot, real scanner counts, tap to expand the full
 * 3D robot with agent activity.
 */
export function RobotStatusBar({
  streamMode,
  lastEventAt,
  newCount,
  finalCount,
  state,
}: RobotStatusBarProps) {
  const [expanded, setExpanded] = useState(false);
  const mode = robotMode(streamMode, state);
  const s = MODE_STYLE[mode];

  return (
    <div className="mb-3">
      <button
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse robot status" : "Expand robot status"}
        className="flex w-full items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2 text-left transition-colors hover:border-mut/40"
      >
        {/* stream dot: solid, no animation. Data flowing = alive. */}
        <span
          className={cn("h-2 w-2 shrink-0 rounded-full", s.dot)}
          aria-hidden="true"
        />
        <span className="text-base leading-none" aria-hidden="true">
          🤖
        </span>
        <span className={cn("font-mono text-[12px] font-semibold tracking-wider", s.tone)}>
          {s.label}
        </span>
        <span className="font-mono text-[11px] text-mut">
          · {newCount} NEW · {finalCount} FINAL STRETCH
        </span>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-mut/70">
          {expanded ? "▲" : "▼"}
        </span>
      </button>

      {expanded && (
        <div className="mt-2 rounded-lg border border-line bg-surface p-4">
          <Mascot size={140} connected={streamMode === "live"} />
          {/* agent activity: real scanner numbers, never invented */}
          <dl className="mx-auto mt-3 grid max-w-xs grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-[11px]">
            <dt className="text-mut">scanner</dt>
            <dd className={cn("text-right", state?.scanner?.status === "ok" ? "text-up" : "text-down")}>
              {state?.scanner?.status ?? "—"}
            </dd>
            <dt className="text-mut">last poll</dt>
            <dd className="text-right text-white">
              {state?.scanner?.last_poll ? timeAgo(state.scanner.last_poll) : "—"}
            </dd>
            <dt className="text-mut">mints seen</dt>
            <dd className="text-right text-white">
              {(state?.scanner?.mints_seen_total ?? 0).toLocaleString()}
            </dd>
            <dt className="text-mut">new this poll</dt>
            <dd className="text-right text-gold">
              {state?.scanner?.new_this_poll ?? 0}
            </dd>
            <dt className="text-mut">stream</dt>
            <dd className={cn("text-right", streamMode === "live" ? "text-up" : streamMode === "stale" ? "text-gold" : "text-down")}>
              {streamMode}
            </dd>
            <dt className="text-mut">last event</dt>
            <dd className="text-right text-white">
              {lastEventAt ? timeAgo(Math.floor(lastEventAt / 1000)) : "—"}
            </dd>
            <dt className="text-mut">data feed</dt>
            <dd className="text-right text-white">
              {state ? timeAgo(state.updated_at) : "—"}
            </dd>
          </dl>
        </div>
      )}
    </div>
  );
}
