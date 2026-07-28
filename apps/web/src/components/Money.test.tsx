import "../test-setup";
import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { Money, numericSignTone } from "./Money";

describe("numericSignTone", () => {
  // This helper is the mechanism: Money, Stat and the Operations "Today" figure all
  // consume it. The earlier bug was a per-call-site ternary that returned "up" for
  // zero, painting a flat day green. Asserting Money alone did not pin that, because
  // Money already handled zero correctly - the defect lived in the caller.
  test("treats zero as neither gain nor loss", () => {
    expect(numericSignTone(0)).toBeNull();
    expect(numericSignTone(-0)).toBeNull();
  });

  test("still signs real movement", () => {
    expect(numericSignTone(0.01)).toBe("up");
    expect(numericSignTone(-0.01)).toBe("down");
  });

  test("treats absent and non-finite values as toneless rather than as a gain", () => {
    expect(numericSignTone(null)).toBeNull();
    expect(numericSignTone(undefined)).toBeNull();
    expect(numericSignTone(Number.NaN)).toBeNull();
    expect(numericSignTone(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("Money", () => {
  test("keeps zero neutral when sign colouring is enabled", () => {
    const view = render(<Money currency="USD" signTone value={0} />);

    expect(view.container.firstElementChild?.className).toBe("money");
  });

  test("colours a real gain and a real loss", () => {
    const gain = render(<Money currency="USD" signTone value={12.34} />);
    expect(gain.container.firstElementChild?.className).toContain("up");

    const loss = render(<Money currency="USD" signTone value={-12.34} />);
    expect(loss.container.firstElementChild?.className).toContain("down");
  });
});
