import "../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { ProviderHealthCard, type ProviderScore } from "./ProviderHealthCard";

afterEach(() => cleanup());

const greenScore: ProviderScore = {
  tradeCount: 25,
  sampleSize: 20,
  winRate: 0.72,
  wins: 14,
  losses: 6,
  streak: 3,
  streakKind: "win",
  avgPips: 12,
  badge: "green",
  learnedPatterns: 2,
};

describe("ProviderHealthCard", () => {
  test("renders the badge, win rate, streak and learned patterns", async () => {
    let view: ReturnType<typeof render> | undefined;
    await act(async () => {
      view = render(
        <ProviderHealthCard load={async () => greenScore} providerId="p1" title="KAL VIP" />,
      );
      await Promise.resolve();
    });
    const { getByText } = view as ReturnType<typeof render>;
    expect(getByText("KAL VIP")).toBeDefined();
    expect(getByText("Healthy")).toBeDefined();
    expect(getByText("72% win")).toBeDefined();
    expect(getByText("W3")).toBeDefined();
    expect(getByText("2 learned patterns")).toBeDefined();
  });

  test("renders a neutral placeholder when the score is unavailable", async () => {
    let view: ReturnType<typeof render> | undefined;
    await act(async () => {
      view = render(
        <ProviderHealthCard load={async () => null} providerId="p2" title="Alpha FX" />,
      );
      await Promise.resolve();
    });
    const { getByText } = view as ReturnType<typeof render>;
    expect(getByText("Alpha FX")).toBeDefined();
    expect(getByText("New")).toBeDefined();
  });

  test("reset learning calls onReset and clears the learned count", async () => {
    let resetId = "";
    let view: ReturnType<typeof render> | undefined;
    await act(async () => {
      view = render(
        <ProviderHealthCard
          load={async () => greenScore}
          onReset={async (id) => {
            resetId = id;
          }}
          providerId="p1"
          title="KAL VIP"
        />,
      );
      await Promise.resolve();
    });
    const { getByRole, queryByText } = view as ReturnType<typeof render>;
    expect(queryByText("2 learned patterns")).not.toBeNull();
    await act(async () => {
      getByRole("button", { name: "Reset learning" }).click();
      await Promise.resolve();
    });
    expect(resetId).toBe("p1");
    expect(queryByText("2 learned patterns")).toBeNull();
  });
});
