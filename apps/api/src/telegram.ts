import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type TelegramSessionStatus =
  | "CODE_REQUIRED"
  | "PASSWORD_REQUIRED"
  | "CONNECTED"
  | "DISCONNECTED";

export interface TelegramDialog {
  id: string;
  title: string;
  type: "channel" | "group" | "user";
  unreadCount: number;
}

export interface TelegramCapturedMessage {
  telegramMessageId: string;
  messageDate: string;
  rawText: string;
  quotedText?: string;
  senderName?: string;
}

export interface TelegramFetchOptions {
  dateFrom?: string;
  dateTo?: string;
  offsetDate?: string;
}

export interface TelegramSessionHealth {
  sessionId: string;
  connected: boolean;
  lastContactAt?: string;
  stalledSeconds?: number;
  stalled: boolean;
}

export interface TelegramLoginStartInput {
  appSessionId: string;
  profileId: string;
  apiId: string;
  apiHash: string;
  phone: string;
}

export interface TelegramAdapter {
  name: string;
  startLogin(input: TelegramLoginStartInput): Promise<{
    status: TelegramSessionStatus;
    isCodeViaApp?: boolean;
    passwordHint?: string;
  }>;
  submitCode(
    sessionId: string,
    code: string,
  ): Promise<{ status: TelegramSessionStatus; passwordHint?: string }>;
  submitPassword(sessionId: string, password: string): Promise<{ status: TelegramSessionStatus }>;
  disconnect(sessionId: string): Promise<void>;
  listDialogs(sessionId: string): Promise<TelegramDialog[]>;
  fetchRecentMessages(
    sessionId: string,
    dialogId: string,
    limit: number,
    options?: TelegramFetchOptions,
  ): Promise<TelegramCapturedMessage[]>;
  sessionHealth?(sessionId: string): TelegramSessionHealth;
}

const DEFAULT_RECONNECT_RETRY_DELAY_MS = 2_000;
const MAX_RECONNECT_RETRY_DELAY_MS = 10_000;

