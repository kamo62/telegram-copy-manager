export interface ExposurePosition {
  symbol: string;
  volume: number;
  openPrice?: number;
  sl?: number;
}

export interface ExposureBySymbol {
  symbol: string;
  lots: number;
  /** Volume-weighted average stop distance in pips (0 when no SL/metadata). */
  riskPips: number;
  /** Σ(stop distance in pips × volume) — a comparable risk magnitude. */
  riskPipLots: number;
}

export interface ExposureResult {
  totalLots: number;
  bySymbol: ExposureBySymbol[];
}

/**
 * Aggregate open exposure from broker positions. Monetary % of equity needs the
 * broker's per-symbol tick value, which the EA snapshot does not send, so this
 * reports lots and pip-based risk (display-only).
 * ponytail: pip-lots is a relative risk magnitude, not currency. Upgrade path is
 * a tickValue field on the EA snapshot to convert to account-currency risk.
 */
export function computeExposure(
  positions: ExposurePosition[],
  pipSizeFor: (symbol: string) => number,
): ExposureResult {
  const map = new Map<string, { lots: number; riskPipLots: number }>();
  let totalLots = 0;
  for (const position of positions) {
    const lots = Number(position.volume) || 0;
    if (lots <= 0) continue;
    totalLots += lots;
    const pip = pipSizeFor(position.symbol) || 0;
    const distance =
      position.openPrice !== undefined && position.sl !== undefined && position.sl > 0
        ? Math.abs(position.openPrice - position.sl)
        : 0;
    const riskPips = pip > 0 ? distance / pip : 0;
    const entry = map.get(position.symbol) ?? { lots: 0, riskPipLots: 0 };
    entry.lots += lots;
    entry.riskPipLots += riskPips * lots;
    map.set(position.symbol, entry);
  }
  const bySymbol = [...map.entries()]
    .map(([symbol, value]) => ({
      symbol,
      lots: Number(value.lots.toFixed(2)),
      riskPips: value.lots > 0 ? Number((value.riskPipLots / value.lots).toFixed(1)) : 0,
      riskPipLots: Number(value.riskPipLots.toFixed(1)),
    }))
    .sort((a, b) => b.lots - a.lots);
  return { totalLots: Number(totalLots.toFixed(2)), bySymbol };
}

/** Best-effort pip size when broker metadata is unavailable. */
export function fallbackPipSize(symbol: string): number {
  const upper = symbol.toUpperCase();
  if (upper.includes("XAU") || upper.includes("GOLD")) return 0.1;
  if (upper.includes("JPY")) return 0.01;
  if (upper.includes("BTC") || upper.includes("US30") || upper.includes("NAS")) return 1;
  return 0.0001;
}
