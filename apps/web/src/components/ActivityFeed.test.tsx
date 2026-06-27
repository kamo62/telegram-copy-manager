import "../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { ActivityFeed, type AuditLogEntry } from "./ActivityFeed";

afterEach(() => cleanup());

const sample: AuditLogEntry[] = [
  {
    id: "a1",
    eventType: "signal.approve",
    level: "info",
    message: "Signal approved for MT5 queue",
    actor: "operator",
    createdAt: "2026-06-26T12:00:00.000Z",
  },
  {
    id: "a2",
    eventType: "logical-trade.reconciled",
    level: "warn",
    message: "Trade reconciled OPEN → OUT_OF_SYNC",
    actor: "system",
    createdAt: "2026-06-26T12:01:00.000Z",
  },
];

describe("ActivityFeed", () => {
  test("renders operator + system audit rows from the loader", async () => {
    let view: ReturnType<typeof render> | undefined;
    await act(async () => {
      view = render(<ActivityFeed load={async () => sample} />);
      await Promise.resolve();
    });
    const { getByText } = view as ReturnType<typeof render>;
    expect(getByText("signal.approve")).toBeDefined();
    expect(getByText("Signal approved for MT5 queue")).toBeDefined();
    expect(getByText("logical-trade.reconciled")).toBeDefined();
    expect(getByText("operator")).toBeDefined();
    expect(getByText("system")).toBeDefined();
  });

  test("shows an empty state when there is no activity", async () => {
    let view: ReturnType<typeof render> | undefined;
    await act(async () => {
      view = render(<ActivityFeed load={async () => []} />);
      await Promise.resolve();
    });
    const { getByText } = view as ReturnType<typeof render>;
    expect(getByText("No activity yet")).toBeDefined();
  });
});