export class TelegramRpcTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Telegram RPC timed out after ${timeoutMs}ms`);
    this.name = "TelegramRpcTimeoutError";
  }
}

// gramjs defaults connectionRetries to Infinity. The previous override of 5
// capped MTProto reconnect attempts, so any network blip longer than ~5s left
// the client permanently disconnected with no further retries and live signal
// capture silently stopped until the process restarted. Restore unbounded
// auto-reconnect, overridable via env for tests and diagnostics.
export function parseConnectionRetries(raw: string | undefined): number {
  if (raw === undefined || raw === "") return Number.POSITIVE_INFINITY;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Number.POSITIVE_INFINITY;
}

export function parseReconnectRetryDelay(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_RECONNECT_RETRY_DELAY_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.min(Math.floor(parsed), MAX_RECONNECT_RETRY_DELAY_MS)
    : DEFAULT_RECONNECT_RETRY_DELAY_MS;
}

export async function withTelegramRpcTimeout<T>(operation: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new TelegramRpcTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const TELEGRAM_CONNECTION_RETRIES = parseConnectionRetries(process.env.TELEGRAM_CONNECTION_RETRIES);

const GRAMJS_CLIENT_OPTIONS = {
  connectionRetries: TELEGRAM_CONNECTION_RETRIES,
  autoReconnect: true,
  retryDelay: parseReconnectRetryDelay(process.env.TELEGRAM_RECONNECT_RETRY_DELAY_MS),
};

// How long without a successful Telegram RPC before the session is considered
// stalled. Surfaced in the status snapshot so a silent capture outage is
// visible instead of looking like "no new messages".
const TELEGRAM_STALL_SECONDS = Number(process.env.TELEGRAM_STALL_SECONDS ?? 180);

export function createTelegramAdapter(
  name = process.env.TELEGRAM_ADAPTER ?? "mock",
): TelegramAdapter {
  if (name === "gramjs") {
    return new GramjsTelegramAdapter();
  }
  return new MockTelegramAdapter();
}

class MockTelegramAdapter implements TelegramAdapter {
  name = "mock";

  async startLogin() {
    return { status: "CODE_REQUIRED" as const, isCodeViaApp: true };
  }

  async submitCode(_sessionId: string, code: string) {
    return { status: code === "22222" ? ("PASSWORD_REQUIRED" as const) : ("CONNECTED" as const) };
  }

  async submitPassword() {
    return { status: "CONNECTED" as const };
  }

  async disconnect() {}

  async listDialogs(): Promise<TelegramDialog[]> {
    return demoDialogs();
  }

  async fetchRecentMessages(_sessionId: string, _dialogId: string, limit: number) {
    return demoMessages().slice(0, limit);
  }

  sessionHealth(sessionId: string): TelegramSessionHealth {
    return { sessionId, connected: true, stalled: false };
  }
}

interface PendingLogin {
  client: GramjsClient;
  session: { save: () => string };
  status: TelegramSessionStatus;
  isCodeViaApp?: boolean;
  passwordHint?: string;
  resolveCode?: (code: string) => void;
  resolvePassword?: (password: string) => void;
  error?: string;
  loginPromise: Promise<void>;
}

interface GramjsClient {
  readonly connected?: boolean;
  readonly disconnected?: boolean;
  connect(): Promise<boolean>;
  start(params: {
    phoneNumber: () => Promise<string>;
    phoneCode: (isCodeViaApp?: boolean) => Promise<string>;
    password: (hint?: string) => Promise<string>;
    onError: (error: Error) => void;
  }): Promise<void>;
  disconnect(): Promise<void>;
  isUserAuthorized(): Promise<boolean>;
  getMe(): Promise<{ phone?: string | number | bigint }>;
  getDialogs(params: { limit: number }): Promise<GramjsDialog[]>;
  iterMessages(entity: unknown, params: { limit: number }): AsyncIterable<GramjsMessage>;
}

interface GramjsDialog {
  id?: string | number | bigint;
  title?: string;
  name?: string;
  entity?: unknown & { id?: string | number | bigint };
  inputEntity?: unknown & { channelId?: string | number | bigint };
  isChannel?: boolean;
  isGroup?: boolean;
  unreadCount?: number;
}

interface GramjsMessage {
  id?: string | number | bigint;
  date?: number;
  message?: string;
  getReplyMessage?: () => Promise<GramjsMessage | undefined>;
  sender?: {
    username?: string;
    firstName?: string;
  };
}

class GramjsTelegramAdapter implements TelegramAdapter {
  name = "gramjs";
  private readonly pending = new Map<string, PendingLogin>();
  private readonly clients = new Map<string, GramjsClient>();
  private readonly dialogEntities = new Map<string, unknown>();
  private readonly lastContactAt = new Map<string, number>();
  private readonly sessionDir = process.env.TELEGRAM_SESSION_DIR ?? "data/telegram-sessions";

  async startLogin(input: TelegramLoginStartInput) {
    const [{ TelegramClient }, { StringSession }] = await Promise.all([
      import("telegram"),
      import("telegram/sessions"),
    ]);
    let sessionString = await this.readSession(input.appSessionId);
    let session = new StringSession(sessionString);
    let client = new TelegramClient(
      session,
      Number(input.apiId),
      input.apiHash,
      GRAMJS_CLIENT_OPTIONS,
    ) as unknown as GramjsClient;

    if (sessionString && !(await this.sessionMatchesPhone(client, input.phone))) {
      await client.disconnect().catch(() => undefined);
      sessionString = "";
      session = new StringSession("");
      client = new TelegramClient(
        session,
        Number(input.apiId),
        input.apiHash,
        GRAMJS_CLIENT_OPTIONS,
      ) as unknown as GramjsClient;
    }

    const pending: PendingLogin = {
      client,
      session,
      status: "DISCONNECTED" as TelegramSessionStatus,
      loginPromise: Promise.resolve(),
    };
    this.pending.set(input.appSessionId, pending);

    pending.loginPromise = client
      .start({
        phoneNumber: async () => input.phone,
        phoneCode: async (isCodeViaApp?: boolean) => {
          pending.status = "CODE_REQUIRED";
          pending.isCodeViaApp = Boolean(isCodeViaApp);
          return await new Promise<string>((resolve) => {
            pending.resolveCode = resolve;
          });
        },
        password: async (hint?: string) => {
          pending.status = "PASSWORD_REQUIRED";
          pending.passwordHint = hint;
          return await new Promise<string>((resolve) => {
            pending.resolvePassword = resolve;
          });
        },
        onError: (error: Error) => {
          pending.error = error.message;
        },
      })
      .then(async () => {
        pending.status = "CONNECTED";
        await this.writeSession(input.appSessionId, session.save());
        this.clients.set(input.appSessionId, client);
      })
      .catch((error: Error) => {
        pending.error = error.message;
        throw error;
      });

    await this.waitForState(input.appSessionId, [
      "CODE_REQUIRED",
      "PASSWORD_REQUIRED",
      "CONNECTED",
    ]);
    return {
      status: pending.status,
      isCodeViaApp: pending.isCodeViaApp,
      passwordHint: pending.passwordHint,
    };
  }

  async submitCode(sessionId: string, code: string) {
    const pending = this.requirePending(sessionId);
    if (!pending.resolveCode) {
      throw new Error("Telegram code was not requested for this session");
    }
    pending.resolveCode(code);
    pending.resolveCode = undefined;
    await this.waitForState(sessionId, ["PASSWORD_REQUIRED", "CONNECTED"]);
    return { status: pending.status, passwordHint: pending.passwordHint };
  }

  async submitPassword(sessionId: string, password: string) {
    const pending = this.requirePending(sessionId);
    if (!pending.resolvePassword) {
      throw new Error("Telegram 2FA password was not requested for this session");
    }
    pending.resolvePassword(password);
    pending.resolvePassword = undefined;
    await pending.loginPromise;
    return { status: pending.status };
  }

  async disconnect(sessionId: string) {
    const pending = this.pending.get(sessionId);
    const client = pending?.client ?? this.clients.get(sessionId);
    if (client?.disconnect) {
      await client.disconnect();
    }
    this.pending.delete(sessionId);
    this.clients.delete(sessionId);
    await unlink(join(this.sessionDir, `${sessionId}.json`)).catch(() => undefined);
  }

  async listDialogs(sessionId: string): Promise<TelegramDialog[]> {
    const client = await this.connectedClient(sessionId);
    const dialogs = await client.getDialogs({ limit: 100 });
    this.markContact(sessionId);
    return dialogs.map((dialog) => {
      const id = String(dialog.id ?? dialog.entity?.id ?? dialog.inputEntity?.channelId);
      this.dialogEntities.set(
        this.dialogKey(sessionId, id),
        dialog.entity ?? dialog.inputEntity ?? dialog,
      );
      return {
        id,
        title: String(dialog.title ?? dialog.name ?? id),
        type: dialog.isChannel ? "channel" : dialog.isGroup ? "group" : "user",
        unreadCount: Number(dialog.unreadCount ?? 0),
      };
    });
  }

  async fetchRecentMessages(
    sessionId: string,
    dialogId: string,
    limit: number,
    options: TelegramFetchOptions = {},
  ) {
    const client = await this.connectedClient(sessionId);
    const entity = await this.resolveDialogEntity(client, sessionId, dialogId);
    const messages: TelegramCapturedMessage[] = [];
    const fromTime = options.dateFrom ? new Date(options.dateFrom).getTime() : undefined;
    const toTime = options.dateTo ? new Date(options.dateTo).getTime() : undefined;
    const offsetDate = options.offsetDate ?? options.dateTo;
    for await (const message of client.iterMessages(entity, {
      limit,
      offsetDate: offsetDate ? Math.floor(new Date(offsetDate).getTime() / 1000) : undefined,
    } as { limit: number; offsetDate?: number })) {
      const rawText = String(message.message ?? "").trim();
      if (!rawText) continue;
      const messageDate = message.date
        ? new Date(message.date * 1000).toISOString()
        : new Date().toISOString();
      const messageTime = new Date(messageDate).getTime();
      if (toTime !== undefined && messageTime > toTime) continue;
      if (fromTime !== undefined && messageTime < fromTime) break;
      const quoted = await message.getReplyMessage?.();
      const quotedText = String(quoted?.message ?? "").trim();
      messages.push({
        telegramMessageId: String(message.id),
        messageDate,
        rawText,
        quotedText: quotedText || undefined,
        senderName: message.sender?.username ?? message.sender?.firstName,
      });
    }
    this.markContact(sessionId);
    return messages;
  }

  private async resolveDialogEntity(client: GramjsClient, sessionId: string, dialogId: string) {
    const key = this.dialogKey(sessionId, dialogId);
    const cached = this.dialogEntities.get(key);
    if (cached) return cached;

    const dialogs = await client.getDialogs({ limit: 100 });
    for (const dialog of dialogs) {
      const id = String(dialog.id ?? dialog.entity?.id ?? dialog.inputEntity?.channelId);
      this.dialogEntities.set(
        this.dialogKey(sessionId, id),
        dialog.entity ?? dialog.inputEntity ?? dialog,
      );
    }
    return this.dialogEntities.get(key) ?? dialogId;
  }

  private async connectedClient(sessionId: string) {
    const pending = this.pending.get(sessionId);
    if (pending) {
      await pending.loginPromise;
      if (pending.error) throw new Error(pending.error);
      return pending.client;
    }

    // Return the cached client as-is. GramJS reconnects the transport on its own
    // with the configured options above, and its
    // connection getters misreport on a working client, so we do NOT health-check
    // or rebuild here: doing so caused a reconnect storm. A genuine stall is
    // surfaced via sessionHealth (contact recency) for the operator instead.
    const existing = this.clients.get(sessionId);
    if (existing) return existing;

    const sessionString = await this.readSession(sessionId);
    if (!sessionString) {
      throw new Error("No saved Telegram session is available for this profile");
    }
    const client = await this.createClient(sessionString);
    await client.connect();
    this.clients.set(sessionId, client);
    this.markContact(sessionId);
    return client;
  }

  private async createClient(sessionString: string): Promise<GramjsClient> {
    const apiId = process.env.TELEGRAM_API_ID;
    const apiHash = process.env.TELEGRAM_API_HASH;
    if (!apiId || !apiHash) {
      throw new Error(
        "TELEGRAM_API_ID and TELEGRAM_API_HASH are required to reuse a saved session",
      );
    }
    const [{ TelegramClient }, { StringSession }] = await Promise.all([
      import("telegram"),
      import("telegram/sessions"),
    ]);
    return new TelegramClient(
      new StringSession(sessionString),
      Number(apiId),
      apiHash,
      GRAMJS_CLIENT_OPTIONS,
    ) as unknown as GramjsClient;
  }

  private markContact(sessionId: string) {
    this.lastContactAt.set(sessionId, Date.now());
  }

  sessionHealth(sessionId: string): TelegramSessionHealth {
    const last = this.lastContactAt.get(sessionId);
    const stalledSeconds = last !== undefined ? Math.floor((Date.now() - last) / 1000) : undefined;
    // Health is judged by how recently a Telegram RPC actually succeeded, not by
    // gramjs connection getters (which misreport). A session that has not made
    // contact yet (no lastContactAt) reports not-connected but not stalled, so a
    // fresh boot doesn't raise a false alarm before its first poll lands.
    const stalled = stalledSeconds !== undefined && stalledSeconds > TELEGRAM_STALL_SECONDS;
    const connected = stalledSeconds !== undefined && !stalled;
    return {
      sessionId,
      connected,
      lastContactAt: last !== undefined ? new Date(last).toISOString() : undefined,
      stalledSeconds,
      stalled,
    };
  }

  private requirePending(sessionId: string) {
    const pending = this.pending.get(sessionId);
    if (!pending) {
      throw new Error("No active Telegram login session is available on this server");
    }
    if (pending.error) {
      throw new Error(pending.error);
    }
    return pending;
  }

  private async waitForState(
    sessionId: string,
    states: TelegramSessionStatus[],
    timeoutMs = 30_000,
  ) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const pending = this.requirePending(sessionId);
      if (states.includes(pending.status)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for Telegram state: ${states.join(", ")}`);
  }

  private async readSession(sessionId: string) {
    try {
      return await readFile(join(this.sessionDir, `${sessionId}.json`), "utf8");
    } catch {
      return await this.importExistingSession(sessionId);
    }
  }

  private async importExistingSession(sessionId: string) {
    const explicitPath = process.env.TELEGRAM_SESSION_FILE;
    if (explicitPath) {
      const sessionString = await readFile(explicitPath, "utf8");
      await this.writeSession(sessionId, sessionString.trim());
      return sessionString.trim();
    }

    if (process.env.TELEGRAM_IMPORT_EXISTING_SESSION !== "true") return "";

    try {
      const files = (await readdir(this.sessionDir)).filter((file) => file.endsWith(".json"));
      if (files.length !== 1) return "";
      const sessionString = (await readFile(join(this.sessionDir, files[0]!), "utf8")).trim();
      await this.writeSession(sessionId, sessionString);
      return sessionString;
    } catch {
      return "";
    }
  }

  private async sessionMatchesPhone(client: GramjsClient, requestedPhone: string) {
    try {
      await client.connect();
      if (!(await client.isUserAuthorized())) return false;
      const me = await client.getMe();
      return normalizePhone(String(me.phone ?? "")) === normalizePhone(requestedPhone);
    } catch {
      return false;
    }
  }

  private async writeSession(sessionId: string, sessionString: string) {
    await mkdir(this.sessionDir, { recursive: true });
    await writeFile(join(this.sessionDir, `${sessionId}.json`), sessionString, {
      mode: 0o600,
    });
  }

  private dialogKey(sessionId: string, dialogId: string) {
    return `${sessionId}:${dialogId}`;
  }
}

export function demoDialogs(): TelegramDialog[] {
  return [
    { id: "dialog-alpha", title: "Alpha FX Signals", type: "channel", unreadCount: 4 },
    { id: "dialog-gold", title: "Gold Room London", type: "group", unreadCount: 2 },
    { id: "dialog-index", title: "Index Scalps", type: "channel", unreadCount: 0 },
  ];
}

export function demoMessages(): TelegramCapturedMessage[] {
  const samples = [
    "BUY EURUSD @ 1.0850\nSL 1.0810\nTP1 1.0900\nTP2 1.0950\nTP3 1.1000\nTP4 1.1050",
    "Move SL to BE EURUSD",
    "Close 50% Gold",
    "Cancel pending EURUSD",
  ];
  return samples.map((rawText, index) => ({
    telegramMessageId: String(9000 + index),
    messageDate: new Date(Date.now() - index * 60_000).toISOString(),
    rawText,
    senderName: "Alpha FX Signals",
  }));
}

function normalizePhone(phone: string) {
  return phone.replace(/\D/g, "").replace(/^00/, "");
}
