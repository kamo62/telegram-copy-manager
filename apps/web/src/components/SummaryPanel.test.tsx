import "../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { applyColorAccents, ColorAccentsProvider } from "../contexts/ColorAccentsContext";
import { CHART_PALETTE } from "../lib/chartPalette";
import { SummaryPanel } from "./SummaryPanel";

afterEach(() => {
  cleanup();
  window.localStorage.removeItem("ttc:colorAccents");
  applyColorAccents(true);
});

const data = {
  growth: [
    [1, 2],
    [100, 110],
  ] as [number[], number[]],
  drawdown: [
    [1, 2],
    [0, 0],
  ] as [number[], number[]],
  totalProfit: 10,
  numberOfTrades: 2,
};

describe("SummaryPanel", () => {
  test("uses the shared palette when enabled and neutral ink when disabled", () => {
    const view = render(
      <ColorAccentsProvider>
        <SummaryPanel data={data} />
      </ColorAccentsProvider>,
    );
    expect(
      view
        .getByLabelText("Account equity trend")
        .querySelector("path[stroke]")
        ?.getAttribute("stroke"),
    ).toBe(CHART_PALETTE.growthCss);

    view.unmount();
    window.localStorage.setItem("ttc:colorAccents", "off");
    const monochrome = render(
      <ColorAccentsProvider>
        <SummaryPanel data={data} />
      </ColorAccentsProvider>,
    );
    expect(
      monochrome
        .getByLabelText("Account equity trend")
        .querySelector("path[stroke]")
        ?.getAttribute("stroke"),
    ).toBe(CHART_PALETTE.neutralCss);
  });
});
