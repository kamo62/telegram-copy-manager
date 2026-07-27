import "../test-setup";
import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { OpenPositionsTable } from "./OpenPositionsTable";

describe("OpenPositionsTable", () => {
  test("uses an empty state instead of an empty positions header when only pending orders exist", () => {
    const view = render(
      <OpenPositionsTable
        accounts={[
          {
            id: "account-1",
            accountNumber: "1514065673",
            appOrders: [
              {
                comment: "",
                magic: 1,
                openPrice: 4_000,
                sl: 4_010,
                symbol: "XAUUSD",
                ticket: "123",
                tp: 3_990,
                type: 4,
                volume: 0.1,
              },
            ],
          },
        ]}
        focusedAccountId="account-1"
      />,
    );

    expect(view.getByText("No positions open right now")).toBeTruthy();
    expect(view.queryByRole("columnheader", { name: "Floating P/L" })).toBeNull();
    expect(view.getByRole("columnheader", { name: "Trigger" })).toBeTruthy();
  });
});
