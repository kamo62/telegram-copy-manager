import { formatMoney } from "../lib/format";

export type MoneyProps = {
  value: number | null | undefined;
  currency?: string;
  locale?: string;
  signTone?: boolean;
  warnAbove?: number;
  dangerAbove?: number;
  align?: "right" | "left";
  className?: string;
};

function resolveTone(
  value: number | null | undefined,
  { signTone, warnAbove, dangerAbove }: Pick<MoneyProps, "signTone" | "warnAbove" | "dangerAbove">,
): "up" | "down" | "warn" | "danger" | "muted" | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return "muted";
  const abs = Math.abs(value);
  if (dangerAbove !== undefined && abs >= dangerAbove) return "danger";
  if (warnAbove !== undefined && abs >= warnAbove) return "warn";
  if (signTone) {
    if (value > 0) return "up";
    if (value < 0) return "down";
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
  className,
}: MoneyProps) {
  const tone = resolveTone(value, { signTone, warnAbove, dangerAbove });
  const classes = ["money"];
  if (tone) classes.push(`money-${tone}`);
  if (className) classes.push(className);
  const style = align === "left" ? undefined : { textAlign: "right" as const };
  return (
    <span className={classes.join(" ")} style={style}>
      {formatMoney(value, currency ?? "USD", locale)}
    </span>
  );
}
