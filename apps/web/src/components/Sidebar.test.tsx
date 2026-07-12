import "../test-setup";
import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { Sidebar } from "./Sidebar";

describe("Sidebar", () => {
  test("renders distinct account and pending-slot status markers", () => {
    const view = render(
      <Sidebar
        accounts={[
          { id: "online", label: "XM-Long account", online: true, status: "online" },
          { id: "offline", label: "MT5-Offline", online: false, status: "offline" },
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
  });
});
