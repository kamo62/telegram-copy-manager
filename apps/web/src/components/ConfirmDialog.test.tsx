import "../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ConfirmDialog } from "./ConfirmDialog";

afterEach(() => cleanup());

describe("ConfirmDialog", () => {
  test("renders title + description and wires cancel/confirm", () => {
    let confirmed = 0;
    let cancelled = 0;
    const { getByText, getByRole } = render(
      <ConfirmDialog
        confirmLabel="Remove"
        description="Provider KAL VIP will be removed."
        onCancel={() => {
          cancelled += 1;
        }}
        onConfirm={() => {
          confirmed += 1;
        }}
        title="Remove provider?"
      />,
    );

    expect(getByText("Remove provider?")).toBeDefined();
    expect(getByText("Provider KAL VIP will be removed.")).toBeDefined();
    expect(getByRole("dialog").getAttribute("aria-describedby")).toBe("confirm-dialog-description");

    fireEvent.click(getByRole("button", { name: "Cancel" }));
    expect(cancelled).toBe(1);
    expect(confirmed).toBe(0);

    fireEvent.click(getByRole("button", { name: "Remove" }));
    expect(confirmed).toBe(1);
  });

  test("type-to-confirm renders a guard input and disables confirm until provided", () => {
    // With a type-to-confirm guard the confirm button starts disabled and the
    // guard input is shown.
    const guarded = render(
      <ConfirmDialog
        confirmLabel="Delete"
        onCancel={() => {}}
        onConfirm={() => {}}
        title="Delete account?"
        typeToConfirm="63442826"
      />,
    );
    expect((guarded.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(guarded.getByLabelText("Type to confirm")).toBeDefined();
    cleanup();

    // Without a guard the confirm button is enabled immediately.
    const open = render(
      <ConfirmDialog
        confirmLabel="Delete"
        onCancel={() => {}}
        onConfirm={() => {}}
        title="Delete?"
      />,
    );
    expect((open.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  test("submits once through the enabled confirmation form", () => {
    let confirmed = 0;
    const view = render(
      <ConfirmDialog
        onCancel={() => {}}
        onConfirm={() => {
          confirmed += 1;
        }}
        title="Delete account?"
      />,
    );

    const form = view.container.querySelector("form");
    if (!form) throw new Error("Confirmation form not found");
    fireEvent.submit(form);

    expect(confirmed).toBe(1);
  });
});
