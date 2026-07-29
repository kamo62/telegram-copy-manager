import "../test-setup";
import { describe, expect, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { Panel } from "./Panel";

describe("Panel", () => {
  test("keeps tab content as direct panel children", () => {
    const view = render(
      <Panel
        activeTab="Open"
        collapsible
        onTabChange={() => undefined}
        tabs={["Open", "Closed"]}
        title="Trade history"
      >
        <div className="data-table-wrap">rows</div>
      </Panel>,
    );

    const panel = view.getByRole("tabpanel");
    expect(panel.querySelector(":scope > .data-table-wrap")).not.toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Collapse Trade history" }));
    expect(panel.querySelector(":scope > .data-table-wrap")).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Expand Trade history" }));
    expect(panel.querySelector(":scope > .data-table-wrap")).not.toBeNull();
  });
});
