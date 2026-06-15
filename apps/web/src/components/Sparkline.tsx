type SparklineProps = {
  data: number[];
  color?: string;
  height?: number;
  fill?: boolean;
  className?: string;
  ariaLabel?: string;
};

// Pure-SVG sparkline. ~30 lines, zero dependencies, accepts any numeric series
// and renders a line + faint area under it. Used in AccountHeader KPI cards
// to mimic the Codex LB trend strip without pulling in recharts.
export function Sparkline({
  data,
  color = "var(--accent)",
  height = 28,
  fill = true,
  className,
  ariaLabel,
}: SparklineProps) {
  if (data.length < 2) return null;
  const width = 100;
  const min = Math.min(...data);
  const max = Math.max(...data);
  // Flat series (e.g. brand-new account with one equity point repeated) would
  // otherwise stroke a horizontal line pinned to the bottom of the viewBox
  // and read as a decorative border rather than data — skip rendering so the
  // parent placeholder takes over.
  if (max === min) return null;
  const range = max - min;
  const points = data.map((value, index) => {
    const x = (index / (data.length - 1)) * width;
    // Pad 1px top and bottom so the stroke isn't clipped at extremes.
    const y = height - 1 - ((value - min) / range) * (height - 2);
    return { x, y };
  });
  const linePath = points
    .map(({ x, y }, index) => `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`)
    .join(" ");
  const areaPath = fill ? `${linePath} L${width.toFixed(2)},${height} L0,${height} Z` : null;
  const classes = ["sparkline"];
  if (className) classes.push(className);
  return (
    <svg
      aria-hidden={ariaLabel ? undefined : true}
      aria-label={ariaLabel}
      className={classes.join(" ")}
      height={height}
      preserveAspectRatio="none"
      role={ariaLabel ? "img" : undefined}
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
    >
      {areaPath ? <path d={areaPath} fill={color} opacity="0.12" /> : null}
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}
