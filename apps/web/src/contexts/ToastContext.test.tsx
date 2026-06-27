import "../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { ToastProvider, useToast } from "./ToastContext";

afterEach(() => cleanup());

function Harness() {
  const { success } = useToast();
  return (
    <button onClick={() => success("Queued ✓")} type="button">
      approve
    </button>
  );
}

describe("ToastContext", () => {
  test("a toast appears on action and auto-dismisses", async () => {
    const { getByRole, queryByText } = render(
      <ToastProvider autoDismissMs={40}>
        <Harness />
      </ToastProvider>,
    );

    expect(queryByText("Queued ✓")).toBeNull();
    fireEvent.click(getByRole("button", { name: "approve" }));
    expect(queryByText("Queued ✓")).not.toBeNull();

    // Flush the auto-dismiss timer deterministically.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(queryByText("Queued ✓")).toBeNull();
  });

  test("a toast can be dismissed manually", async () => {
    const { getByRole, queryByText } = render(
      <ToastProvider autoDismissMs={0}>
        <Harness />
      </ToastProvider>,
    );
    fireEvent.click(getByRole("button", { name: "approve" }));
    expect(queryByText("Queued ✓")).not.toBeNull();
    fireEvent.click(getByRole("button", { name: "Dismiss notification" }));
    expect(queryByText("Queued ✓")).toBeNull();
  });
});
