import "../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import {
  DISMISSED_EXTERNAL_TRADES_STORAGE_KEY,
  externalTradeKey,
  readDismissedExternalTrades,
  writeDismissedExternalTrades,
} from "./dismissedExternalTrades";

afterEach(() => localStorage.clear());

describe("dismissed external trades", () => {
  test("persists account-scoped ticket keys in local storage", () => {
    const key = externalTradeKey("mt5-demo-1", "12345");
    writeDismissedExternalTrades(new Set([key]));

    expect(localStorage.getItem(DISMISSED_EXTERNAL_TRADES_STORAGE_KEY)).toContain(key);
    expect(readDismissedExternalTrades()).toEqual(new Set([key]));
  });

  test("ignores malformed storage without breaking the view", () => {
    localStorage.setItem(DISMISSED_EXTERNAL_TRADES_STORAGE_KEY, "not-json");

    expect(readDismissedExternalTrades()).toEqual(new Set());
  });
});
