"use client";

/**
 * Filter + sort bar for the Lamport Terminal token feed.
 *
 * Pure client-side: the feed data is already loaded, so every control
 * applies instantly via the parent's useMemo. Filter/sort state persists
 * in localStorage. No backend involvement.
 */

export type SortKey =
  | "token"
  | "price"
  | "mcap"
  | "liq"
  | "vol"
  | "gates"
  | "seen"
  | "change";

export interface FeedFilterState {
  mcapMin: string;
  mcapMax: string;
  liqMin: string;
  volMin: string;
  ageMaxHrs: string;
  /** 0 = any, otherwise minimum gates passed (7, 8, or 9). */
  minGates: number;
  whaleOnly: boolean;
  hasImage: boolean;
}

export const DEFAULT_FILTERS: FeedFilterState = {
  mcapMin: "10000",
  mcapMax: "",
  liqMin: "",
  volMin: "",
  ageMaxHrs: "",
  minGates: 0,
  whaleOnly: false,
  hasImage: false,
};

export const DEFAULT_SORT: SortKey = "seen";
export const DEFAULT_DIR: 1 | -1 = -1;

export interface SortOptionDef {
  value: string;
  label: string;
  sort: SortKey;
  dir: 1 | -1;
}

export const SORT_OPTIONS: SortOptionDef[] = [
  { value: "default", label: "Default order", sort: "seen", dir: -1 },
  { value: "mcap_desc", label: "Market cap · high to low", sort: "mcap", dir: -1 },
  { value: "mcap_asc", label: "Market cap · low to high", sort: "mcap", dir: 1 },
  { value: "vol_desc", label: "Volume · high to low", sort: "vol", dir: -1 },
  { value: "vol_asc", label: "Volume · low to high", sort: "vol", dir: 1 },
  { value: "liq_desc", label: "Liquidity · high to low", sort: "liq", dir: -1 },
  { value: "liq_asc", label: "Liquidity · low to high", sort: "liq", dir: 1 },
  { value: "change_desc", label: "Price change · high to low", sort: "change", dir: -1 },
  { value: "change_asc", label: "Price change · low to high", sort: "change", dir: 1 },
  { value: "gates_desc", label: "Gates passed · high to low", sort: "gates", dir: -1 },
  { value: "gates_asc", label: "Gates passed · low to high", sort: "gates", dir: 1 },
  { value: "seen_desc", label: "Newest first", sort: "seen", dir: -1 },
  { value: "seen_asc", label: "Oldest first", sort: "seen", dir: 1 },
  { value: "price_desc", label: "Price · high to low", sort: "price", dir: -1 },
  { value: "price_asc", label: "Price · low to high", sort: "price", dir: 1 },
  { value: "token_asc", label: "Token · A to Z", sort: "token", dir: 1 },
  { value: "token_desc", label: "Token · Z to A", sort: "token", dir: -1 },
];

/** Map the current sort/dir state to the dropdown value (stays in sync with column headers). */
export function sortToOptionValue(sort: SortKey, dir: 1 | -1): string {
  if (sort === "seen" && dir === -1) return "default";
  const hit = SORT_OPTIONS.find(
    (o) => o.value !== "default" && o.sort === sort && o.dir === dir
  );
  return hit ? hit.value : "default";
}

/** Parse "50k", "1.5m", "2b" or plain numbers into USD. Null = empty/invalid. */
export function parseUsd(s: string): number | null {
  const t = s.trim().toLowerCase().replace(/[$,]/g, "");
  if (!t) return null;
  const m = t.match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : m[2] === "b" ? 1e9 : 1;
  return n * mult;
}

