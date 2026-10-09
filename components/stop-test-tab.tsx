"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import type { Journal } from "@/lib/types";
import { summarize } from "@/lib/trade-stats";
import { fmtSignedUsd } from "@/lib/format";

const GROUP_COLORS: Record<string, string> = {
  s25: "#e7b84b",
  s35: "#72a9c9",
};

function CompareChart({
  title,
  data,
  formatter,
}: {
  title: string;
  data: { label: string; value: number }[];
  formatter: (v: number) => string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-mono text-xs uppercase tracking-widest text-mut">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-48 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#232a33" strokeDasharray="3 3" />
              <XAxis
                dataKey="label"
                tick={{ fill: "#e8ebef", fontSize: 12, fontFamily: "monospace" }}
                stroke="#232a33"
              />
              <YAxis
                tick={{ fill: "#8a94a3", fontSize: 10, fontFamily: "monospace" }}
                stroke="#232a33"
                width={56}
                tickFormatter={(v: number) => formatter(v).replace(/(\.\d+)%?$/, "")}
              />
              <Tooltip
                contentStyle={{ background: "#14171b", border: "1px solid #232a33" }}
                labelStyle={{ color: "#e8ebef", fontFamily: "monospace" }}
                formatter={(v) => [formatter(Number(v)), "value"]}
              />
              <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                {data.map((d, i) => (
                  <Cell key={i} fill={(d as { fill?: string }).fill ?? "#8a94a3"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

export function StopTestTab({ journal }: { journal: Journal | null }) {
  const entries = Object.values(journal ?? {});
  const groups: Record<string, typeof entries> = {};
  for (const e of entries) {
    if (!e.label) continue;
    const key = e.label.toLowerCase();
    if (key !== "s25" && key !== "s35") continue;
    (groups[key] ||= []).push(e);
  }

  const labels = Object.keys(groups).sort();
  if (labels.length === 0) {
    return (
      <EmptyState
        title="Stop test is idle"
        body="The s25 vs s35 stop-loss experiment compares win rate, net PnL, average, and rung-1 rate across labeled positions. It wakes up once the first labeled paper trades close."
        hint="Positions are labeled s25 / s35 at entry during paper week (Oct 9–15)."
      />
    );
  }

  const summaries = labels.map((l) => ({ label: l, ...summarize(groups[l]) }));
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

  const withColor = <T extends { label: string }>(rows: T[]) =>
    rows.map((r) => ({ ...r, fill: GROUP_COLORS[r.label] ?? "#8a94a3" }));

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <CompareChart
          title="Win rate"
          data={withColor(summaries.map((s) => ({ label: s.label, value: s.winRate })))}
          formatter={pct}
        />
        <CompareChart
          title="Net PnL"
          data={withColor(summaries.map((s) => ({ label: s.label, value: s.net })))}
          formatter={(v) => fmtSignedUsd(v)}
        />
        <CompareChart
          title="Avg / trade"
          data={withColor(summaries.map((s) => ({ label: s.label, value: s.avg })))}
          formatter={(v) => fmtSignedUsd(v)}
        />
        <CompareChart
          title="Rung-1 rate"
          data={withColor(summaries.map((s) => ({ label: s.label, value: s.rung1Rate })))}
          formatter={pct}
        />
      </div>

      {/* counts table */}
      <Card>
        <CardHeader>
          <CardTitle className="font-mono text-xs uppercase tracking-widest text-mut">
            Sample sizes
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-6 font-mono text-sm">
            {summaries.map((s) => (
              <div key={s.label}>
                <span style={{ color: GROUP_COLORS[s.label] }}>{s.label}</span>
                <span className="text-mut">: {s.count} closed trades</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
