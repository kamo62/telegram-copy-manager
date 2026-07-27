import "../test-setup";
import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { Money } from "./Money";

describe("Money", () => {
  test("keeps zero neutral when sign colouring is enabled", () => {
    const view = render(<Money currency="USD" signTone value={0} />);

    expect(view.container.firstElementChild?.className).toBe("money");
  });
});
