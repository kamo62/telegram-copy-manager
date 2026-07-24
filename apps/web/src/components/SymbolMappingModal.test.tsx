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
    expect((view.getByLabelText("Broker symbol for this account") as HTMLInputElement).value).toBe(
      "XAUUSD.raw",
    );
    expect((view.getByLabelText("Mapping suffix") as HTMLInputElement).value).toBe(".raw");
    expect(view.getByLabelText("Broker symbol for this account").hasAttribute("disabled")).toBe(
      false,
    );
  });

  test("filters broker symbols, ranks quoted matches first, and labels unquoted symbols", () => {
    const view = render(
      <SymbolMappingModal
        availableBrokerSymbols={["EURUSD.raw", "XAUUSD.pro", "XAUUSD.raw"]}
        brokerSymbolMetadata={[{ symbol: "XAUUSD.raw", bid: 2450, ask: 2450.2 }]}
        defaultAccountId="mt5-1"
        onClose={() => undefined}
        onSaveAccountMapping={() => undefined}
        onSaveGlobalAlias={() => undefined}
        open
      />,
    );
    fireEvent.click(view.getByRole("tab", { name: "Account" }));
    fireEvent.input(view.getByLabelText("Account source symbol"), {
      target: { value: "XAUUSD" },
    });
    const options = view.getAllByRole("option");
    expect(options[0]?.textContent).toContain("XAUUSD.raw");
    expect(options[0]?.textContent).toContain("QUOTED");
    expect(options[1]?.textContent).toContain("XAUUSD.pro");
    expect(options[1]?.textContent).toContain("UNQUOTED");
    fireEvent.input(view.getByLabelText("Broker symbol for this account"), {
      target: { value: "pro" },
    });
    expect(view.getAllByRole("option")).toHaveLength(1);
    expect(view.getByRole("option").textContent).toContain("XAUUSD.pro");
  });

  test("supports keyboard selection and keeps affix guessing opt-in", () => {
    const view = render(
      <SymbolMappingModal
        availableBrokerSymbols={["XAUUSD.raw", "XAUUSD.pro", "EURUSD.raw"]}
        defaultAccountId="mt5-1"
        onClose={() => undefined}
        onSaveAccountMapping={() => undefined}
        onSaveGlobalAlias={() => undefined}
        open
      />,
    );
    fireEvent.click(view.getByRole("tab", { name: "Account" }));
    const source = view.getByLabelText("Account source symbol");
    fireEvent.input(source, { target: { value: "XAUUSD" } });
    expect(view.queryByText(/Looks like a/)).toBeTruthy();
    expect((view.getByLabelText("Mapping suffix") as HTMLInputElement).value).toBe("");
    fireEvent.click(view.getByText(/Looks like a/));
    expect((view.getByLabelText("Mapping suffix") as HTMLInputElement).value).toBe(".raw");

    const broker = view.getByLabelText("Broker symbol for this account");
    fireEvent.focus(broker);
    fireEvent.keyDown(broker, { key: "Enter" });
    expect((broker as HTMLInputElement).value).toBe("XAUUSD.pro");
  });

  test("does not suggest an affix from one outlier symbol", () => {
    const view = render(
      <SymbolMappingModal
        availableBrokerSymbols={["XAUUSD.raw", "EURUSD", "USDJPY"]}
        defaultAccountId="mt5-1"
        onClose={() => undefined}
        onSaveAccountMapping={() => undefined}
        onSaveGlobalAlias={() => undefined}
        open
      />,
    );
    fireEvent.click(view.getByRole("tab", { name: "Account" }));
    fireEvent.input(view.getByLabelText("Account source symbol"), {
      target: { value: "XAUUSD" },
    });
    expect(view.queryByText(/Looks like a/)).toBeNull();
  });

  test("rejects unselected canonical broker text", () => {
    let saves = 0;
    const view = render(
      <SymbolMappingModal
        availableBrokerSymbols={["XAUUSD.raw"]}
        defaultAccountId="mt5-1"
        onClose={() => undefined}
        onSaveAccountMapping={() => {
          saves += 1;
        }}
        onSaveGlobalAlias={() => undefined}
        open
      />,
    );
    fireEvent.click(view.getByRole("tab", { name: "Account" }));
    fireEvent.input(view.getByLabelText("Account source symbol"), {
      target: { value: "XAUUSD" },
    });
    fireEvent.input(view.getByLabelText("Broker symbol for this account"), {
      target: { value: "XAUUSD.custom" },
    });
    fireEvent.click(view.getByRole("button", { name: "Save account mapping" }));
    expect(saves).toBe(0);
    expect(view.getByText("Select a broker symbol from the list")).toBeDefined();
  });
});
