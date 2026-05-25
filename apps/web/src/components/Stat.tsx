import { formatMoney, formatNumber, formatPercent } from "../lib/format";

export type StatUnit = "money" | "percent" | "ratio" | "count" | "duration-min" | "raw";
export type StatTone = "up" | "down" | "warn" | "danger" | "muted" | "neutral";

export type StatProps = {
  value: number | null | undefined;
  unit: StatUnit;
  currency?: string;
  locale?: string;
  signTone?: boolean;
  warnAbove?: number;
  dangerAbove?: number;
  upWhenAtLeast?: number;
  tone?: StatTone;
  pair?: { value: number | null | undefined; unit: "percent" | "money" };
  suffix?: string;
  align?: "right" | "left";
  className?: string;
};

function formatPrimary(
  value: number | null | undefined,
  unit: StatUnit,
  currency: string | undefined,
  locale: string | undefined,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  switch (unit) {
    case "money":
      return formatMoney(value, currency ?? "USD", locale);
    case "percent":
      return formatPercent(value, { locale });
    case "ratio":
      return `${formatNumber(value, { locale })}x`;
    case "count":
      return formatNumber(value, { locale, maximumFractionDigits: 0, minimumFractionDigits: 0 });
    case "duration-min":
      return `${formatNumber(value, { locale })} min`;
    default:
      return formatNumber(value, { locale });
  }
}

function formatPaired(
  paired: { value: number | null | undefined; unit: "percent" | "money" },
  currency: string | undefined,
  locale: string | undefined,
): string | null {
  if (paired.value === null || paired.value === undefined || !Number.isFinite(paired.value)) {
    return null;
  }
  if (paired.unit === "percent") return formatPercent(paired.value, { locale });
  return formatMoney(paired.value, currency ?? "USD", locale);
}

function resolveTone(
  value: number | null | undefined,
  pairValue: number | null | undefined,
  pairUnit: "percent" | "money" | undefined,
  props: Pick<
    StatProps,
    "signTone" | "warnAbove" | "dangerAbove" | "upWhenAtLeast" | "tone" | "unit"
  >,
): StatTone | null {
  if (props.tone && props.tone !== "neutral") return props.tone;
  if (value === null || value === undefined || !Number.isFinite(value)) return "muted";

  // For paired drawdown rows, the threshold applies to the percent counterpart.
  const compareValue =
    pairUnit === "percent" &&
    pairValue !== null &&
    pairValue !== undefined &&
    Number.isFinite(pairValue)
      ? pairValue
      : props.unit === "percent"
        ? value
        : value;
  const abs = Math.abs(compareValue);

  if (props.dangerAbove !== undefined && abs >= props.dangerAbove) return "danger";
  if (props.warnAbove !== undefined && abs >= props.warnAbove) return "warn";
  if (props.upWhenAtLeast !== undefined && value >= props.upWhenAtLeast) return "up";
  if (props.signTone) {
    if (value > 0) return "up";
    if (value < 0) return "down";
  }
  return null;
}

export function Stat({
  value,
  unit,
  currency,
  locale,
  signTone = false,
  warnAbove,
  dangerAbove,
  upWhenAtLeast,
  tone,
  pair,
  suffix,
  align = "right",
  className,
}: StatProps) {
  const pairText = pair ? formatPaired(pair, currency, locale) : null;
  const resolvedTone = resolveTone(value, pair?.value, pair?.unit, {
    signTone,
    warnAbove,
    dangerAbove,
    upWhenAtLeast,
    tone,
    unit,
  });
  const classes = ["money"];
  if (resolvedTone) classes.push(`money-${resolvedTone}`);
  if (className) classes.push(className);
  const style = align === "left" ? undefined : { textAlign: "right" as const };
  const primary = formatPrimary(value, unit, currency, locale);
  return (
    <span className={classes.join(" ")} style={style}>
      {primary}
      {suffix ? <span className="money-pair">{suffix}</span> : null}
      {pairText ? <span className="money-pair">({pairText})</span> : null}
    </span>
  );
}
