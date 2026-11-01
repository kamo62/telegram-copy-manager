export function formatLot(value: number | null | undefined, locale?: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(locale ?? undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatNumber(
  value: number | null | undefined,
  opts: Intl.NumberFormatOptions & { locale?: string } = {},
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const { locale, ...rest } = opts;
  return new Intl.NumberFormat(locale ?? undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    ...rest,
  }).format(value);
}

export function formatMoney(
  value: number | null | undefined,
  currency: string,
  locale?: string,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (!currency) return formatNumber(value, { locale });
  try {
    return new Intl.NumberFormat(locale ?? undefined, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
    }).format(value);
  } catch {
    return formatNumber(value, { locale });
  }
}

export function formatPercent(
  value: number | null | undefined,
  opts: { signDisplay?: "auto" | "always" | "exceptZero" | "never"; locale?: string } = {},
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const { signDisplay = "auto", locale } = opts;
  return new Intl.NumberFormat(locale ?? undefined, {
    style: "percent",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay,
  }).format(value / 100);
}

export function formatPips(value: number | null | undefined, locale?: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(locale ?? undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatDate(
  value: string | number | Date | null | undefined,
  opts: Intl.DateTimeFormatOptions & { locale?: string } = {},
): string {
  if (value === null || value === undefined) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  const { locale, ...rest } = opts;
  return new Intl.DateTimeFormat(locale ?? undefined, {
    dateStyle: "medium",
    ...rest,
  }).format(date);
}

export function formatDateTime(
  value: string | number | Date | null | undefined,
  opts: Intl.DateTimeFormatOptions & { locale?: string } = {},
): string {
  if (value === null || value === undefined) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  const { locale, ...rest } = opts;
  return new Intl.DateTimeFormat(locale ?? undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    ...rest,
  }).format(date);
}

export function formatRelativeTime(
  value: string | number | Date | null | undefined,
  locale?: string,
  now: Date = new Date(),
): string {
  if (value === null || value === undefined) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(seconds);
  const rtf = new Intl.RelativeTimeFormat(locale ?? undefined, { numeric: "auto" });
  if (abs < 60) return rtf.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return rtf.format(minutes, "minute");
  const hours = Math.round(seconds / 3600);
  if (Math.abs(hours) < 24) return rtf.format(hours, "hour");
  const days = Math.round(seconds / 86400);
  if (Math.abs(days) < 30) return rtf.format(days, "day");
  const months = Math.round(seconds / 2_592_000);
  if (Math.abs(months) < 12) return rtf.format(months, "month");
  const years = Math.round(seconds / 31_536_000);
  return rtf.format(years, "year");
}

const utcClockFormatter = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

export function formatUtcClock(date: Date = new Date()): string {
  return utcClockFormatter.format(date);
}
