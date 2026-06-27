import "../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { ExposurePanel } from "./ExposurePanel";

afterEach(() => cleanup());

describe("ExposurePanel", () => {
  test("renders total lots and per-symbol risk using loaded metadata", async () => {
    let view: ReturnType<typeof render> | undefined;
    await act(async () => {
      view = render(
        <ExposurePanel
          accountId="mt5-1"
          load={async () => [{ symbol: "XAUUSD", pipSize: 0.1 }]}
          positions={[{ symbol: "XAUUSD", volume: 0.2, openPrice: 2300, sl: 2290 }]}
        />,
      );
      await Promise.resolve();
    });
    const { getByText } = view as ReturnType<typeof render>;
    expect(getByText("0.2 lots open")).toBeDefined();
    expect(getByText("XAUUSD")).toBeDefined();
    expect(getByText("100 pips")).toBeDefined();
  });

  test("renders nothing when there are no open positions", async () => {
    let view: ReturnType<typeof render> | undefined;
    await act(async () => {
      view = render(<ExposurePanel accountId="mt5-1" load={async () => []} positions={[]} />);
      await Promise.resolve();
    });
    const { container } = view as ReturnType<typeof render>;
    expect(container.querySelector(".exposure-panel")).toBeNull();
  });
});
