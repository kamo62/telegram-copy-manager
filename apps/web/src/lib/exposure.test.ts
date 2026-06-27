import { describe, expect, test } from "bun:test";
import { computeExposure, fallbackPipSize } from "./exposure";

const pipSizeFor = (symbol: string) => (symbol === "XAUUSD" ? 0.1 : 0.0001);

describe("computeExposure", () => {
  test("aggregates lots and volume-weighted pip risk per symbol", () => {
    const result = computeExposure(
      [
        { symbol: "XAUUSD", volume: 0.1, openPrice: 2300, sl: 2290 }, // 100 pips
        { symbol: "EURUSD", volume: 0.2, openPrice: 1.1, sl: 1.095 }, // 50 pips
      ],
      pipSizeFor,
    );
    expect(result.totalLots).toBe(0.3);
    const xau = result.bySymbol.find((s) => s.symbol === "XAUUSD");
    expect(xau?.lots).toBe(0.1);
    expect(xau?.riskPips).toBe(100);
    expect(xau?.riskPipLots).toBe(10);
    const eur = result.bySymbol.find((s) => s.symbol === "EURUSD");
    expect(eur?.riskPips).toBe(50);
    expect(eur?.riskPipLots).toBe(10);
  });

  test("combines positions on the same symbol and ignores zero-volume", () => {
    const result = computeExposure(
      [
        { symbol: "XAUUSD", volume: 0.1, openPrice: 2300, sl: 2290 },
        { symbol: "XAUUSD", volume: 0.2, openPrice: 2300, sl: 2295 }, // 50 pips
        { symbol: "EURUSD", volume: 0 },
      ],
      pipSizeFor,
    );
    expect(result.totalLots).toBe(0.3);
    expect(result.bySymbol).toHaveLength(1);
    const xau = result.bySymbol[0];
    // weighted: (100*0.1 + 50*0.2)/0.3 = 66.7
    expect(xau?.lots).toBe(0.3);
    expect(xau?.riskPips).toBe(66.7);
  });

  test("fallbackPipSize picks sensible defaults", () => {
    expect(fallbackPipSize("XAUUSD")).toBe(0.1);
    expect(fallbackPipSize("USDJPY")).toBe(0.01);
    expect(fallbackPipSize("EURUSD")).toBe(0.0001);
  });
});
