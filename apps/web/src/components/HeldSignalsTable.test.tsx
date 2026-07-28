import "../test-setup";
import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { HeldSignalsTable } from "./HeldSignalsTable";

describe("HeldSignalsTable", () => {
  test("shows newest held signals first and distinguishes zero dropped commands", () => {
    const now = Date.now();
    const view = render(
      <HeldSignalsTable
        accountLabel={() => "FTMO"}
        items={[
          {
            accountId: "account-1",
            commandType: "OPEN_TRADE",
            createdAt: new Date(now - 48 * 60 * 60 * 1_000).toISOString(),
            currentPrice: null,
            driftPct: null,
            droppedLifecycle: [],
            droppedLifecycleCount: 0,
            heldReason: "SYMBOL_MAPPING_UNMAPPED",
            id: "older",
            originalEntry: null,
            providerId: "provider-1",
            symbol: "XAUUSD",
          },
          {
            accountId: "account-1",
            commandType: "OPEN_TRADE",
            createdAt: new Date(now - 60_000).toISOString(),
            currentPrice: null,
            driftPct: null,
            droppedLifecycle: [],
            droppedLifecycleCount: 2,
            heldReason: "EA_OFFLINE",
            id: "newer",
            originalEntry: null,
            providerId: "provider-1",
            symbol: "EURUSD",
          },
        ]}
        onDismiss={() => {}}
        onRequeue={() => {}}
        providerLabel={() => "VIP Gold"}
      />,
    );

    expect([...view.container.querySelectorAll("tbody tr")].map((row) => row.textContent)).toEqual([
      expect.stringContaining("EURUSD"),
      expect.stringContaining("XAUUSD"),
    ]);
    expect(
      view.getByTitle("No lifecycle commands were dropped while this signal was held"),
    ).toBeTruthy();
    expect(view.container.querySelector(".held-row-stale")).not.toBeNull();
  });
});
