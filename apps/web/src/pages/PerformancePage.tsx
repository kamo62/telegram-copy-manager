import { GrowthChart, type GrowthSeries } from "../components/GrowthChart";

export function PerformancePage({
  data,
  loading = false,
}: {
  data: GrowthSeries;
  loading?: boolean;
}) {
  return (
    <div aria-labelledby="tab-performance" id="tabpanel-performance" role="tabpanel">
      <GrowthChart data={data} loading={loading} />
    </div>
  );
}
