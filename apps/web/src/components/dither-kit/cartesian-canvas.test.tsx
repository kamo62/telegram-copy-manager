import "../../test-setup";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";
import { CartesianCanvas } from "./cartesian-canvas";
import { ChartContext, type ChartContextValue, useChartController } from "./chart-context";
import type { DitherColor } from "./palette";

// happy-dom has no 2D canvas, so the paint calls are recorded through a stub
// context. Each entry is one canvas operation; `fillRect` / `stroke` carry the
// colour so a repaint can be told apart from a repaint in a *new* colour.
let ops: string[] = [];

const realGetContext = HTMLCanvasElement.prototype.getContext;

function stubContext(): CanvasRenderingContext2D {
  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    clearRect: () => ops.push("clearRect"),
    fillRect: () => ops.push(`fillRect ${ctx.fillStyle}`),
    drawImage: () => ops.push("drawImage"),
    beginPath: () => ops.push("beginPath"),
    moveTo: () => ops.push("moveTo"),
    lineTo: () => ops.push("lineTo"),
    stroke: () => ops.push(`stroke ${ctx.strokeStyle}`),
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

// A manual frame queue: the loop only advances when a test flushes a frame, so
// "did the loop schedule another frame?" is directly observable.
const frames = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;
const realRaf = globalThis.requestAnimationFrame;
const realCancelRaf = globalThis.cancelAnimationFrame;

const pending = () => frames.size;

function flushFrame(now: number) {
  const due = [...frames.entries()];
  frames.clear();
  // A frame can report the entrance as done, which is a React state update.
  act(() => {
    for (const [, cb] of due) cb(now);
  });
}

const paints = () => ops.filter((op) => op === "drawImage").length;

beforeEach(() => {
  ops = [];
  frames.clear();
  nextFrameId = 1;
  HTMLCanvasElement.prototype.getContext = (() =>
    stubContext()) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    const id = nextFrameId++;
    frames.set(id, cb);
    return id;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    frames.delete(id);
  }) as typeof cancelAnimationFrame;
});

afterEach(() => cleanup());

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = realGetContext;
  globalThis.requestAnimationFrame = realRaf;
  globalThis.cancelAnimationFrame = realCancelRaf;
});

const ROWS = [
  { x: 0, value: 10 },
  { x: 1, value: 14 },
  { x: 2, value: 9 },
];

/** Drives the canvas straight off the real controller, with the measured size
 * supplied as a prop so readiness, resize and data changes are all scriptable. */
function Harness({
  width,
  height,
  data = ROWS,
  color = "grey",
  animate = false,
  onReady,
}: {
  width: number;
  height: number;
  data?: Record<string, unknown>[];
  color?: DitherColor;
  animate?: boolean;
  /** Hands the live controller out so a test can drive hover the way the
   * pointer handlers on the chart root would. */
  onReady?: (ctx: ChartContextValue) => void;
}) {
  const ctx = useChartController({
    chartType: "area",
    data,
    config: { value: { label: "Equity", color } },
    stackType: "default",
    dimensions: { width, height },
    margins: { top: 0, right: 0, bottom: 0, left: 0 },
    animate,
  });
  onReady?.(ctx);
  return (
    <ChartContext value={ctx}>
      <CartesianCanvas />
    </ChartContext>
  );
}

