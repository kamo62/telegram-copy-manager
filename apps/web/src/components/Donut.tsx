import type { ReactNode } from "react";

export type DonutSlice = {
  id: string;
  label: string;
  value: number;
  color: string;
};

type DonutProps = {
  slices: DonutSlice[];
  centerLabel?: string;
  centerValue?: ReactNode;
  size?: number;
  thickness?: number;
  ariaLabel?: string;
};

// Pure-SVG donut. Each slice is one <circle> with stroke-dasharray sized
// to its share of the total; we walk the slices and shift dashoffset so
// they sit head-to-tail around the ring. Cheaper than pulling in recharts
// just for a single segmented ring on AccountsOverview.
export function Donut({
  slices,
  centerLabel,
  centerValue,
  size = 96,
  thickness = 14,
  ariaLabel,
}: DonutProps) {
  const total = slices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const cx = size / 2;
  const cy = size / 2;
  let offset = 0;
  return (
    <div className="donut-wrap">
      <svg
        aria-hidden={ariaLabel ? undefined : true}
        aria-label={ariaLabel}
        className="donut"
        height={size}
        role={ariaLabel ? "img" : undefined}
        viewBox={`0 0 ${size} ${size}`}
        width={size}
      >
        <circle
          cx={cx}
          cy={cy}
          r={radius}
          fill="none"
          stroke="var(--panel-2)"
          strokeWidth={thickness}
        />
        {total > 0
          ? slices.map((slice) => {
              const fraction = Math.max(0, slice.value) / total;
              const length = fraction * circumference;
              const dasharray = `${length} ${circumference - length}`;
              const circle = (
                <circle
                  cx={cx}
                  cy={cy}
                  fill="none"
                  key={slice.id}
                  r={radius}
                  stroke={slice.color}
                  strokeDasharray={dasharray}
                  strokeDashoffset={-offset}
                  strokeWidth={thickness}
                  transform={`rotate(-90 ${cx} ${cy})`}
                />
              );
              offset += length;
              return circle;
            })
          : null}
      </svg>
      {centerLabel || centerValue ? (
        <div className="donut-center" aria-hidden="true">
          {centerLabel ? <span className="donut-center-label">{centerLabel}</span> : null}
          {centerValue ? <span className="donut-center-value">{centerValue}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

type DonutLegendProps = {
  slices: DonutSlice[];
  renderValue?: (slice: DonutSlice) => ReactNode;
};

// Sits beside the donut. Each row: coloured dot · label · right-aligned value.
// Render-value lets the consumer format (e.g. <Money>) without coupling the
// donut to currency rendering.
export function DonutLegend({ slices, renderValue }: DonutLegendProps) {
  return (
    <ul className="donut-legend">
      {slices.map((slice) => (
        <li className="donut-legend-row" key={slice.id}>
          <span
            aria-hidden="true"
            className="donut-legend-dot"
            style={{ backgroundColor: slice.color }}
          />
          <span className="donut-legend-label">{slice.label}</span>
          <span className="donut-legend-value">
            {renderValue ? renderValue(slice) : slice.value.toLocaleString()}
          </span>
        </li>
      ))}
    </ul>
  );
}
