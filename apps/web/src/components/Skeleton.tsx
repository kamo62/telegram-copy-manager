export function SkeletonLine({ width = "100%", height = 12 }: { width?: string; height?: number }) {
  return <span className="skeleton" style={{ width, height }} />;
}

export function SkeletonStat() {
  return (
    <div className="skeleton-stat">
      <SkeletonLine width="72px" height={10} />
      <SkeletonLine width="108px" height={24} />
      <SkeletonLine width="52px" height={14} />
    </div>
  );
}

export function SkeletonChart({ height = 320 }: { height?: number }) {
  return <div className="skeleton skeleton-chart" style={{ height }} />;
}

export function SkeletonRow({ columns = 4 }: { columns?: number }) {
  return (
    <tr className="skeleton-row">
      {Array.from({ length: columns }, (_item, index) => (
        <td key={index}>
          <SkeletonLine width={index === 0 ? "140px" : "64px"} height={12} />
        </td>
      ))}
    </tr>
  );
}
