import { describe, expect, test } from "bun:test";
import {
  closeVolumeForRunner,
  type FlattenBroker,
  type FlattenPosition,
  flattenClose,
} from "./ea-flatten-state";

class FakeBroker implements FlattenBroker {
  pending = new Set(["order-1"]);
  positions = new Map<string, FlattenPosition>();
  closeResults: Array<{
    retcode: "DONE" | "DONE_PARTIAL" | "PLACED" | "FAILED";
    filledVolume: number;
  }> = [];
  observedCloseVolumes: number[] = [];
  closeCalls: Array<{ ticket: string; volume: number }> = [];

  pendingOrderTickets() {
    return [...this.pending];
  }

  removePendingOrder(ticket: string) {
    this.pending.delete(ticket);
    if (ticket === "order-1" && this.positions.size === 0) {
      this.positions.set("position-1", { ticket: "position-1", volume: 0.03 });
    }
    return { retcode: "DONE" as const };
  }

  positionTickets() {
    return [...this.positions.keys()];
  }

  position(ticket: string) {
    return this.positions.get(ticket);
  }

  closePosition(ticket: string, volume: number) {
    this.closeCalls.push({ ticket, volume });
    const result = this.closeResults.shift() ?? { retcode: "DONE" as const, filledVolume: volume };
    const position = this.positions.get(ticket);
    if (position) {
      const appliedVolume = this.observedCloseVolumes.shift() ?? result.filledVolume;
      const remaining = position.volume - appliedVolume;
      if (remaining <= 0.000001) this.positions.delete(ticket);
      else this.positions.set(ticket, { ...position, volume: Number(remaining.toFixed(8)) });
    }
    return result;
  }
}

