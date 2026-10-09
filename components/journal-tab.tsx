"use client";

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
import type { Journal, JournalEntry, Rung } from "@/lib/types";
import { tradeNet } from "@/lib/trade-stats";
import { fmtSignedUsd, fmtTimeET, fmtUsd, shortMint } from "@/lib/format";
import { cn } from "@/lib/utils";

function RungChip({ rung }: { rung: Rung }) {
  const n = String(rung.n).toLowerCase();
  const label =
    n === "1"
      ? "R1"
      : n === "2"
        ? "R2"
        : n === "sweep"
          ? "SWEEP"
          : n === "stop"
            ? "STOP"
            : `R${rung.n}`;
  const cls =
    n === "stop"
      ? "border-down/40 bg-down/10 text-down"
      : n === "sweep"
        ? "border-gold/40 bg-gold/10 text-gold"
        : "border-up/40 bg-up/10 text-up";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-px font-mono text-[11px] tabular-nums",
        cls
      )}
    >
      {label} {fmtSignedUsd(rung.returned_usd)}
    </span>
  );
}

function netTone(net: number | null): "up" | "down" | undefined {
  if (net === null || net === 0) return undefined;
  return net > 0 ? "up" : "down";
}

export function JournalTab({ journal }: { journal: Journal | null }) {
  const entries = Object.entries(journal ?? {}).sort(
    (a, b) => b[1].entry_time - a[1].entry_time
  );

  if (entries.length === 0) {
    return (
      <EmptyState
        title="Journal is empty"
        body="Paper week starts Oct 9. Every position taken from the feed — rung hits, sweeps, and stops — lands here with entry, exit, and net after the 4% fee-and-slippage haircut."
        hint="Positions are recorded by the engine journal; this view reads data/journal.json."
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Token</TableHead>
            <TableHead>Entry</TableHead>
            <TableHead className="text-right">Size</TableHead>
            <TableHead>Rungs</TableHead>
            <TableHead className="text-right">Realized</TableHead>
            <TableHead className="text-right">Net</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map(([key, e]: [string, JournalEntry]) => {
            const net = tradeNet(e);
            return (
              <TableRow key={key}>
                <TableCell>
                  <span className="font-mono text-sm text-white" title={e.mint}>
                    {shortMint(e.mint)}
                  </span>
                  <span className="ml-2 inline-flex gap-1">
                    {e.label && <Badge variant="gold" className="px-1 py-0 text-[10px]">{e.label}</Badge>}
                    {e.tier && <Badge variant="blue" className="px-1 py-0 text-[10px]">{e.tier}</Badge>}
                  </span>
                </TableCell>
                <TableCell className="whitespace-nowrap font-mono text-xs text-mut" title={fmtTimeET(e.entry_time)}>
                  {fmtTimeET(e.entry_time)}
                </TableCell>
                <TableCell className="text-right font-mono text-sm text-white tabular-nums">
                  {fmtUsd(e.entry_usd)}
                </TableCell>
                <TableCell>
                  {(e.rungs ?? []).length === 0 ? (
                    <span className="font-mono text-xs text-mut/60">—</span>
                  ) : (
                    <span className="flex flex-wrap gap-1">
                      {(e.rungs ?? []).map((r, i) => (
                        <RungChip key={i} rung={r} />
                      ))}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono text-sm text-white tabular-nums">
                  {e.realized_usd === null || e.realized_usd === undefined
                    ? <span className="text-mut/60">—</span>
                    : fmtSignedUsd(e.realized_usd)}
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right font-mono text-sm tabular-nums",
                    netTone(net) === "up" && "text-up",
                    netTone(net) === "down" && "text-down",
                    netTone(net) === undefined && "text-mut"
                  )}
                >
                  {net === null ? <span className="text-mut/60">—</span> : fmtSignedUsd(net)}
                </TableCell>
                <TableCell>
                  <span className="inline-flex gap-1">
                    {e.paper ? <Badge variant="outline">PAPER</Badge> : <Badge variant="green">LIVE</Badge>}
                    {!e.closed && <Badge variant="gray">OPEN</Badge>}
                  </span>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
