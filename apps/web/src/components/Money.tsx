import { formatMoney } from "../lib/format";

export type MoneyProps = {
  value: number | null | undefined;
  currency?: string;
  locale?: string;
  signTone?: boolean;
  warnAbove?: number;
  dangerAbove?: number;
  align?: "right" | "left";
  /** Render the bare number without the currency symbol (use when the currency
   * is already shown elsewhere, e.g. a "· ZAR" label). Default true. */
  symbol?: boolean;
  className?: string;
};

export function numericSignTone(value: number | null | undefined): "up" | "down" | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) return null;
  return value > 0 ? "up" : "down";
}

function resolveTone(
  value: number | null | undefined,
  { signTone, warnAbove, dangerAbove }: Pick<MoneyProps, "signTone" | "warnAbove" | "dangerAbove">,
): "up" | "down" | "warn" | "danger" | "muted" | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return "muted";
  const abs = Math.abs(value);
  if (dangerAbove !== undefined && abs >= dangerAbove) return "danger";
  if (warnAbove !== undefined && abs >= warnAbove) return "warn";
  if (signTone) {
    return numericSignTone(value);
  }
  return null;
}

export function Money({
  value,
  currency,
  locale,
  signTone = false,
  warnAbove,
  dangerAbove,
  align = "right",
  symbol = true,
  className,
}: MoneyProps) {
  const tone = resolveTone(value, { signTone, warnAbove, dangerAbove });
  const classes = ["money"];
  if (tone) classes.push(`money-${tone}`);
  if (className) classes.push(className);
  const style = align === "left" ? undefined : { textAlign: "right" as const };
  const text =
    symbol || value === null || value === undefined || !Number.isFinite(value)
      ? formatMoney(value, currency ?? "USD", locale)
      : new Intl.NumberFormat(locale ?? undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(value);
  return (
    <span className={classes.join(" ")} style={style}>
      {text}
    </span>
  );
}
