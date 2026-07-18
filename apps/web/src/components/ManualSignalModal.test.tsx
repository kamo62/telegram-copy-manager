import "../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { ManualSignalModal, validateManualSignalValues } from "./ManualSignalModal";

afterEach(() => cleanup());

describe("ManualSignalModal", () => {
  test("pre-fills every trade field supplied by a parsed signal seed", () => {
    const view = render(
      <ManualSignalModal
        accounts={[
          {
            id: "account-1",
            accountNumber: "100200300",
            availableSymbols: ["XAUUSD.raw"],
          },
        ]}
        onClose={() => undefined}
        onSubmit={() => undefined}
        open
        seed={{
          accountId: "account-1",
          brokerSymbol: "XAUUSD.raw",
          direction: "SELL",
          orderType: "LIMIT",
          entry: { from: 3388.5, to: 3390 },
          stopLoss: 3398,
          takeProfits: [{ price: 3375 }, 3360],
          volume: 0.04,
          executionMode: "SPLIT_ORDER",
        }}
      />,
    );

    expect((view.getByLabelText("Account") as HTMLSelectElement).value).toBe("account-1");
    expect((view.getByLabelText("Symbol") as HTMLSelectElement).value).toBe("XAUUSD.raw");
    expect((view.getByLabelText("Direction") as HTMLSelectElement).value).toBe("SELL");
    expect((view.getByLabelText("Order type") as HTMLSelectElement).value).toBe("LIMIT");
    expect((view.getByLabelText("Entry from") as HTMLInputElement).value).toBe("3388.5");
    expect((view.getByLabelText("Entry to (optional)") as HTMLInputElement).value).toBe("3390");
    expect((view.getByLabelText("Stop loss") as HTMLInputElement).value).toBe("3398");
    expect((view.getByLabelText("Volume (lots)") as HTMLInputElement).value).toBe("0.04");
    expect((view.getByLabelText("Execution") as HTMLSelectElement).value).toBe("SPLIT_ORDER");
    expect((view.getByPlaceholderText("TP1 price") as HTMLInputElement).value).toBe("3375");
    expect((view.getByPlaceholderText("TP2 price") as HTMLInputElement).value).toBe("3360");
  });

  test("rejects invalid numeric prices and volume before submit", () => {
    expect(
      validateManualSignalValues({
        direction: "BUY",
        orderType: "LIMIT",
        entryFrom: "-1",
        entryTo: "",
        stopLoss: "nope",
        volume: "-0.1",
        takeProfits: ["invalid"],
      }),
    ).toEqual({
      entryFrom: "Entry price must be a positive number",
      stopLoss: "Stop loss must be a positive number",
      volume: "Volume must be a positive number",
      takeProfits: ["TP1 must be a positive number"],
    });
  });

  test("requires a pending BUY stop loss to stay below entry", () => {
    expect(
      validateManualSignalValues({
        direction: "BUY",
        orderType: "LIMIT",
        entryFrom: "100",
        entryTo: "",
        stopLoss: "101",
        volume: "",
        takeProfits: [],
      }).stopLoss,
    ).toBe("Stop loss must be below entry");
  });
});
