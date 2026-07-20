import "../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { SymbolMappingModal } from "./SymbolMappingModal";

afterEach(() => cleanup());

describe("SymbolMappingModal", () => {
  test("keeps account edits and broker options when the dashboard snapshot refreshes", async () => {
    function Harness() {
      const [symbols, setSymbols] = useState(["XAUUSD.raw", "EURUSD.raw"]);
      return (
        <>
          <button onClick={() => setSymbols([])} type="button">
            Refresh dashboard
          </button>
          <SymbolMappingModal
            availableBrokerSymbols={symbols}
            defaultAccountId="mt5-1"
            defaultProviderId="provider-1"
            onClose={() => undefined}
            onSaveAccountMapping={() => undefined}
            onSaveGlobalAlias={() => undefined}
            open
          />
        </>
      );
    }
    const view = render(<Harness />);

    fireEvent.click(view.getByRole("tab", { name: "Account" }));
    fireEvent.click(view.getByLabelText("Map from provider symbol"));
    fireEvent.input(view.getByLabelText("Account source symbol"), { target: { value: "GOLD" } });
    fireEvent.input(view.getByLabelText("Broker symbol for this account"), {
      target: { value: "XAUUSD.raw" },
    });
    fireEvent.input(view.getByLabelText("Mapping suffix"), { target: { value: ".raw" } });
    await act(async () => undefined);

    expect((view.getByLabelText("Account source symbol") as HTMLInputElement).value).toBe("GOLD");

    fireEvent.click(view.getByRole("button", { name: "Refresh dashboard" }));

    expect((view.getByLabelText("Account source symbol") as HTMLInputElement).value).toBe("GOLD");
    expect((view.getByLabelText("Broker symbol for this account") as HTMLSelectElement).value).toBe(
      "XAUUSD.raw",
    );
    expect((view.getByLabelText("Mapping suffix") as HTMLInputElement).value).toBe(".raw");
    expect(view.getByRole("option", { name: "XAUUSD.raw" })).toBeTruthy();
    expect(view.getByLabelText("Broker symbol for this account").hasAttribute("disabled")).toBe(
      false,
    );
  });
});
