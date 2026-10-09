"use client";

import type { IntelBase } from "@/lib/holder-intel";
import { fmtCount, fmtShare } from "@/lib/holder-intel";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Compact holder-intel line for scanner feed cards.
 * One mono line: top holder %, holder count, dev %, authority flags.
 * Unverifiable metrics render as "unavailable" (never a fake number);
 * a failed fetch renders nothing so the card never looks broken.
 */
export function HolderIntelRow({ intel }: { intel: IntelBase | undefined }) {
  if (intel === undefined) {
    return (
      <p className="truncate font-mono text-[10px] text-mut/40">
        holder intel…
      </p>
    );
  }
  if (!intel.ok) return null;

  const tip = [
    `Top holder: ${fmtShare(intel.topHolder?.pct)}${intel.topHolder?.kind === "program" ? " (program-owned account)" : ""}`,
    `Holders: ${fmtCount(intel.holders.count)}`,
    `Dev wallet: ${fmtShare(intel.dev?.pct)}${intel.devUnavailableReason ? ` (${intel.devUnavailableReason})` : ""}`,
    `Mint authority: ${intel.mintAuthorityRenounced ? "renounced" : intel.mintAuthority ? "set" : "unavailable"}`,
    `Freeze authority: ${intel.freezeAuthorityRenounced ? "renounced" : intel.freezeAuthority ? "set" : "unavailable"}`,
    `On-chain data from ${timeAgo(intel.fetchedAt)}`,
  ].join("\n");

  return (
    <p className="truncate font-mono text-[10px] text-mut" title={tip}>
      <span className="text-white/80">top {fmtShare(intel.topHolder?.pct)}</span>
      {" · "}
      {fmtCount(intel.holders.count)} holders
      {" · "}
      dev {fmtShare(intel.dev?.pct)}
      {intel.mintAuthorityRenounced === true && (
        <span className="text-up" title="Mint authority renounced — no new tokens can be minted">
          {" · "}mint🔒
        </span>
      )}
      {intel.mintAuthorityRenounced === false && (
        <span className={cn("text-down")} title="Mint authority is SET — new tokens can be minted">
          {" · "}mint⚠
        </span>
      )}
      {intel.freezeAuthorityRenounced === true && (
        <span className="text-up" title="Freeze authority renounced">
          {" · "}frz🔒
        </span>
      )}
      {intel.freezeAuthorityRenounced === false && (
        <span className={cn("text-down")} title="Freeze authority is SET — transfers can be frozen">
          {" · "}frz⚠
        </span>
      )}
    </p>
  );
}
