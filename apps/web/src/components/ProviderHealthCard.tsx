import { useCallback, useEffect, useState } from "react";
import { apiDelete, apiGet } from "../lib/api";
import { Sparkline } from "./Sparkline";

export interface ProviderScore {
  tradeCount: number;
  sampleSize: number;
  winRate: number;
  wins: number;
  losses: number;
  streak: number;
  streakKind: "win" | "loss" | "none";
  avgPips: number;
  badge: "green" | "amber" | "red" | "neutral";
  learnedPatterns?: number;
}

const BADGE_LABEL: Record<ProviderScore["badge"], string> = {
  green: "Healthy",
  amber: "Watch",
  red: "At risk",
  neutral: "New",
};

/**
 * Compact provider quality card (Task 8). Self-loads from
 * /api/providers/:id/score; accepts an injectable `load` for testing.
 */
export function ProviderHealthCard({
  providerId,
  title,
  load,
  onReset,
}: {
  providerId: string;
  title: string;
  load?: (providerId: string) => Promise<ProviderScore | null>;
  onReset?: (providerId: string) => Promise<void>;
}) {
  const [score, setScore] = useState<ProviderScore | null>(null);

  const refresh = useCallback(() => {
    const loader = load ?? ((id: string) => apiGet<ProviderScore>(`/api/providers/${id}/score`));
    return Promise.resolve(loader(providerId))
      .then((data) => {
        if (data && typeof data.badge === "string") setScore(data);
      })
      .catch(() => {
        /* score is best-effort; leave card empty on failure */
      });
  }, [providerId, load]);

  useEffect(() => {
    let active = true;
    void refresh().finally(() => {
      if (!active) setScore(null);
    });
    return () => {
      active = false;
    };
  }, [refresh]);

  const resetLearning = useCallback(async () => {
    const reset = onReset ?? ((id: string) => apiDelete(`/api/providers/${id}/learning`).then());
    await reset(providerId);
    setScore((prev) => (prev ? { ...prev, learnedPatterns: 0 } : prev));
  }, [onReset, providerId]);

  const badge = score?.badge ?? "neutral";

  return (
    <div className={`provider-health-card provider-health-${badge}`}>
      <div className="provider-health-head">
        <span className="provider-health-title">{title}</span>
        <span className={`provider-health-badge provider-health-badge-${badge}`}>
          {BADGE_LABEL[badge]}
        </span>
      </div>
      <div className="provider-health-stats">
        <span className="provider-health-winrate">
          {score ? `${Math.round(score.winRate * 100)}%` : "—"} win
        </span>
        <span className="provider-health-sample">
          {score ? `${score.wins}/${score.sampleSize}` : "0/0"}
        </span>
        <span
          className={`provider-health-streak provider-health-streak-${score?.streakKind ?? "none"}`}
        >
          {score && score.streakKind !== "none"
            ? `${score.streakKind === "win" ? "W" : "L"}${score.streak}`
            : "—"}
        </span>
      </div>
      {score && score.sampleSize > 1 ? (
        <Sparkline
          ariaLabel="recent win/loss pattern"
          data={Array.from({ length: score.sampleSize }, (_, i) => (i < score.wins ? 1 : 0))}
        />
      ) : null}
      {score && (score.learnedPatterns ?? 0) > 0 ? (
        <div className="provider-health-learned-row">
          <span className="provider-health-learned">{score.learnedPatterns} learned patterns</span>
          <button
            className="btn btn-ghost btn-small btn-destructive-subtle"
            onClick={() => void resetLearning()}
            type="button"
          >
            Reset learning
          </button>
        </div>
      ) : null}
    </div>
  );
}
