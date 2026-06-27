import "../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { OnboardingCard } from "./OnboardingCard";

afterEach(() => cleanup());

describe("OnboardingCard", () => {
  test("shows three steps and triggers connect/link actions", () => {
    let connect = 0;
    let link = 0;
    const { getByText, getByRole } = render(
      <OnboardingCard
        hasAccounts={false}
        hasProviders={false}
        onConnectTelegram={() => {
          connect += 1;
        }}
        onLinkAccount={() => {
          link += 1;
        }}
        telegramConnected={false}
      />,
    );

    expect(getByText(/Step 1: Connect Telegram/)).toBeDefined();
    expect(getByText(/Step 2: Pick a signal channel/)).toBeDefined();
    expect(getByText(/Step 3: Link MT5/)).toBeDefined();

    fireEvent.click(getByRole("button", { name: "Connect Telegram" }));
    expect(connect).toBe(1);
    fireEvent.click(getByRole("button", { name: "Link MT5 account" }));
    expect(link).toBe(1);
  });

  test("hides actions for completed steps", () => {
    const { queryByRole } = render(
      <OnboardingCard
        hasAccounts={false}
        hasProviders={true}
        onConnectTelegram={() => {}}
        onLinkAccount={() => {}}
        telegramConnected={true}
      />,
    );
    expect(queryByRole("button", { name: "Connect Telegram" })).toBeNull();
    expect(queryByRole("button", { name: "Link MT5 account" })).not.toBeNull();
  });
});
