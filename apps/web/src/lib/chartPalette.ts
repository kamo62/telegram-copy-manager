import type { DitherColor } from "../components/dither-kit/palette";

export const CHART_PALETTE: {
  growth: DitherColor;
  growthCss: string;
  drawdown: DitherColor;
  drawdownCss: string;
  categorical: readonly string[];
} = {
  growth: "blue",
  growthCss: "hsl(214 42% 45%)",
  drawdown: "red",
  drawdownCss: "var(--down-dim)",
  categorical: ["hsl(184 42% 37%)", "hsl(214 42% 45%)", "hsl(267 30% 49%)", "hsl(34 54% 42%)"],
};

export function chartCategory(index: number) {
  return (
    CHART_PALETTE.categorical[index % CHART_PALETTE.categorical.length] ??
    CHART_PALETTE.categorical[0]!
  );
}
