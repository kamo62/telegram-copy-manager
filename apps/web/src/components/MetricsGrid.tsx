import type { LucideIcon } from "lucide-react";

export function MetricsGrid({
  loading,
  metrics,
}: {
  loading: boolean;
  metrics: Array<{
    label: string;
    value: number;
    detail: string;
    icon: LucideIcon;
  }>;
}) {
  return (
    <section className="metrics-grid" aria-label="Operational summary">
      {metrics.map((metric) => (
        <article className="metric-card" key={metric.label}>
          <metric.icon size={18} aria-hidden="true" />
          <div>
            <span>{metric.label}</span>
            <strong>{loading ? <span className="metric-loading" /> : metric.value}</strong>
            <small>{metric.detail}</small>
          </div>
        </article>
      ))}
    </section>
  );
}
