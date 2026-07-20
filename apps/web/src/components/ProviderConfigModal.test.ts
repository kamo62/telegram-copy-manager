import { describe, expect, test } from "bun:test";
import {
  computeTpAllocationPreview,
  type RunnerConfig,
  type TpDraftLevel,
  validateProviderConfigDraft,
} from "./ProviderConfigModal";

const runnerOff: RunnerConfig = {
  enabled: false,
  lotSize: 0.01,
  slBehavior: "break-even",
  trailPips: 10,
};

const runnerOn: RunnerConfig = {
  enabled: true,
  lotSize: 0.02,
  slBehavior: "break-even",
  trailPips: 10,
};

function tp(leg: number, percentage: string): TpDraftLevel {
  return {
    leg,
    percentage,
    strategy: leg === 1 ? { kind: "set-sl-to-entry", offsetPips: 0 } : { kind: "no-change" },
  };
}

describe("provider TP allocation preview", () => {
  test("calculates fixed-lot TP lots after reserving the runner lot", () => {
    const preview = computeTpAllocationPreview({
      riskMode: "fixed",
      riskAmountText: "0.10",
      tps: [tp(1, "25"), tp(2, "25"), tp(3, "50")],
      runner: runnerOn,
    });

    expect(preview.canPreviewLots).toBe(true);
    expect(preview.totalOrderLots).toBeCloseTo(0.1);
    expect(preview.runnerLots).toBeCloseTo(0.02);
    expect(preview.tpCloseLots).toBeCloseTo(0.08);
    expect(preview.rows.map((row) => row.effectivePercent)).toEqual([25, 25, 50]);
    expect(preview.rows[0]?.lots).toBeCloseTo(0.02);
    expect(preview.rows[1]?.lots).toBeCloseTo(0.02);
    expect(preview.rows[2]?.lots).toBeCloseTo(0.04);
  });

  test("treats configured percentages as weights across only available TP rows", () => {
    const preview = computeTpAllocationPreview({
      riskMode: "fixed",
      riskAmountText: "0.03",
      tps: [tp(1, "30"), tp(3, "30")],
      runner: { ...runnerOn, lotSize: 0.01 },
    });

    expect(preview.rows.map((row) => row.leg)).toEqual([1, 3]);
    expect(preview.totalEnteredPercent).toBe(60);
    expect(preview.rows.map((row) => row.effectivePercent)).toEqual([50, 50]);
    expect(preview.rows[0]?.lots).toBeCloseTo(0.01);
    expect(preview.rows[1]?.lots).toBeCloseTo(0.01);
  });

  test("does not preview exact lots for percent-risk sizing", () => {
    const preview = computeTpAllocationPreview({
      riskMode: "percent",
      riskAmountText: "1.5",
      tps: [tp(1, "50"), tp(2, "50")],
      runner: runnerOn,
    });

    expect(preview.canPreviewLots).toBe(false);
    expect(preview.totalOrderLots).toBeNull();
    expect(preview.runnerLots).toBeNull();
    expect(preview.tpCloseLots).toBeNull();
    expect(preview.rows.every((row) => row.lots === null)).toBe(true);
  });
});

describe("provider TP validation", () => {
  test("rejects all-zero TP percentages when TP rows are configured", () => {
    const validation = validateProviderConfigDraft({
      riskMode: "fixed",
      riskAmountText: "0.10",
      tps: [tp(1, "0"), tp(2, "0")],
      runner: runnerOff,
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain("Enter a positive percentage for at least one TP.");
  });

  test("rejects a fixed runner lot that consumes the whole TP pool", () => {
    const validation = validateProviderConfigDraft({
      riskMode: "fixed",
      riskAmountText: "0.10",
      tps: [tp(1, "50"), tp(2, "50")],
      runner: { ...runnerOn, lotSize: 0.1 },
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain("Runner lot must be less than the fixed lot size.");
  });

  test("rejects prior-TP strategies without an earlier configured TP", () => {
    const validation = validateProviderConfigDraft({
      riskMode: "fixed",
      riskAmountText: "0.10",
      tps: [
        {
          ...tp(1, "100"),
          strategy: { kind: "set-sl-to-tp", tpLeg: 1, offsetPips: 0 },
        },
      ],
      runner: runnerOff,
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain("TP1 cannot move SL to a prior TP.");
  });

  test("rejects a 50/50 split at 0.01 lots", () => {
    const validation = validateProviderConfigDraft({
      riskMode: "fixed",
      riskAmountText: "0.01",
      tps: [tp(1, "50"), tp(2, "50")],
      runner: runnerOff,
    });
    expect(validation.valid).toBe(false);
    expect(validation.errors.join(" ")).toContain(
      "0.01 lots can support at most 1 positive TP leg",
    );
  });

  test("accepts one 100% TP at 0.01 lots and two at 0.02 lots", () => {
    expect(
      validateProviderConfigDraft({
        riskMode: "fixed",
        riskAmountText: "0.01",
        tps: [tp(1, "100")],
        runner: runnerOff,
      }).valid,
    ).toBe(true);
    expect(
      validateProviderConfigDraft({
        riskMode: "fixed",
        riskAmountText: "0.02",
        tps: [tp(1, "50"), tp(2, "50")],
        runner: runnerOff,
      }).valid,
    ).toBe(true);
  });

  test("accepts KAL VIP 50/0/0/50 at 0.02 lots", () => {
    expect(
      validateProviderConfigDraft({
        riskMode: "fixed",
        riskAmountText: "0.02",
        tps: [tp(1, "50"), tp(2, "0"), tp(3, "0"), tp(4, "50")],
        runner: runnerOff,
      }).valid,
    ).toBe(true);
  });

  test("rejects TP totals other than 100 in both risk modes", () => {
    for (const riskMode of ["fixed", "percent"] as const) {
      const validation = validateProviderConfigDraft({
        riskMode,
        riskAmountText: riskMode === "fixed" ? "0.02" : "1",
        tps: [tp(1, "60"), tp(2, "30")],
        runner: runnerOff,
      });
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain("TP percentages must total 100% (currently 90%).");
    }
  });

  test("does not apply fixed-lot split feasibility to percent risk", () => {
    expect(
      validateProviderConfigDraft({
        riskMode: "percent",
        riskAmountText: "1",
        tps: [tp(1, "25"), tp(2, "25"), tp(3, "25"), tp(4, "25")],
        runner: runnerOff,
      }).valid,
    ).toBe(true);
  });
});
