"use client";

import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/empty-state";
import type { AlertItem, Candidate } from "@/lib/types";
import { fmtTimeET, shortMint, timeAgo } from "@/lib/format";

export function AlertsTab({
  alerts,
  candidates,
  onOpen,
}: {
  alerts: AlertItem[];
  candidates: Candidate[];
  onOpen?: (c: Candidate) => void;
}) {
  const sorted = [...(alerts ?? [])].sort((a, b) => b.at - a.at);

  if (sorted.length === 0) {
    return (
      <EmptyState
        title="No alerts yet"
        body="When a fresh mint clears the gate set, the scanner fires an alert here with the gate score and the reason it passed. You will see the newest alert at the top."
        hint="Alerts also carry a DELIVERED / PENDING flag from the alert pipeline."
      />
    );
  }

  return (
    <div className="space-y-2">
      {sorted.map((a, i) => {
        const cand = (candidates ?? []).find((c) => c.mint === a.mint);
        const delivered = cand ? cand.alerted === true : false;
        const inner = (
          <div className="flex items-center gap-4 rounded-lg border border-line border-l-2 border-l-gold bg-surface px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm text-white" title={a.mint}>
                  {shortMint(a.mint)}
                </span>
                <Badge variant="blue">{a.tier}</Badge>
                {delivered ? (
                  <Badge variant="green">DELIVERED</Badge>
                ) : (
                  <Badge variant="gray">PENDING</Badge>
                )}
              </div>
              <p className="mt-1 truncate text-sm text-mut">{a.reason}</p>
            </div>
            <div className="shrink-0 text-right">
              <p className="font-mono text-xs text-mut" title={fmtTimeET(a.at)}>
                {timeAgo(a.at)}
              </p>
            </div>
          </div>
        );
        return cand && onOpen ? (
          <button
            key={`${a.mint}-${a.at}-${i}`}
            className="block w-full text-left"
            onClick={() => onOpen(cand)}
          >
            {inner}
          </button>
        ) : (
          <div key={`${a.mint}-${a.at}-${i}`}>{inner}</div>
        );
      })}
    </div>
  );
}
