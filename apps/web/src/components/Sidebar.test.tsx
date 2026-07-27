import "../test-setup";
import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { Sidebar } from "./Sidebar";

describe("Sidebar", () => {
  test("renders distinct account and pending-slot status markers", () => {
    const view = render(
      <Sidebar
        accounts={[
          {
            id: "online",
            label: "XM-Long account",
            broker: "XM",
            currency: "USD",
            equity: 24_800,
            online: true,
            status: "online",
          },
          {
            id: "offline",
            label: "MT5-Offline",
            broker: "MT5",
            currency: "ZAR",
            equity: 1_070,
            online: false,
            status: "offline",
          },
        ]}
        activeView="dashboard"
        onNavigate={() => {}}
        pendingSlots={[{ id: "pending", name: "Pending slot", linkCode: "ABC123" }]}
        selectedAccountId="online"
      />,
    );

    expect(view.getByText("XM-Long account").previousElementSibling?.classList.contains("ok")).toBe(
      true,
    );
    expect(view.getByText("MT5-Offline").previousElementSibling?.classList.contains("off")).toBe(
      true,
    );
    expect(view.container.querySelector(".sidebar-child-dot.pending.lucide-link-2")).not.toBeNull();
    expect(view.getByRole("button", { name: "XM-Long account" }).getAttribute("aria-current")).toBe(
      "true",
    );
    expect(view.getByRole("button", { name: /Pending slot/ }).getAttribute("title")).toContain(
      "Waiting for EA",
    );
    expect(view.getByText(/XM.*\$/).textContent).toContain("XM");
  });

  test("shows the complete signal review count", () => {
    const view = render(<Sidebar activeView="dashboard" onNavigate={() => {}} reviewCount={4} />);

    expect(view.getByTitle("4 signals need review").textContent).toBe("4");
  });
});
