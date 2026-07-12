import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

if (!globalThis.ResizeObserver) {
  Object.defineProperty(globalThis, "ResizeObserver", {
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
}

const getContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function (
  this: HTMLCanvasElement,
  ...args: Parameters<typeof getContext>
) {
  try {
    return getContext.apply(this, args);
  } catch {
    return null;
  }
} as typeof HTMLCanvasElement.prototype.getContext;
