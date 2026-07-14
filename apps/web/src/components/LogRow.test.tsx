import "../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { LogRow } from "./LogRow";

afterEach(() => cleanup());

describe("LogRow", () => {
  test("shows broker error text and expands stored execution details", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({
        log: {
          id: "log-1",
          queueItemId: "queue-1",
          retcode: 10016,
          retcodeExternal: 4756,
          brokerComment: "Invalid stops",
          errorText: "Stops are too close",
          orderTicket: "order-1",
          positionTicket: "position-1",
          dealTicket: "deal-1",
          requestedPrice: 1.085,
          filledPrice: 1.0849,
          volume: 0.1,
          status: "FAILED",
        },
      })) as unknown as typeof fetch;
    const view = render(
      <LogRow
        log={{
          id: "log-1",
          queueItemId: "queue-1",
          retcode: 10016,
          brokerComment: "Invalid stops",
          errorText: "Stops are too close",
          status: "FAILED",
        }}
      />,
    );

    expect(view.getByText("Stops are too close")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Details" }));
    await waitFor(() => expect(view.getByText(/Order: order-1/)).toBeTruthy());
    expect(view.getByText(/Requested: 1\.085/)).toBeTruthy();
    globalThis.fetch = originalFetch;
  });
});
