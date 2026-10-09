/**
 * Real token lifecycle status for the Trenches columns.
 *
 * CRITICAL: columns are assigned ONLY from on-chain / market lifecycle
 * signals, never from Nines gate scores. Gate completion is a separate
 * concern shown as a badge on each card and in The Nines watch view.
 *
 * Lifecycle model (pump.fun):
 *  - new:      token is live on its bonding curve, early in its run.
 *  - final:    bonding curve nearly complete (approaching graduation).
 *  - migrated: curve completed (on-chain `complete` flag) or the deepest
 *              liquidity now sits on a real DEX (Raydium etc.).
 *  - unknown:  we could not determine lifecycle; the card renders without
 *              a stage column rather than guessing.
 */

export type LifecycleStage = "new" | "final" | "migrated" | "unknown";

export interface LifecycleInfo {
  stage: LifecycleStage;
  /** 0..1 bonding-curve progress when known, null otherwise. */
  curveProgress: number | null;
  /** DEX id of the deepest pair when known (e.g. "raydium", "pump"). */
  dexId: string | null;
}

const DEX_IDS = new Set([
  "raydium",
  "meteora",
  "meteora-dlmm",
  "orca",
  "lifinity",
  "phoenix",
  "openbook",
]);

const PUMP_IDS = new Set(["pump", "pumpswap"]);

/**
 * Pure lifecycle classification from already-fetched signals.
 * curveProgress: 0..1 from the bonding-curve account (null when unreadable).
 * dexId: deepest-pair DEX id from DexScreener (null when unknown).
 */
export function classifyLifecycle(
  curveProgress: number | null,
  curveComplete: boolean | null,
  dexId: string | null
): LifecycleInfo {
  const dex = dexId?.toLowerCase() ?? null;

  // Definitive migration signals first.
  if (curveComplete === true) {
    return { stage: "migrated", curveProgress: 1, dexId: dex };
  }
  if (dex && DEX_IDS.has(dex)) {
    return { stage: "migrated", curveProgress: curveProgress, dexId: dex };
  }

  // Still on the bonding curve: new vs final stretch by real progress.
  if (curveProgress !== null && curveProgress >= 0) {
    const p = Math.min(1, Math.max(0, curveProgress));
    if (p >= 0.75) {
      return { stage: "final", curveProgress: p, dexId: dex };
    }
    return { stage: "new", curveProgress: p, dexId: dex };
  }

  // On pump with no readable curve: honest unknown, not a guess.
  if (dex && PUMP_IDS.has(dex)) {
    return { stage: "unknown", curveProgress: null, dexId: dex };
  }

  return { stage: "unknown", curveProgress: null, dexId: dex };
}

export const STAGE_LABEL: Record<LifecycleStage, string> = {
  new: "New Pairs",
  final: "Final Stretch",
  migrated: "Migrated",
  unknown: "Unstaged",
};
