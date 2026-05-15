import { describe, expect, test } from "bun:test";
import {
  formatDate,
  formatDateTime,
  formatLot,
  formatMoney,
  formatNumber,
  formatPercent,
  formatPips,
  formatRelativeTime,
  formatUtcClock,
} from "./format";

describe("format", () => {
  test("formatLot always uses dot separator regardless of locale", () => {
    expect(formatLot(0.2)).toBe("0.20");
    expect(formatLot(1.234)).toBe("1.23");
    expect(formatLot(null)).toBe("—");
    expect(formatLot(Number.NaN)).toBe("—");
  });

  test("formatNumber respects locale grouping conventions", () => {
    expect(formatNumber(1234.5, { locale: "en-US" })).toBe("1,234.50");
    expect(formatNumber(1234.5, { locale: "de-DE" })).toContain("1.234");
    expect(formatNumber(null)).toBe("—");
  });

  test("formatMoney emits a currency symbol matching the locale", () => {
    const usd = formatMoney(1234.5, "USD", "en-US");
    expect(usd).toContain("1,234.50");
    expect(usd).toMatch(/\$/);
    const eur = formatMoney(1234.5, "EUR", "de-DE");
    expect(eur).toContain("1.234,50");
  });

  test("formatPercent divides input by 100 and respects sign options", () => {
    expect(formatPercent(12.5, { locale: "en-US" })).toContain("12.50%");
    expect(formatPercent(0, { locale: "en-US", signDisplay: "always" })).toContain("+");
    expect(formatPercent(null)).toBe("—");
  });

  test("formatPips trims unnecessary decimals", () => {
    expect(formatPips(50, "en-US")).toBe("50");
    expect(formatPips(12.5, "en-US")).toBe("12.5");
    expect(formatPips(null)).toBe("—");
  });

  test("formatDate / formatDateTime accept ISO strings and Date instances", () => {
    const iso = "2026-05-09T12:00:00.000Z";
    const usDate = formatDate(iso, { locale: "en-US" });
    expect(usDate).toContain("2026");
    const usDateTime = formatDateTime(iso, { locale: "en-US" });
    expect(usDateTime).toContain("2026");
    expect(formatDate("not-a-date")).toBe("—");
  });

  test("formatRelativeTime returns human descriptions", () => {
    const now = new Date("2026-05-15T12:00:00Z");
    expect(formatRelativeTime(new Date("2026-05-15T11:55:00Z"), "en-US", now)).toContain("minute");
    expect(formatRelativeTime(new Date("2026-05-14T12:00:00Z"), "en-US", now)).toContain("day");
    expect(formatRelativeTime(null)).toBe("—");
  });

  test("formatUtcClock always shows UTC time in HH:MM:SS", () => {
    const date = new Date("2026-05-15T08:09:10Z");
    expect(formatUtcClock(date)).toBe("08:09:10");
  });
});