describe("CartesianCanvas paint loop", () => {
  test("stops rescheduling while the chart is not ready to paint", () => {
    render(<Harness width={0} height={0} />);

    // The loop takes its first frame on mount, finds nothing measured, and parks.
    expect(pending()).toBe(1);
    flushFrame(0);
    expect(paints()).toBe(0);
    expect(pending()).toBe(0);

    // Still parked. An unmeasured chart must not hold a frame open.
    flushFrame(16);
    flushFrame(32);
    expect(paints()).toBe(0);
    expect(pending()).toBe(0);
  });

  test("paints when readiness arrives late, then parks again once settled", () => {
    const view = render(<Harness width={0} height={0} />);
    flushFrame(0);
    expect(pending()).toBe(0);

    // 10x10 keeps the backing grid at its 8x8 floor, so the loop is woken
    // rather than rebuilt. This exercises late readiness, not a resize.
    view.rerender(<Harness width={10} height={10} />);
    expect(pending()).toBe(1);

    flushFrame(100);
    expect(paints()).toBeGreaterThan(0);
    expect(ops.some((op) => op.startsWith("fillRect"))).toBe(true);
    // A static chart has nothing left to animate, so it releases the frame.
    expect(pending()).toBe(0);
  });

  test("repaints on a data change and then parks", () => {
    const view = render(<Harness width={200} height={100} />);
    flushFrame(0);
    const settled = paints();
    expect(settled).toBeGreaterThan(0);
    expect(pending()).toBe(0);

    view.rerender(
      <Harness
        width={200}
        height={100}
        data={[
          { x: 0, value: 40 },
          { x: 1, value: 12 },
          { x: 2, value: 31 },
        ]}
      />,
    );
    expect(pending()).toBe(1);

    // The surfaces ease toward the new data, so the loop keeps frames until
    // it lands on the target.
    let guard = 0;
    while (pending() > 0 && guard < 400) {
      guard += 1;
      flushFrame(100 + guard * 16);
    }
    expect(guard).toBeLessThan(400);
    expect(paints()).toBeGreaterThan(settled);
  });

  test("repaints in the new colour when the accent changes", () => {
    const view = render(<Harness width={200} height={100} color="grey" />);
    flushFrame(0);
    expect(pending()).toBe(0);
    expect(ops.some((op) => op.includes("rgba(240,70,70"))).toBe(false);

    view.rerender(<Harness width={200} height={100} color="red" />);
    expect(pending()).toBe(1);
    flushFrame(16);

    // The offscreen dither fill is re-rendered in the new accent, so the
    // repaint goes deeper than re-blitting the cached surface.
    expect(ops.some((op) => op.includes("rgba(240,70,70"))).toBe(true);
    expect(pending()).toBe(0);
  });

  test("rebuilds and repaints on resize without leaving the old frame queued", () => {
    const view = render(<Harness width={200} height={100} />);
    flushFrame(0);
    const before = paints();
    expect(pending()).toBe(0);

    view.rerender(<Harness width={420} height={180} />);
    // Exactly one loop is live: the old handle was cancelled on teardown.
    expect(pending()).toBe(1);
    flushFrame(16);
    expect(paints()).toBeGreaterThan(before);
    expect(pending()).toBe(0);
  });

  test("keeps animating while the entrance and stars still have work", () => {
    render(<Harness width={200} height={100} animate />);

    // Stars wink and the entrance reveal is still running, so every frame
    // schedules the next one.
    for (let i = 0; i < 6; i += 1) {
      expect(pending()).toBe(1);
      flushFrame(i * 16);
    }
    expect(pending()).toBe(1);
    expect(paints()).toBeGreaterThan(0);
  });

  test("draws the crosshair on hover and holds frames while the lift settles", () => {
    let ctx: ChartContextValue | null = null;
    render(<Harness width={200} height={100} onReady={(value) => (ctx = value)} />);
    flushFrame(0);
    expect(pending()).toBe(0);

    act(() => {
      ctx?.setMouseInChart(true);
      ctx?.setHoverIndex(2);
    });
    // The hover lift eases over several frames, so the loop must keep the
    // frame it was handed until the intensity lands.
    expect(pending()).toBe(1);
    let guard = 0;
    let crosshairs = 0;
    while (pending() > 0 && guard < 400) {
      guard += 1;
      const before = ops.length;
      flushFrame(guard * 16);
      // The crosshair column is painted after the fill is blitted across.
      const blit = ops.indexOf("drawImage", before);
      if (blit >= 0 && ops.slice(blit).some((op) => op.startsWith("fillRect"))) crosshairs += 1;
    }
    expect(guard).toBeLessThan(400);
    expect(crosshairs).toBeGreaterThan(0);

    // Leaving the plot clears the crosshair and settles back to parked.
    act(() => {
      ctx?.setMouseInChart(false);
      ctx?.setHoverIndex(null);
    });
    guard = 0;
    while (pending() > 0 && guard < 400) {
      guard += 1;
      flushFrame(1_000 + guard * 16);
    }
    expect(guard).toBeLessThan(400);
    expect(pending()).toBe(0);
  });

  test("cancels the outstanding frame on unmount", () => {
    const view = render(<Harness width={200} height={100} animate />);
    expect(pending()).toBe(1);

    view.unmount();
    expect(pending()).toBe(0);
  });

  test("leaves one live loop under the StrictMode double mount", () => {
    // The app renders inside <StrictMode>, so in development the loop effect is
    // mounted, torn down and mounted again. The discarded loop must not leave a
    // second frame queued, and the surviving one must still paint and park.
    render(
      <StrictMode>
        <Harness width={200} height={100} />
      </StrictMode>,
    );
    expect(pending()).toBe(1);

    flushFrame(0);
    expect(paints()).toBeGreaterThan(0);
    expect(pending()).toBe(0);
  });
});