/** Parse a plain number (age in hours). Null = empty/invalid. */
export function parseNum(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** How many filter criteria are currently active (for the badge). */
export function activeFilterCount(f: FeedFilterState): number {
  let n = 0;
  if (parseUsd(f.mcapMin) !== null) n++;
  if (parseUsd(f.mcapMax) !== null) n++;
  if (parseUsd(f.liqMin) !== null) n++;
  if (parseUsd(f.volMin) !== null) n++;
  if (parseNum(f.ageMaxHrs) !== null) n++;
  if (f.minGates > 0) n++;
  if (f.whaleOnly) n++;
  if (f.hasImage) n++;
  return n;
}

const inputCls =
  "w-20 rounded border border-line bg-raised px-2 py-1 font-mono text-xs text-white placeholder:text-mut/40 focus:border-gold/60 focus:outline-none";
const labelCls =
  "mb-1 block font-mono text-[10px] uppercase tracking-wider text-mut";

function NumField({
  label,
  value,
  onChange,
  placeholder,
  wide,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  wide?: boolean;
}) {
  return (
    <label className="block">
      <span className={labelCls}>{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        className={wide ? inputCls + " w-24" : inputCls}
      />
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  loading,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2 rounded border border-line bg-raised px-2.5 py-1.5 transition-colors hover:border-gold/40"
    >
      <span
        className={
          "relative h-4 w-7 shrink-0 rounded-full transition-colors " +
          (checked ? "bg-gold" : "bg-line")
        }
      >
        <span
          className={
            "absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all " +
            (checked ? "left-3.5" : "left-0.5")
          }
        />
      </span>
      <span className="font-mono text-[11px] text-white">
        {label}
        {loading && <span className="ml-1 text-gold">…</span>}
      </span>
    </button>
  );
}

const GATE_PRESETS: { label: string; value: number }[] = [
  { label: "Any", value: 0 },
  { label: "7+", value: 7 },
  { label: "8+", value: 8 },
  { value: 9, label: "9/9" },
];

export function FilterBar({
  filters,
  onFilters,
  sort,
  dir,
  onSort,
  shown,
  total,
  whaleLoading,
  whaleDormant,
  collapsed,
  onToggleCollapsed,
}: {
  filters: FeedFilterState;
  onFilters: (f: FeedFilterState) => void;
  sort: SortKey;
  dir: 1 | -1;
  onSort: (sort: SortKey, dir: 1 | -1) => void;
  shown: number;
  total: number;
  whaleLoading: boolean;
  whaleDormant: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const set = (patch: Partial<FeedFilterState>) =>
    onFilters({ ...filters, ...patch });
  const active = activeFilterCount(filters);
  const sortValue = sortToOptionValue(sort, dir);

  return (
    <div className="rounded-lg border border-line bg-surface">
      {/* header row: always visible */}
      <div className="flex items-center gap-3 px-3 py-2">
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="flex items-center gap-2"
          aria-expanded={!collapsed}
        >
          <span className="font-mono text-[11px] uppercase tracking-widest text-gold">
            Filters
          </span>
          {active > 0 && (
            <span className="rounded-full bg-gold px-1.5 py-px font-mono text-[10px] font-bold text-black">
              {active}
            </span>
          )}
          <span className="font-mono text-[10px] text-mut">
            {collapsed ? "▸" : "▾"}
          </span>
        </button>
        <span className="ml-auto font-mono text-[11px] text-mut tabular-nums">
          <span className="text-white">{shown}</span> of {total} tokens
        </span>
        <button
          type="button"
          onClick={() => onFilters({ ...DEFAULT_FILTERS })}
          disabled={active === 0}
          className="rounded border border-line px-2 py-1 font-mono text-[11px] text-mut transition-colors hover:border-gold/50 hover:text-gold disabled:cursor-default disabled:opacity-30 disabled:hover:border-line disabled:hover:text-mut"
        >
          Reset
        </button>
      </div>

      {!collapsed && (
        <div className="border-t border-line/60 px-3 py-2.5">
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
            <div className="flex items-end gap-1.5">
              <NumField
                label="MCap min $"
                value={filters.mcapMin}
                onChange={(v) => set({ mcapMin: v })}
                placeholder="50k"
                wide
              />
              <span className="pb-1 font-mono text-xs text-mut">–</span>
              <NumField
                label="MCap max $"
                value={filters.mcapMax}
                onChange={(v) => set({ mcapMax: v })}
                placeholder="1m"
                wide
              />
            </div>
            <NumField
              label="Liq min $"
              value={filters.liqMin}
              onChange={(v) => set({ liqMin: v })}
              placeholder="10k"
              wide
            />
            <NumField
              label="Vol min $"
              value={filters.volMin}
              onChange={(v) => set({ volMin: v })}
              placeholder="25k"
              wide
            />
            <NumField
              label="Age max (hrs)"
              value={filters.ageMaxHrs}
              onChange={(v) => set({ ageMaxHrs: v })}
              placeholder="24"
            />

            <div>
              <span className={labelCls}>Gates passed</span>
              <div className="flex overflow-hidden rounded border border-line">
                {GATE_PRESETS.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => set({ minGates: p.value })}
                    className={
                      "px-2.5 py-1 font-mono text-xs transition-colors " +
                      (filters.minGates === p.value
                        ? "bg-gold font-bold text-black"
                        : "bg-raised text-mut hover:text-white")
                    }
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span className={labelCls}>Flags</span>
              <div className="flex flex-wrap gap-2">
                <Toggle
                  label="Whale buys"
                  checked={filters.whaleOnly}
                  onChange={(v) => set({ whaleOnly: v })}
                  loading={whaleLoading}
                />
                <Toggle
                  label="Has image"
                  checked={filters.hasImage}
                  onChange={(v) => set({ hasImage: v })}
                />
              </div>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-line/60 pt-2.5">
            <label className="flex items-center gap-2">
              <span className={labelCls + " !mb-0"}>Sort</span>
              <select
                value={sortValue}
                onChange={(e) => {
                  const opt = SORT_OPTIONS.find((o) => o.value === e.target.value);
                  if (opt) onSort(opt.sort, opt.dir);
                }}
                className="rounded border border-line bg-raised px-2 py-1.5 font-mono text-xs text-white focus:border-gold/60 focus:outline-none"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value} className="bg-raised">
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            {whaleDormant && filters.whaleOnly && (
              <span className="font-mono text-[10px] text-mut/70">
                whale tracking dormant — no tracked wallets yet
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
