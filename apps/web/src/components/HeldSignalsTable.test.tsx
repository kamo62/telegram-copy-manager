import "../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { HeldSignalsTable } from "./HeldSignalsTable";

afterEach(() => cleanup());

describe("HeldSignalsTable", () => {
  test("shows newest held signals first and distinguishes zero dropped commands", () => {
    const now = Date.now();
    const view = render(
      <HeldSignalsTable
        accountLabel={() => "FTMO"}
        items={[
          {
            accountId: "account-1",
            actionable: true,
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
            actionable: true,
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
        onDismissAll={() => {}}
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

  test("marks duplicate rows as suppressed and offers dismissal without release actions", () => {
    const view = render(
      <HeldSignalsTable
        accountLabel={() => "HF"}
        items={[
          {
            accountId: "account-1",
            actionable: false,
            commandType: "OPEN_TRADE",
            createdAt: new Date().toISOString(),
            currentPrice: null,
            driftPct: null,
            droppedLifecycle: [],
            droppedLifecycleCount: 0,
            heldReason: "DUPLICATE_OPEN_SIGNAL",
            id: "duplicate",
            originalEntry: 4016,
            providerId: "provider-1",
            symbol: "XAUUSD",
          },
        ]}
        onDismiss={() => {}}
        onDismissAll={() => {}}
        onRequeue={() => {}}
        providerLabel={() => "KAL VIP"}
      />,
    );

    const table = within(view.container);
    expect(table.getByText("Suppressed")).toBeTruthy();
    expect(table.getByText("Duplicate open signal")).toBeTruthy();
    expect(table.queryByText("Market")).toBeNull();
    expect(table.queryByText("Original")).toBeNull();
    expect(table.getByTitle("Dismiss suppressed signal")).toBeTruthy();
  });

  test("reveals lifecycle release actions only after an active trade is selected", () => {
    const view = render(
      <HeldSignalsTable
        accountLabel={() => "FTMO"}
        items={[
          {
            accountId: "account-1",
            actionable: true,
            candidateLogicalTradeIds: ["trade-1"],
            commandType: "CLOSE_TRADE",
            createdAt: new Date().toISOString(),
            currentPrice: 4017,
            driftPct: null,
            droppedLifecycle: [],
            droppedLifecycleCount: 0,
            heldReason: "EVIDENCE_LIFECYCLE_RESOLUTION_REQUIRED",
            id: "held-close",
            originalEntry: null,
            providerId: "provider-1",
            symbol: "XAUUSD",
          },
        ]}
        onDismiss={() => {}}
        onDismissAll={() => {}}
        onRequeue={() => {}}
        providerLabel={() => "KAL VIP"}
      />,
    );

    expect(view.queryByRole("button", { name: "Market" })).toBeNull();
    fireEvent.change(view.getByRole("combobox"), { target: { value: "trade-1" } });
    expect(view.getByRole("button", { name: "Market" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Original" })).toBeTruthy();
  });

  test("confirms bulk dismissal with the complete review set", async () => {
    const dismissed: string[][] = [];
    let finishDismissal = () => {};
    const dismissal = new Promise<void>((resolve) => {
      finishDismissal = resolve;
    });
    const items = ["held-1", "held-2"].map((id) => ({
      accountId: "account-1",
      actionable: true,
      commandType: "OPEN_TRADE",
      createdAt: new Date().toISOString(),
      currentPrice: null,
      driftPct: null,
      droppedLifecycle: [],
      droppedLifecycleCount: 0,
      heldReason: "GUARDIAN",
      id,
      originalEntry: null,
      providerId: "provider-1",
      symbol: id === "held-1" ? "EURUSD" : "XAUUSD",
    }));
    const view = render(
      <HeldSignalsTable
        accountLabel={() => "FTMO"}
        items={items}
        onDismiss={() => {}}
        onDismissAll={(selected) => {
          dismissed.push(selected.map((item) => item.id));
          return dismissal;
        }}
        onRequeue={() => {}}
        providerLabel={() => "VIP Gold"}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: "Dismiss all" }));
    fireEvent.click(view.getByRole("button", { name: "Dismiss 2 signals" }));

    await waitFor(() => expect(dismissed).toEqual([["held-1", "held-2"]]));
    expect(view.getByRole("button", { name: "Dismissing…" }).hasAttribute("disabled")).toBe(true);
    finishDismissal();
    await waitFor(() =>
      expect(view.getByRole("button", { name: "Dismiss all" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
  });
});
