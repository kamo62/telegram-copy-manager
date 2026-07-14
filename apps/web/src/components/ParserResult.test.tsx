import "../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { ParserResult } from "./ParserResult";

afterEach(() => cleanup());

describe("ParserResult", () => {
  test("shows parser reasons and the symbol-resolution chain without offering GPT extraction for NO_SIGNAL", () => {
    const view = render(
      <ParserResult
        fixtureClassification="noise"
        onApprove={() => undefined}
        onClassify={() => undefined}
        onForcePush={() => undefined}
        onIgnore={() => undefined}
        onRedactedChange={() => undefined}
        onSaveFixture={() => undefined}
        onAiReview={() => undefined}
        redactedText=""
        result={{
          id: "parse-1",
          providerTitle: "Alpha",
          rawText: "Market update only",
          commandType: "NO_SIGNAL",
          rawSymbol: "GOLD",
          canonicalSymbol: "XAUUSD",
          brokerSymbol: "XAUUSD.raw",
          mappingStatus: "unmapped",
          mappingSource: "provider_alias",
          mappingWarnings: ["Broker symbol unavailable"],
          confidence: 0.42,
          missingFields: ["brokerSymbol"],
          warnings: ["Symbol could not be mapped"],
          matchedPatternIds: ["noise.no-signal"],
          reviewRequired: true,
        }}
      />,
    );

    expect(view.getByText("Why flagged")).toBeTruthy();
    expect(view.getAllByText("No trade signal")).toHaveLength(2);
    expect(view.getByText("Low confidence")).toBeTruthy();
    expect(view.getByText(/Symbol resolution: GOLD → XAUUSD → XAUUSD\.raw/)).toBeTruthy();
    expect(view.queryByRole("button", { name: "Extract with GPT" })).toBeNull();
  });

  test("replaces stale actions with the saved lifecycle state", () => {
    const view = render(
      <ParserResult
        fixtureClassification="entry"
        onApprove={() => undefined}
        onClassify={() => undefined}
        onIgnore={() => undefined}
        onRedactedChange={() => undefined}
        onSaveFixture={() => undefined}
        redactedText=""
        result={{
          id: "parse-2",
          providerTitle: "Alpha",
          rawText: "BUY EURUSD",
          commandType: "OPEN_TRADE",
          canonicalSymbol: "EURUSD",
          brokerSymbol: "EURUSD.raw",
          mappingStatus: "mapped",
          confidence: 0.9,
          reviewRequired: false,
          status: "HELD",
          heldReason: "NO_ACCOUNT",
        }}
      />,
    );

    expect(view.getByText("HELD")).toBeTruthy();
    expect(view.getByText("NO_ACCOUNT")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(view.queryByRole("button", { name: "Ignore" })).toBeNull();
  });

  test("renders legacy sparse parser rows without optional diagnostics", () => {
    const view = render(
      <ParserResult
        fixtureClassification="unknown"
        onClassify={() => undefined}
        onRedactedChange={() => undefined}
        onSaveFixture={() => undefined}
        redactedText=""
        result={{
          id: "parse-legacy",
          providerTitle: "Legacy",
          rawText: "BUY XAUUSD",
          commandType: "OPEN_TRADE",
          canonicalSymbol: "",
          brokerSymbol: "",
          mappingStatus: "unmapped",
          confidence: 0,
          reviewRequired: false,
        }}
      />,
    );

    expect(view.getAllByText("Low confidence")).toHaveLength(2);
    expect(view.getByText(/Symbol resolution: — → — → —/)).toBeTruthy();
  });
});
