import { describe, expect, test } from "bun:test";
import { downsample } from "./downsample";

describe("downsample", () => {
  test("caps long series at the requested point count", () => {
    expect(
      downsample(
        Array.from({ length: 500 }, (_value, index) => index),
        96,
      ),
    ).toHaveLength(96);
  });

  test("preserves the series low and high", () => {
    const sampled = downsample([100, 105, 98, 130, 99, 35, 110, 108, 112, 109], 6);

    expect(sampled).toContain(130);
    expect(sampled).toContain(35);
  });

  test("returns short series unchanged", () => {
    const values = [100, 101, 99];

    expect(downsample(values, 96)).toBe(values);
  });
});