describe("EA flatten state machine", () => {
  test("removes a pending order, catches a fill, retries a partial close, and never over-closes", () => {
    const broker = new FakeBroker();
    broker.closeResults = [
      { retcode: "DONE_PARTIAL", filledVolume: 0.01 },
      { retcode: "DONE", filledVolume: 0.02 },
    ];
    const executedTickets = new Set<string>();

    const first = flattenClose(broker, "close-1", executedTickets);
    expect(first.status).toBe("PARTIAL");
    expect(first.removedPendingTickets).toEqual(["order-1"]);
    expect(first.closeAttempts).toEqual([
      { ticket: "position-1", requestedVolume: 0.03, filledVolume: 0.01 },
    ]);
    expect(broker.position("position-1")?.volume).toBeCloseTo(0.02);
    expect(executedTickets.size).toBe(0);

    const second = flattenClose(broker, "close-1", executedTickets);
    expect(second.status).toBe("EXECUTED");
    expect(second.closeAttempts[0]?.ticket).toBe("position-1");
    expect(second.closeAttempts[0]?.requestedVolume).toBeCloseTo(0.02);
    expect(second.closeAttempts[0]?.filledVolume).toBeCloseTo(0.02);
    expect(broker.position("position-1")).toBeUndefined();
    expect(executedTickets).toContain("close-1:position-1");

    const replay = flattenClose(broker, "close-1", executedTickets);
    expect(replay.status).toBe("UNKNOWN");
    expect(broker.closeCalls).toHaveLength(2);
  });

  test("a partial close never cancels working pending orders", () => {
    const broker = new FakeBroker();
    broker.pending = new Set(["order-1", "order-2"]);
    broker.positions.set("position-1", { ticket: "position-1", volume: 0.04 });

    const result = flattenClose(broker, "partial-1", new Set<string>(), false, {
      kind: "LOTS",
      value: 0.01,
    });

    expect(result.removedPendingTickets).toEqual([]);
    expect([...broker.pending].sort()).toEqual(["order-1", "order-2"]);
    expect(result.closeAttempts[0]?.ticket).toBe("position-1");
  });

  test("aggregates partial slices, marks only DONE tickets, and holds a failed slice", () => {
    const broker = new FakeBroker();
    broker.pending = new Set(["order-1", "order-2"]);
    broker.positions.set("position-1", { ticket: "position-1", volume: 0.04 });
    broker.positions.set("position-2", { ticket: "position-2", volume: 0.03 });
    broker.closeResults = [
      { retcode: "FAILED", filledVolume: 0 },
      { retcode: "DONE", filledVolume: 0.01 },
      { retcode: "DONE", filledVolume: 0.04 },
    ];
    const executedTickets = new Set<string>();

    const first = flattenClose(broker, "partial-2", executedTickets, false, {
      kind: "PERCENT",
      value: 100,
    });
    expect(first.status).toBe("PARTIAL");
    expect(first.closeAttempts).toEqual([
      { ticket: "position-1", requestedVolume: 0.04, filledVolume: 0 },
      { ticket: "position-2", requestedVolume: 0.03, filledVolume: 0.01 },
    ]);
    expect(executedTickets).not.toContain("partial-2:position-2");
    expect(executedTickets).not.toContain("partial-2:position-1");
    expect([...broker.pending].sort()).toEqual(["order-1", "order-2"]);

    const retry = flattenClose(broker, "partial-2", executedTickets, false, {
      kind: "PERCENT",
      value: 100,
    });
    expect(retry.status).toBe("EXECUTED");
    expect(retry.closeAttempts).toEqual([
      { ticket: "position-1", requestedVolume: 0.04, filledVolume: 0.04 },
      { ticket: "position-2", requestedVolume: 0.02, filledVolume: 0.02 },
    ]);
    expect(broker.closeCalls).toEqual([
      { ticket: "position-1", volume: 0.04 },
      { ticket: "position-2", volume: 0.03 },
      { ticket: "position-1", volume: 0.04 },
      { ticket: "position-2", volume: 0.02 },
    ]);
  });

  test("a partial close with no unexecuted slices stays UNKNOWN", () => {
    const broker = new FakeBroker();
    broker.positions.set("position-1", { ticket: "position-1", volume: 0.04 });
    const executedTickets = new Set(["partial-3:position-1"]);

    const result = flattenClose(broker, "partial-3", executedTickets, false, {
      kind: "LOTS",
      value: 0.04,
    });

    expect(result.status).toBe("UNKNOWN");
    expect(result.closeAttempts).toEqual([]);
    expect(broker.closeCalls).toEqual([]);
  });

  test("holds a PERCENT close with zero target remaining volume", () => {
    const broker = new FakeBroker();
    broker.pending.clear();
    broker.positions.set("position-1", { ticket: "position-1", volume: 0.04 });

    const result = flattenClose(broker, "percent-zero", new Set<string>(), false, {
      kind: "PERCENT",
      value: 100,
      targetRemainingVolume: 0,
    });

    expect(result.status).toBe("PARTIAL");
    expect(result.closeAttempts).toEqual([]);
    expect(broker.closeCalls).toEqual([]);
  });

  test("requests PERCENT, LOTS, and TP_LEG slices instead of full position volume", () => {
    const cases = [
      {
        partialClose: { kind: "PERCENT" as const, value: 50, targetRemainingVolume: 0.02 },
        volume: 0.03,
        expected: 0.01,
      },
      { partialClose: { kind: "LOTS" as const, value: 0.01 }, volume: 0.03, expected: 0.01 },
      {
        partialClose: { kind: "TP_LEG" as const, value: 1, allocationPercent: 25 },
        volume: 0.04,
        expected: 0.01,
      },
    ];

    for (const { partialClose, volume, expected } of cases) {
      const broker = new FakeBroker();
      broker.pending.clear();
      broker.positions.set("position-1", { ticket: "position-1", volume });
      const result = flattenClose(broker, "partial-sizing", new Set<string>(), false, partialClose);
      expect(result.closeAttempts).toEqual([
        { ticket: "position-1", requestedVolume: expected, filledVolume: expected },
      ]);
      expect(broker.closeCalls).toEqual([{ ticket: "position-1", volume: expected }]);
    }
  });

  test("does not escalate sub-minimum partial slices to full closes", () => {
    for (const partialClose of [
      { kind: "LOTS" as const, value: 0.09 },
      { kind: "TP_LEG" as const, value: 2, volume: 0.06 },
      { kind: "PERCENT" as const, value: 30, targetRemainingVolume: 0.21 },
    ]) {
      const broker = new FakeBroker();
      broker.pending.clear();
      broker.positions.set("position-1", { ticket: "position-1", volume: 0.3 });

      const result = flattenClose(
        broker,
        "partial-sub-minimum",
        new Set<string>(),
        false,
        partialClose,
        { minVolume: 0.1, volumeStep: 0.1 },
      );

      expect(result.status).toBe("PARTIAL");
      expect(result.closeAttempts).toEqual([]);
      expect(broker.closeCalls).toEqual([]);
      expect(broker.position("position-1")?.volume).toBe(0.3);
    }
  });

  test("closes the whole position when the runner is disabled", () => {
    const broker = new FakeBroker();
    broker.pending.clear();
    broker.positions.set("position-1", { ticket: "position-1", volume: 0.03 });

    const result = flattenClose(broker, "close-full", new Set<string>(), true, undefined, {
      runner: { enabled: false, lotSize: 0.01 },
    });

    expect(result.status).toBe("EXECUTED");
    expect(broker.closeCalls).toEqual([{ ticket: "position-1", volume: 0.03 }]);
    expect(broker.position("position-1")).toBeUndefined();
  });

  test("leaves exactly the configured runner lot when the close slice has room", () => {
    const broker = new FakeBroker();
    broker.pending.clear();
    broker.positions.set("position-1", { ticket: "position-1", volume: 0.05 });

    const result = flattenClose(broker, "close-runner", new Set<string>(), true, undefined, {
      runner: { enabled: true, lotSize: 0.02 },
      minVolume: 0.01,
      volumeStep: 0.01,
    });

    expect(result.status).toBe("EXECUTED");
    expect(broker.closeCalls).toEqual([{ ticket: "position-1", volume: 0.03 }]);
    expect(broker.position("position-1")?.volume).toBe(0.02);
    expect(closeVolumeForRunner(0.05, { enabled: true, lotSize: 0.02 })).toBe(0.03);
  });

  test("preserves the runner when there is no valid closable slice", () => {
    const broker = new FakeBroker();
    broker.pending.clear();
    broker.positions.set("position-1", { ticket: "position-1", volume: 0.01 });

    const result = flattenClose(broker, "close-min", new Set<string>(), true, undefined, {
      runner: { enabled: true, lotSize: 0.01 },
      minVolume: 0.01,
      volumeStep: 0.01,
    });

    expect(result.status).toBe("PARTIAL");
    expect(broker.closeCalls).toEqual([]);
    expect(broker.position("position-1")?.volume).toBe(0.01);
    expect(closeVolumeForRunner(0.015, { enabled: true, lotSize: 0.01 })).toBe(0);
    expect(closeVolumeForRunner(0.03, { enabled: true, lotSize: 0.01 }, 0.01, 0)).toBe(0);
  });

  test("accepts an observed position delta when the deal reports no filled volume", () => {
    const broker = new FakeBroker();
    broker.pending.clear();
    broker.positions.set("position-1", { ticket: "position-1", volume: 0.03 });
    broker.closeResults = [{ retcode: "DONE", filledVolume: 0 }];
    broker.observedCloseVolumes = [0.01];

    const result = flattenClose(broker, "close-observed", new Set<string>(), false, {
      kind: "LOTS",
      value: 0.01,
    });

    expect(result.status).toBe("EXECUTED");
    expect(result.closeAttempts).toEqual([
      { ticket: "position-1", requestedVolume: 0.01, filledVolume: 0.01 },
    ]);
    expect(broker.position("position-1")?.volume).toBe(0.02);
  });
});
