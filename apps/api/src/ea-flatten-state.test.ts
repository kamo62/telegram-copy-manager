import { describe, expect, test } from "bun:test";
import { type FlattenBroker, type FlattenPosition, flattenClose } from "./ea-flatten-state";

class FakeBroker implements FlattenBroker {
  pending = new Set(["order-1"]);
  positions = new Map<string, FlattenPosition>();
  closeResults: Array<{
    retcode: "DONE" | "DONE_PARTIAL" | "PLACED" | "FAILED";
    filledVolume: number;
  }> = [];
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
      const remaining = position.volume - result.filledVolume;
      if (remaining <= 0.000001) this.positions.delete(ticket);
      else this.positions.set(ticket, { ...position, volume: remaining });
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

    const result = flattenClose(broker, "partial-1", new Set<string>(), false);

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

    const first = flattenClose(broker, "partial-2", executedTickets, false);
    expect(first.status).toBe("PARTIAL");
    expect(first.closeAttempts).toEqual([
      { ticket: "position-1", requestedVolume: 0.04, filledVolume: 0 },
      { ticket: "position-2", requestedVolume: 0.03, filledVolume: 0.01 },
    ]);
    expect(executedTickets).toContain("partial-2:position-2");
    expect(executedTickets).not.toContain("partial-2:position-1");
    expect([...broker.pending].sort()).toEqual(["order-1", "order-2"]);

    const retry = flattenClose(broker, "partial-2", executedTickets, false);
    expect(retry.status).toBe("EXECUTED");
    expect(retry.closeAttempts).toEqual([
      { ticket: "position-1", requestedVolume: 0.04, filledVolume: 0.04 },
    ]);
    expect(broker.closeCalls).toEqual([
      { ticket: "position-1", volume: 0.04 },
      { ticket: "position-2", volume: 0.03 },
      { ticket: "position-1", volume: 0.04 },
    ]);
  });

  test("a partial close with no unexecuted slices stays UNKNOWN", () => {
    const broker = new FakeBroker();
    broker.positions.set("position-1", { ticket: "position-1", volume: 0.04 });
    const executedTickets = new Set(["partial-3:position-1"]);

    const result = flattenClose(broker, "partial-3", executedTickets, false);

    expect(result.status).toBe("UNKNOWN");
    expect(result.closeAttempts).toEqual([]);
    expect(broker.closeCalls).toEqual([]);
  });
});
