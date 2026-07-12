import type { DitherColor } from "../components/dither-kit/palette";

export const CHART_PALETTE: {
  growth: DitherColor;
  growthCss: string;
  drawdown: DitherColor;
  drawdownCss: string;
  neutral: DitherColor;
  neutralCss: string;
  categorical: readonly string[];
} = {
  growth: "blue",
  growthCss: "hsl(214 42% 45%)",
  drawdown: "red",
  drawdownCss: "var(--down-dim)",
  neutral: "grey",
  neutralCss: "var(--ink-3)",
  categorical: ["hsl(184 42% 37%)", "hsl(214 42% 45%)", "hsl(267 30% 49%)", "hsl(34 54% 42%)"],
};

export function chartDitherColor(colorAccents: boolean, tone: "growth" | "drawdown") {
  return colorAccents ? CHART_PALETTE[tone] : CHART_PALETTE.neutral;
}

export function chartSparklineColor(colorAccents: boolean, tone: "growth" | "drawdown") {
  return colorAccents ? CHART_PALETTE[`${tone}Css`] : CHART_PALETTE.neutralCss;
}

export function chartCategory(index: number) {
  return (
    CHART_PALETTE.categorical[index % CHART_PALETTE.categorical.length] ??
    CHART_PALETTE.categorical[0]!
  );
}
