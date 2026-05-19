export class ApiError extends Error {
  status: number;
  requestId: string;
  body?: unknown;

  constructor(message: string, status: number, requestId: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.requestId = requestId;
    this.body = body;
  }
}

interface ApiOptions extends Omit<RequestInit, "body"> {
  timeoutMs?: number;
  body?: BodyInit | object | null;
}

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isPlainJsonBody(body: unknown): body is object {
  if (body === null || body === undefined) return false;
  if (typeof body !== "object") return false;
  if (body instanceof FormData) return false;
  if (body instanceof URLSearchParams) return false;
  if (body instanceof Blob) return false;
  if (body instanceof ArrayBuffer) return false;
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) return false;
  return true;
}

export async function apiFetch<T = unknown>(input: string, opts: ApiOptions = {}): Promise<T> {
  const { timeoutMs = 15_000, body, headers, signal, ...rest } = opts;
  const requestId = randomId();
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort);
  }

  const finalHeaders = new Headers(headers);
  finalHeaders.set("X-Request-Id", requestId);
  if (!finalHeaders.has("Accept")) {
    finalHeaders.set("Accept", "application/json");
  }

  let finalBody: BodyInit | undefined;
  if (body !== undefined && body !== null) {
    if (isPlainJsonBody(body)) {
      finalBody = JSON.stringify(body);
      if (!finalHeaders.has("Content-Type")) {
        finalHeaders.set("Content-Type", "application/json");
      }
    } else {
      finalBody = body as BodyInit;
    }
  }

  try {
    const response = await fetch(input, {
      ...rest,
      headers: finalHeaders,
      body: finalBody,
      signal: controller.signal,
    });

    if (!response.ok) {
      let errBody: unknown;
      const cloned = response.clone();
      try {
        errBody = await cloned.json();
      } catch {
        try {
          errBody = await response.text();
        } catch {
          errBody = undefined;
        }
      }
      const message =
        errBody && typeof errBody === "object" && "error" in errBody
          ? String((errBody as { error: unknown }).error)
          : `HTTP ${response.status}`;
      throw new ApiError(message, response.status, requestId, errBody);
    }

    if (response.status === 204 || response.headers.get("content-length") === "0") {
      return undefined as T;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return (await response.json()) as T;
    }
    return (await response.text()) as unknown as T;
  } finally {
    window.clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

export function apiGet<T = unknown>(url: string, opts?: ApiOptions): Promise<T> {
  return apiFetch<T>(url, { ...opts, method: "GET" });
}

export function apiPost<T = unknown>(
  url: string,
  body?: object | BodyInit | null,
  opts?: ApiOptions,
): Promise<T> {
  return apiFetch<T>(url, { ...opts, method: "POST", body });
}

export function apiPatch<T = unknown>(
  url: string,
  body?: object | BodyInit | null,
  opts?: ApiOptions,
): Promise<T> {
  return apiFetch<T>(url, { ...opts, method: "PATCH", body });
}

export function apiDelete<T = unknown>(url: string, opts?: ApiOptions): Promise<T> {
  return apiFetch<T>(url, { ...opts, method: "DELETE" });
}
