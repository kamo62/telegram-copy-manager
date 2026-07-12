import "../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { DashboardSnapshot } from "../App";
import { GrowthChart, type GrowthSeries } from "../components/GrowthChart";
import { SettingsPage } from "../pages/SettingsPage";
import {
  applyColorAccents,
  COLOR_ACCENTS_STORAGE_KEY,
  ColorAccentsProvider,
} from "./ColorAccentsContext";
import { ToastProvider, useToast } from "./ToastContext";

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(COLOR_ACCENTS_STORAGE_KEY);
  applyColorAccents(true);
});

const data: GrowthSeries = {
  growth: [
    [1, 2],
    [100, 110],
  ],
  drawdown: [
    [1, 2],
    [0, 5],
  ],
  totalProfit: 10,
  numberOfTrades: 2,
};

function ToastButton() {
  const { toast } = useToast();
  return (
    <button onClick={() => toast("Updated")} type="button">
      Notify
    </button>
  );
}

describe("Colour accents", () => {
  test("defaults on, persists the Settings toggle, and drives chart and notification selectors", () => {
    const view = render(
      <ColorAccentsProvider>
        <ToastProvider autoDismissMs={0}>
          <SettingsPage
            onSaveForm={() => undefined}
            onSubmit={(event) => event.preventDefault()}
            settings={
              {
                defaultLotSize: 0.1,
                defaultRiskPercent: 1,
                defaultStopLossPips: 50,
                defaultTakeProfitPips: 200,
                pollingIntervalSeconds: 2,
                allowedOrderTypes: [],
                azureOpenAIKeyConfigured: false,
                dedupWindowSeconds: 300,
                maxOpenTradeAgeSeconds: 0,
                drawdownWarnPct: 10,
                drawdownDangerPct: 20,
                reportingCurrency: "USD",
                usdZarRate: 16,
              } satisfies DashboardSnapshot["appSettings"]
            }
          />
          <GrowthChart data={data} />
          <ToastButton />
        </ToastProvider>
      </ColorAccentsProvider>,
    );

    const toggle = view.getByRole("checkbox", { name: "Colour accents" }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(document.documentElement.dataset.colorAccents).toBe("on");
    expect(
      view
        .getByLabelText("Account growth chart")
        .querySelector("[data-color-accents]")
        ?.getAttribute("data-color-accents"),
    ).toBe("on");

    fireEvent.click(view.getByRole("button", { name: "Notify" }));
    const toast = view.getByText("Updated").closest(".toast")!;
    expect(toast.parentElement?.getAttribute("data-color-accents")).toBe("on");

    fireEvent.click(toggle);
    expect(window.localStorage.getItem(COLOR_ACCENTS_STORAGE_KEY)).toBe("off");
    expect(document.documentElement.dataset.colorAccents).toBe("off");
    expect(
      view
        .getByLabelText("Account growth chart")
        .querySelector("[data-color-accents]")
        ?.getAttribute("data-color-accents"),
    ).toBe("off");
    expect(toast.parentElement?.getAttribute("data-color-accents")).toBe("off");
  });
});
