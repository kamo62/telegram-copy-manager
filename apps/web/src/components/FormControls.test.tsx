import "../test-setup";
import { expect, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { NumberField, SaveBar, Switch, ThresholdBar } from "./FormControls";

test("Switch exposes its checked state", () => {
  const view = render(<Switch aria-label="Copy signals" defaultChecked />);
  const control = view.getByRole("switch", { name: "Copy signals" });
  expect(control.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(control);
  expect(control.getAttribute("aria-checked")).toBe("false");
});

test("NumberField steppers honor min, step, and decimal places", () => {
  function Example() {
    const [value, setValue] = useState("0.10");
    return (
      <NumberField
        aria-label="Lots"
        min="0.01"
        onChange={(event) => setValue(event.currentTarget.value)}
        step="0.01"
        unit="lots"
        value={value}
      />
    );
  }
  const view = render(<Example />);
  fireEvent.click(view.getByRole("button", { name: "Increase Lots" }));
  expect((view.getByRole("spinbutton", { name: "Lots" }) as HTMLInputElement).value).toBe("0.11");
});

test("ThresholdBar and SaveBar expose live values and actions", () => {
  const discarded: string[] = [];
  const view = render(
    <>
      <ThresholdBar danger={20} warn={10} />
      <SaveBar dirty onDiscard={() => discarded.push("discard")} onSave={() => undefined} />
    </>,
  );
  expect(view.getByRole("img", { name: "Warn at 10%, danger at 20%" })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Discard" }));
  expect(discarded).toEqual(["discard"]);
});
