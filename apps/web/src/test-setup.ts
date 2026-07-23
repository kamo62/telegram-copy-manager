import { GlobalRegistrator } from "@happy-dom/global-registrator";

const bunFetchAndStreams = {
  AbortController,
  AbortSignal,
  Headers,
  ReadableStream,
  Request,
  Response,
  TransformStream,
  WritableStream,
};

GlobalRegistrator.register();

// Keep Bun's fetch/stream implementations available to API tests in a combined
// run; happy-dom's Node stream shims do not implement WritableStream.getWriter.
Object.assign(globalThis, bunFetchAndStreams);

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
