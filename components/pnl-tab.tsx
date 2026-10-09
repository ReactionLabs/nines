"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Journal } from "@/lib/types";
import { equityCurve, summarize } from "@/lib/trade-stats";
import { fmtSignedUsd, fmtTimeET } from "@/lib/format";
import { cn } from "@/lib/utils";

function Metric({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <p className="font-mono text-[11px] uppercase tracking-widest text-mut">{label}</p>
      <p
        className={cn(
          "mt-1 font-mono text-xl font-semibold",
          tone === "up" && "text-up",
          tone === "down" && "text-down",
          !tone && "text-white"
        )}
      >
        {value}
      </p>
    </div>
  );
}

export function PnlTab({ journal }: { journal: Journal | null }) {
  const entries = Object.values(journal ?? {});
  const all = summarize(entries);
  const paper = summarize(entries.filter((e) => e.paper));
  const live = summarize(entries.filter((e) => !e.paper));
  const curve = equityCurve(entries);

  if (all.count === 0) {
    return (
      <EmptyState
        title="No closed trades yet"
        body="Net PnL, the equity curve, win rate, and the paper-vs-live split unlock here once the first paper position closes. Paper week starts Oct 9."
        hint="Net = realized − entry × 1.04 (4% fee-and-slippage haircut)."
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* hero */}
      <Card>
        <CardHeader>
          <CardTitle className="font-mono text-xs uppercase tracking-widest text-mut">
            Net PnL (closed)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p
            className={cn(
              "font-mono text-4xl font-semibold",
              all.net > 0 ? "text-up" : all.net < 0 ? "text-down" : "text-white"
            )}
          >
            {fmtSignedUsd(all.net)}
          </p>
          <p className="mt-1 font-mono text-xs text-mut">
            realized minus 4% (entry * 1.04) across {all.count} closed trades
          </p>
        </CardContent>
      </Card>

      {/* equity curve */}
      <Card>
        <CardHeader>
          <CardTitle className="font-mono text-xs uppercase tracking-widest text-mut">
            Equity curve
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={curve} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#e7b84b" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#e7b84b" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#232a33" strokeDasharray="3 3" />
                <XAxis
                  dataKey="t"
                  tickFormatter={(t: number) => fmtTimeET(t).split(",")[0]}
                  tick={{ fill: "#8a94a3", fontSize: 10, fontFamily: "monospace" }}
                  stroke="#232a33"
                />
                <YAxis
                  tickFormatter={(v: number) => `$${Math.round(v)}`}
                  tick={{ fill: "#8a94a3", fontSize: 10, fontFamily: "monospace" }}
                  stroke="#232a33"
                  width={60}
                />
                <Tooltip
                  contentStyle={{ background: "#14171b", border: "1px solid #232a33" }}
                  labelStyle={{ color: "#8a94a3", fontFamily: "monospace", fontSize: 11 }}
                  formatter={(v) => [fmtSignedUsd(Number(v)), "equity"]}
                  labelFormatter={(t) => fmtTimeET(Number(t))}
                />
                <Area
                  type="monotone"
                  dataKey="equity"
                  stroke="#e7b84b"
                  strokeWidth={2}
                  fill="url(#eqFill)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* metrics */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="Win rate" value={`${(all.winRate * 100).toFixed(1)}%`} />
        <Metric label="Rung-1 rate" value={`${(all.rung1Rate * 100).toFixed(1)}%`} />
        <Metric label="Stopped" value={String(all.stopped)} />
        <Metric label="Avg / trade" value={fmtSignedUsd(all.avg)} tone={all.avg >= 0 ? "up" : "down"} />
      </div>

      {/* paper vs live */}
      <Card>
        <CardHeader>
          <CardTitle className="font-mono text-xs uppercase tracking-widest text-mut">
            Paper vs live
          </CardTitle>
        </CardHeader>
        <CardContent className="px-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mode</TableHead>
                <TableHead className="text-right">Trades</TableHead>
                <TableHead className="text-right">Net</TableHead>
                <TableHead className="text-right">Win rate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[
                { name: "Paper", s: paper },
                { name: "Live", s: live },
              ].map((row) => (
                <TableRow key={row.name}>
                  <TableCell className="font-mono text-sm text-white">{row.name}</TableCell>
                  <TableCell className="text-right font-mono text-sm">{row.s.count}</TableCell>
                  <TableCell
                    className={cn(
                      "text-right font-mono text-sm",
                      row.s.net > 0 ? "text-up" : row.s.net < 0 ? "text-down" : "text-mut"
                    )}
                  >
                    {fmtSignedUsd(row.s.net)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {(row.s.winRate * 100).toFixed(1)}%
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
