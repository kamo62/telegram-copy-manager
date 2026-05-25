// Win-rate tone helper used by ProvidersTable. Drawdown warn/danger
// thresholds are configurable per-account (see appSettings.drawdownWarnPct /
// drawdownDangerPct and PATCH /api/accounts/:id/risk-thresholds) and arrive
// pre-resolved on the stats payload, so no constant lives here.
export function winRateTone(winRate: number | null | undefined): "up" | "down" | null {
  if (winRate === null || winRate === undefined || !Number.isFinite(winRate)) return null;
  if (winRate > 0.5) return "up";
  if (winRate < 0.5) return "down";
  return null;
}
