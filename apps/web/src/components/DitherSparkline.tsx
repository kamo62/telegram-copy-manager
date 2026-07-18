import { useMemo } from "react";
import { Area } from "@/components/dither-kit/area";
import { AreaChart } from "@/components/dither-kit/area-chart";
import { useColorAccents } from "../contexts/ColorAccentsContext";
import { chartDitherColor } from "../lib/chartPalette";

type DitherSparklineProps = {
  data: number[];
  tone: "growth" | "drawdown";
  ariaLabel: string;
  height?: number;
};

/** A non-interactive, canvas-dithered area strip for prominent trends. */
export function DitherSparkline({ data, tone, ariaLabel, height = 72 }: DitherSparklineProps) {
  const { colorAccents } = useColorAccents();
  const rows = useMemo(() => data.map((value, index) => ({ index, value })), [data]);

  return (
    <div
      aria-label={ariaLabel}
      className="dither-sparkline"
      data-color-accents={colorAccents ? "on" : "off"}
      role="img"
      style={{ height }}
    >
      <AreaChart
        animate={false}
        ariaLabel={ariaLabel}
        className="h-full"
        config={{
          value: {
            label: ariaLabel,
            color: chartDitherColor(colorAccents, tone),
          },
        }}
        data={rows}
        interactive={false}
        margins={{ bottom: 2, left: 2, right: 2, top: 2 }}
      >
        <Area dataKey="value" variant="gradient" />
      </AreaChart>
    </div>
  );
}
