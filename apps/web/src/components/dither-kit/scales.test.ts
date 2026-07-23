import { describe, expect, test } from "bun:test";
import { buildYScale, computeBands } from "./scales";

describe("dither chart scales", () => {
  test("keeps a flat $10,000 multi-point area band on the narrowed plot", () => {
    const values = [10000, 10000, 10000];
    const domain: [number, number] = [9800, 10200];
    const { bands } = computeBands(
      values.map((value) => ({ value })),
      ["value"],
      "default",
      domain[0],
    );
    const y = buildYScale(domain[0], domain[1], 300);
    const valueBands = bands.value ?? [];

    expect(valueBands).toEqual([
      [9800, 10000],
      [9800, 10000],
      [9800, 10000],
    ]);
    expect(y(valueBands[0]![0])).toBeCloseTo(300);
  });
});
