import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Logger } from "teleproto";
import type { Session } from "teleproto/sessions";

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

export interface TelegramForwardedFrom {
  peer?: string;
  name?: string;
}

export interface TelegramCapturedMessage {
  telegramMessageId: string;
  replyToMessageId?: string;
  messageDate: string;
  rawText: string;
  quotedText?: string;
  senderName?: string;
  forwardedFrom?: TelegramForwardedFrom;
  forwardedDate?: string;
}

export interface TelegramFetchOptions {
  dateFrom?: string;
  dateTo?: string;
  offsetDate?: string;
  offsetId?: string;
  budgetMs?: number;
}

export interface TelegramFetchGap {
  fromIso: string;
  toIso: string;
  reason: "page-cap" | "message-cap" | "time-cap";
  resumeOffsetId?: string;
}

export interface TelegramFetchResult {
  messages: TelegramCapturedMessage[];
  gap?: TelegramFetchGap;
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
  ): Promise<TelegramFetchResult>;
  sessionHealth?(sessionId: string): TelegramSessionHealth;
}

const DEFAULT_RECONNECT_RETRY_DELAY_MS = 2_000;
const MAX_RECONNECT_RETRY_DELAY_MS = 10_000;
const DEFAULT_TELEGRAM_FETCH_MAX_PAGES = 20;
const DEFAULT_TELEGRAM_FETCH_MAX_MESSAGES = 1_000;
const DEFAULT_TELEGRAM_DISCONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_TELEGRAM_SESSION_FILE_TIMEOUT_MS = 10_000;
// Session writes land here first and are renamed out. Keeping them under their
// own directory means a half-written session is never beside the real ones, and
// the legacy single-file import never has to reason about them.
const PENDING_WRITE_DIR = "pending";
const DEFAULT_TELEGRAM_LOG_LEVEL = "error";
const TELEGRAM_LOG_LEVELS = new Set(["none", "error", "warn", "info", "debug"]);

export class TelegramRpcTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Telegram RPC timed out after ${timeoutMs}ms`);
    this.name = "TelegramRpcTimeoutError";
  }
}

// The client must keep trying after a network blip. Keep this helper exported
// for the existing resilience tests, while refusing finite overrides that can
// silently stop live signal capture.
export function parseConnectionRetries(_raw: string | undefined): number {
  return Number.POSITIVE_INFINITY;
}

export function parseReconnectRetryDelay(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_RECONNECT_RETRY_DELAY_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.min(Math.floor(parsed), MAX_RECONNECT_RETRY_DELAY_MS)
    : DEFAULT_RECONNECT_RETRY_DELAY_MS;
}

// How long a disconnect waits for the transport to close before it goes on and
// removes the session anyway. Read per call so an operator can shorten it.
export function telegramDisconnectTimeoutMs(raw = process.env.TELEGRAM_DISCONNECT_TIMEOUT_MS) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_TELEGRAM_DISCONNECT_TIMEOUT_MS;
}

// How long a session-file write may take before the adapter stops waiting for
// it. A write that never returns used to hold the session's critical section,
// and with it the teardown window, for the life of the process. Bounding it
// turns an outage into a failure the caller sees. Only the write is bounded:
// see removeSessionFile for why a removal is not.
export function telegramSessionFileTimeoutMs(raw = process.env.TELEGRAM_SESSION_FILE_TIMEOUT_MS) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_TELEGRAM_SESSION_FILE_TIMEOUT_MS;
}

export function parseTelegramFetchCap(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

// The caps bound a 2-second poll, not every caller. `limit` is the caller's
// declared appetite, so a bulk import asking for 5000 messages must not be cut
// to the poll's 1000: before pagination it would have received its whole page.
function telegramFetchLimits(limit: number) {
  const configuredMaxMessages = parseTelegramFetchCap(
    process.env.TELEGRAM_FETCH_MAX_MESSAGES,
    DEFAULT_TELEGRAM_FETCH_MAX_MESSAGES,
  );
  return {
    maxPages: parseTelegramFetchCap(
      process.env.TELEGRAM_FETCH_MAX_PAGES,
      DEFAULT_TELEGRAM_FETCH_MAX_PAGES,
    ),
    maxMessages: Number.isFinite(limit)
      ? Math.max(configuredMaxMessages, limit)
      : configuredMaxMessages,
  };
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

type TelegramLogLevel = NonNullable<ConstructorParameters<typeof Logger>[0]>;

export function telegramLogLevel(raw = process.env.TELEGRAM_LOG_LEVEL): TelegramLogLevel {
  const level = raw?.trim().toLowerCase();
  return (
    level && TELEGRAM_LOG_LEVELS.has(level) ? level : DEFAULT_TELEGRAM_LOG_LEVEL
  ) as TelegramLogLevel;
}

export const TELEPROTO_CLIENT_OPTIONS = {
  connectionRetries: Number.POSITIVE_INFINITY,
  reconnectRetries: Number.POSITIVE_INFINITY,
  autoReconnect: true,
  retryDelay: parseReconnectRetryDelay(process.env.TELEGRAM_RECONNECT_RETRY_DELAY_MS),
  baseLogger: new Logger(telegramLogLevel()),
};

// How long without a successful Telegram RPC before the session is considered
// stalled. Surfaced in the status snapshot so a silent capture outage is
// visible instead of looking like "no new messages".
export const TELEGRAM_STALL_SECONDS = Number(process.env.TELEGRAM_STALL_SECONDS ?? 180);

export type TeleprotoClientFactory = (
  session: string | Session,
  apiId: number,
  apiHash: string,
) => Promise<TeleprotoClient>;

export interface TeleprotoAdapterOptions {
  // Builds the teleproto client. Injectable so a caller can drive startLogin,
  // disconnect and the rest of the public surface against a client that opens no
  // socket, rather than reaching into the adapter's own maps.
  createClient?: TeleprotoClientFactory;
  sessionDir?: string;
}

export function createTelegramAdapter(
  name = process.env.TELEGRAM_ADAPTER ?? "mock",
  options: TeleprotoAdapterOptions = {},
): TelegramAdapter {
  // "gramjs" is still accepted because that is what the deployed .env sets, and
  // anything unrecognised falls through to the mock adapter, which would stop
  // live trading silently. Do not remove it without changing the server's env
  // first. "teleproto" is the accurate name for what this actually builds.
  if (name === "teleproto" || name === "gramjs") {
    return new TeleprotoTelegramAdapter(options);
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
    return { messages: demoMessages().slice(0, limit), gap: undefined };
  }

  sessionHealth(sessionId: string): TelegramSessionHealth {
    return { sessionId, connected: true, stalled: false };
  }
}

interface PendingLogin {
  client: TeleprotoClient;
  session: { save: () => string };
  status: TelegramSessionStatus;
  isCodeViaApp?: boolean;
  passwordHint?: string;
  resolveCode?: (code: string) => void;
  resolvePassword?: (password: string) => void;
  error?: string;
  loginPromise: Promise<void>;
}

const LOGIN_CANCELLED_MESSAGE = "Telegram login was cancelled because the session was disconnected";
const SESSION_RETIRED_MESSAGE =
  "Telegram session was disconnected while its saved session was being restored";
const SESSION_FILE_STUCK_MESSAGE =
  "Telegram session file could not be removed on disconnect, so this session will not be restored";

export interface TeleprotoClient {
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
  getDialogs(params: { limit: number }): Promise<TeleprotoDialog[]>;
  iterMessages(
    entity: unknown,
    params: { limit: number; offsetDate?: number; offsetId?: number },
  ): AsyncIterable<TeleprotoMessage>;
}

interface TeleprotoDialog {
  id?: string | number | bigint;
  title?: string;
  name?: string;
  entity?: unknown & { id?: string | number | bigint };
  inputEntity?: unknown & { channelId?: string | number | bigint };
  isChannel?: boolean;
  isGroup?: boolean;
  unreadCount?: number;
}

interface TeleprotoMessage {
  id?: string | number | bigint;
  replyTo?: { replyToMsgId?: string | number | bigint };
  fwdFrom?: { fromId?: unknown; fromName?: string; date?: number };
  date?: number;
  message?: string;
  getReplyMessage?: () => Promise<TeleprotoMessage | undefined>;
  sender?: {
    username?: string;
    firstName?: string;
  };
}

class TeleprotoTelegramAdapter implements TelegramAdapter {
  // Reported through /api/health, /api/telegram/status and the dashboard. It
  // said "gramjs" for the whole of the teleproto migration, so the one field an
  // operator checks to see what is running was reporting the library we had
  // just removed.
  name = "teleproto";
  private readonly pending = new Map<string, PendingLogin>();
  private readonly clients = new Map<string, TeleprotoClient>();
  // Every client this adapter has put into a session id's service, not just the
  // one the id currently answers with. `pending` and `clients` each hold one
  // entry, so a second login on the same id displaces the first and the first
  // client used to survive the disconnect that was supposed to end the session.
  // disconnect() closes everything in here.
  private readonly sessionClients = new Map<string, Set<TeleprotoClient>>();
  private readonly dialogEntities = new Map<string, unknown>();
  private readonly lastContactAt = new Map<string, number>();
  // The lifecycle counter for a session id. disconnect() bumps it in its
  // synchronous prefix, which retires the session for every caller at once.
  // Anything that would put the session back into the adapter's state captures
  // the epoch before its awaits and refuses to publish once it has moved. One
  // check, consulted the same way by a login, a poll and a legacy import, so a
  // caller that holds no login is covered too.
  private readonly sessionEpochs = new Map<string, number>();
  // Which epoch wrote the session file that is on disk now. A login that starts
  // after a disconnect owns a newer epoch, and that disconnect must leave its
  // file alone.
  private readonly sessionFileEpochs = new Map<string, number>();
  // Session ids whose file a disconnect tried to remove and could not. The file
  // is still on disk and still authorised, so nothing may restore from it until
  // it is genuinely gone or a login has legitimately replaced it. This is a
  // refusal rather than a wait, so it cannot hold a caller open.
  private readonly unremovedSessions = new Set<string>();
  // The disconnects still tearing a session id down. The epoch alone cannot
  // cover this stretch: a caller that arrives after the bump holds a legitimately
  // current epoch, so every later epoch check waves it through even though the
  // file it just read is about to be unlinked. A restore is admitted only while
  // this is empty.
  private readonly teardowns = new Map<string, Set<Promise<void>>>();
  // Serialises everything that touches `<sessionId>.json`: a write's persist and
  // its ownership claim on one side, a disconnect's ownership decision and its
  // unlink on the other. Without it those are two steps a successor write can
  // slip between, and the file it has just written is removed under it. It is
  // also what holds a disconnect behind every write that started before it, so
  // none of them can land after the unlink and recreate the file.
  private readonly sessionFileLocks = new Map<string, Promise<unknown>>();
  // Names each session-file write apart from every other, so an abandoned write
  // and its replacement never share a target.
  private writeSequence = 0;
  private readonly sessionDir: string;
  private readonly createClientFor: TeleprotoClientFactory;

  constructor(options: TeleprotoAdapterOptions = {}) {
    this.sessionDir =
      options.sessionDir ?? process.env.TELEGRAM_SESSION_DIR ?? "data/telegram-sessions";
    this.createClientFor = options.createClient ?? createTeleprotoClient;
  }

  private sessionEpoch(sessionId: string) {
    return this.sessionEpochs.get(sessionId) ?? 0;
  }

  // Retires everything the current epoch owns and hands the caller the epoch it
  // is now working in. Monotonic, so a session id is never reused by an older
  // caller.
  private retireSession(sessionId: string) {
    const next = this.sessionEpoch(sessionId) + 1;
    this.sessionEpochs.set(sessionId, next);
    return next;
  }

  private sessionMoved(sessionId: string, epoch: number) {
    return this.sessionEpoch(sessionId) !== epoch;
  }

  // Opens the teardown window for a disconnect and hands back the closer. The
  // window is per session id and holds every disconnect in flight for it, so two
  // overlapping disconnects both have to finish before the id is admitting work
  // again.
  private openTeardownWindow(sessionId: string, teardown: Promise<void>) {
    let open = this.teardowns.get(sessionId);
    if (!open) {
      open = new Set<Promise<void>>();
      this.teardowns.set(sessionId, open);
    }
    open.add(teardown);
    return () => {
      open.delete(teardown);
      if (open.size === 0 && this.teardowns.get(sessionId) === open) {
        this.teardowns.delete(sessionId);
      }
    };
  }

  // Admission control for the one path that rebuilds a session out of the file on
  // disk. It waits every teardown window for the id out and then reads the epoch
  // in the same synchronous turn as the emptiness check, so the caller can never
  // hold the epoch of a disconnect that is still running. The re-read matters as
  // much as the wait: a disconnect that opened while we were waiting owns the id
  // just as much as the one we waited for. A file a disconnect could not remove
  // is refused outright, because waiting for it would never end.
  private async admitRestore(sessionId: string) {
    for (;;) {
      const open = this.teardowns.get(sessionId);
      if (!open?.size) {
        if (this.unremovedSessions.has(sessionId)) throw new Error(SESSION_FILE_STUCK_MESSAGE);
        return this.sessionEpoch(sessionId);
      }
      await Promise.allSettled([...open]);
    }
  }

  // Records a client as this session id's to close. Called in the same
  // synchronous turn as the publication it accompanies, so a disconnect either
  // sees the client or has already retired the epoch that produced it.
  private trackClient(sessionId: string, client: TeleprotoClient) {
    let tracked = this.sessionClients.get(sessionId);
    if (!tracked) {
      tracked = new Set<TeleprotoClient>();
      this.sessionClients.set(sessionId, tracked);
    }
    tracked.add(client);
  }

  // The critical section for `<sessionId>.json`. Entries run in the order they
  // were queued and the chain never rejects, so a failed write cannot strand the
  // lock for the callers behind it.
  private async withSessionFile<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.sessionFileLocks.get(sessionId) ?? Promise.resolve();
    const run = previous.then(action);
    const chain = run.then(
      () => undefined,
      () => undefined,
    );
    this.sessionFileLocks.set(sessionId, chain);
    try {
      return await run;
    } finally {
      if (this.sessionFileLocks.get(sessionId) === chain) this.sessionFileLocks.delete(sessionId);
    }
  }

  async startLogin(input: TelegramLoginStartInput) {
    // Captured before the first await. Reading the saved session, building the
    // client and checking the phone are all network or disk round trips, and a
    // disconnect() landing in that window used to find neither a pending login
    // nor a client, no-op, and then watch this login rewrite the session file it
    // had just unlinked. Two logins racing on one id both hold the pre-disconnect
    // epoch, so the single bump invalidates both.
    const epoch = this.sessionEpoch(input.appSessionId);

    const { StringSession } = await import("teleproto/sessions");
    let client: TeleprotoClient | undefined;
    let registered = false;
    try {
      let sessionString = await this.readSession(input.appSessionId, epoch);
      let session = new StringSession(sessionString);
      client = await this.createClientFor(session, Number(input.apiId), input.apiHash);

      if (sessionString && !(await this.sessionMatchesPhone(client, input.phone))) {
        await client.disconnect().catch(() => undefined);
        sessionString = "";
        session = new StringSession("");
        client = await this.createClientFor(session, Number(input.apiId), input.apiHash);
      }

      // Load-bearing ordering: nothing may await between this check and the
      // pending.set below. If anything did, a disconnect() could clear the maps
      // inside the gap and this login would register itself behind its back. A
      // pending entry is publication in its own right: connectedClient hands its
      // client straight to a poll.
      if (this.sessionMoved(input.appSessionId, epoch)) {
        throw new Error(LOGIN_CANCELLED_MESSAGE);
      }
      const loginClient = client;
      const pending: PendingLogin = {
        client: loginClient,
        session,
        status: "DISCONNECTED" as TelegramSessionStatus,
        loginPromise: Promise.resolve(),
      };
      this.pending.set(input.appSessionId, pending);
      // Tracked alongside the pending entry, not instead of it. A second login on
      // this id will take `pending` from under this one, and without this the
      // displaced client would still be signed in after a disconnect reported the
      // session gone.
      this.trackClient(input.appSessionId, loginClient);
      registered = true;

      pending.loginPromise = loginClient
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
          // writeSession re-checks the epoch itself, in the same turn as it
          // registers the write, so a retired login writes nothing.
          await this.writeSession(input.appSessionId, session.save(), epoch);
          // The same rule at the other end of the login: check, then mutate,
          // with no await in between. A retired login installs no client. Its
          // client is already torn down, because a disconnect() this late took
          // it from `pending`.
          if (this.sessionMoved(input.appSessionId, epoch)) return;
          this.clients.set(input.appSessionId, loginClient);
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
    } catch (error) {
      // Once the login is registered, disconnect() can reach the client through
      // `pending`. Before that this frame is the only owner, so it closes the
      // client it built.
      if (!registered) {
        await client?.disconnect().catch(() => undefined);
      }
      // A login that lost the race reports the cancellation. Without this the
      // caller sees whatever incidental error the teardown produced, usually
      // waitForState's "no active login" from the pending entry disconnect()
      // deleted, which reads as a server fault rather than an operator action.
      if (this.sessionMoved(input.appSessionId, epoch)) {
        throw new Error(LOGIN_CANCELLED_MESSAGE);
      }
      throw error;
    }
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
    // Everything that makes this session observable in memory is dropped in this
    // synchronous prefix, before the first await. The epoch bump is what retires
    // the session for callers this call cannot see: a login mid-preparation, a
    // poll parked in the middle of restoring a saved session, a legacy import.
    // They re-read the epoch at their next publish point and abandon themselves.
    const epoch = this.retireSession(sessionId);
    const closing = [...(this.sessionClients.get(sessionId) ?? [])];
    this.pending.delete(sessionId);
    this.clients.delete(sessionId);
    this.sessionClients.delete(sessionId);
    // Dropping the maps is not enough on its own. Until the file is gone a poll
    // can still read it, and a poll that starts here captures this call's own
    // epoch, so the bump does not retire it and it publishes a client whose
    // durable session this call then deletes. The window opens in the same
    // synchronous prefix as the bump and closes once the file step below has
    // finished.
    const teardown = this.runTeardown(sessionId, closing, epoch);
    const closeWindow = this.openTeardownWindow(sessionId, teardown);
    try {
      await teardown;
    } finally {
      // A teardown that threw, or one the transport timeout cut short, still
      // closes the window. Leaving it open would park every later restore for
      // this id for the life of the process.
      closeWindow();
    }
  }

  private async runTeardown(sessionId: string, closing: TeleprotoClient[], epoch: number) {
    // Every client this id ever had, closed together rather than one behind the
    // other, so a session with two of them is not held for twice the bound. The
    // session is already gone from this adapter's state, so a teardown that
    // throws, or one that never settles, must not stop the file removal below or
    // report the operator's disconnect as having failed. Without the bound a hung
    // transport left the session file on disk, which the next boot re-imports and
    // re-authorises.
    const closes = closing
      .filter((client) => typeof client.disconnect === "function")
      .map((client) =>
        withTelegramRpcTimeout(client.disconnect(), telegramDisconnectTimeoutMs()).catch(
          () => undefined,
        ),
      );
    if (closes.length) await Promise.all(closes);
    // A login that started after this disconnect legitimately owns the file now.
    // Removing it would leave a live client with no durable session, so the next
    // restart would silently lose it. Only a file this call's own epoch inherited
    // is ours to remove. Reading the owner and acting on it happen inside one
    // critical section, so a successor write cannot claim the file between the
    // decision and the unlink that carries it out, and every write that had
    // already started lands before this runs rather than recreating the file
    // afterwards. This unlink stays the only place that removes a session file.
    await this.withSessionFile(sessionId, async () => {
      const owner = this.sessionFileEpochs.get(sessionId);
      if (owner !== undefined && owner >= epoch) return;
      const failure = await this.removeSessionFile(sessionId);
      if (failure) {
        // The file is still there and still authorised. Keeping the ownership
        // record describes what is actually on disk, but it is the refusal that
        // does the work: without it the next poll finds an unowned session file
        // and adopts it, which is the resurrection this whole call exists to
        // prevent, reached by failing instead of by racing. The caller is told,
        // so nothing records a disconnect that did not happen.
        this.unremovedSessions.add(sessionId);
        throw failure;
      }
      this.sessionFileEpochs.delete(sessionId);
      this.unremovedSessions.delete(sessionId);
    });
  }

  // Removes the session file and reports a genuine failure. A file that is
  // already gone is the outcome being asked for, so ENOENT is success. Anything
  // else, a permission problem, a read-only or busy filesystem, an IO error,
  // leaves an authorised session on disk and has to be treated as one.
  //
  // Deliberately unbounded. The bound available here is a race, and a race does
  // not cancel: a removal it gave up on carries on and deletes whatever is at
  // this path when it lands, which by then can be the file of a login that
  // replaced the session. A write can be made safe to abandon by giving it a
  // private target, and it is; a removal cannot, because its target is the live
  // path itself. A removal that never returns therefore holds the session's
  // critical section, which is where it was held before this lane and is the one
  // failure a caller waits on rather than hears about.
  private async removeSessionFile(sessionId: string) {
    try {
      await unlink(join(this.sessionDir, `${sessionId}.json`));
      return undefined;
    } catch (error) {
      const removed = (error as NodeJS.ErrnoException).code === "ENOENT";
      return removed ? undefined : (error as Error);
    }
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
    const { maxPages, maxMessages } = telegramFetchLimits(limit);
    const startedAt = Date.now();
    let pages = 0;
    let totalMessages = 0;
    let offsetId = options.offsetId === undefined ? undefined : Number(options.offsetId);
    let oldestReachedId: number | undefined;
    let gapReason: TelegramFetchGap["reason"] | undefined;
    let reachedFromTime = false;

    for (;;) {
      if (options.budgetMs !== undefined && Date.now() - startedAt >= options.budgetMs) {
        gapReason = "time-cap";
        break;
      }
      if (pages >= maxPages) {
        gapReason = "page-cap";
        break;
      }
      let pageMessages = 0;
      let oldestId = offsetId;
      pages += 1;
      const pageOptions =
        pages === 1
          ? offsetId === undefined
            ? {
                limit,
                offsetDate: offsetDate
                  ? Math.floor(new Date(offsetDate).getTime() / 1000)
                  : undefined,
              }
            : { limit, offsetId }
          : { limit, offsetId };
      for await (const message of client.iterMessages(
        entity,
        pageOptions as { limit: number; offsetDate?: number; offsetId?: number },
      )) {
        if (options.budgetMs !== undefined && Date.now() - startedAt >= options.budgetMs) {
          gapReason = "time-cap";
          break;
        }
        if (fromTime !== undefined && totalMessages >= maxMessages) {
          gapReason = "message-cap";
          break;
        }
        pageMessages += 1;
        totalMessages += 1;
        const numericId = Number(message.id);
        if (Number.isFinite(numericId) && (oldestId === undefined || numericId < oldestId)) {
          oldestId = numericId;
        }
        if (
          Number.isFinite(numericId) &&
          (oldestReachedId === undefined || numericId < oldestReachedId)
        ) {
          oldestReachedId = numericId;
        }
        const rawText = String(message.message ?? "").trim();
        if (!rawText) continue;
        const messageDate = message.date
          ? new Date(message.date * 1000).toISOString()
          : new Date().toISOString();
        const messageTime = new Date(messageDate).getTime();
        if (toTime !== undefined && messageTime > toTime) continue;
        if (fromTime !== undefined && messageTime < fromTime) {
          reachedFromTime = true;
          break;
        }
        const quoted = await message.getReplyMessage?.();
        const quotedText = String(quoted?.message ?? "").trim();
        messages.push({
          telegramMessageId: String(message.id),
          replyToMessageId:
            message.replyTo?.replyToMsgId === undefined
              ? undefined
              : String(message.replyTo.replyToMsgId),
          messageDate,
          rawText,
          quotedText: quotedText || undefined,
          senderName: message.sender?.username ?? message.sender?.firstName,
          forwardedFrom: forwardedFrom(message.fwdFrom),
          forwardedDate: telegramDateIso(message.fwdFrom?.date),
        });
      }
      if (gapReason || reachedFromTime || pageMessages === 0 || fromTime === undefined) break;
      offsetId = oldestId;
    }
    this.markContact(sessionId);
    const oldestCaptured = messages.map((message) => message.messageDate).sort()[0];
    const resumeOffsetId = oldestReachedId === undefined ? undefined : String(oldestReachedId);
    // A truncated drain must report a gap even when it captured no text at all.
    // A budget spent entirely on media or empty messages still advanced through
    // the backlog, and without a gap the caller reads the pass as complete and
    // clears the resume cursor, skipping everything older for good.
    return {
      messages,
      gap:
        gapReason && options.dateFrom
          ? {
              fromIso: options.dateFrom,
              toIso: oldestCaptured ?? options.dateFrom,
              reason: gapReason,
              resumeOffsetId,
            }
          : undefined,
    };
  }

  private async resolveDialogEntity(client: TeleprotoClient, sessionId: string, dialogId: string) {
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
    const published = await this.publishedClient(sessionId);
    if (published) return published;

    // Restoring a saved session is three round trips long, and it publishes the
    // same two things a login does: the session file (through the legacy import
    // inside readSession) and a connected client. A poll parked here across a
    // disconnect used to rebuild both, so the epoch is captured before the first
    // await and re-read in the same turn as the clients.set below. A poll that
    // arrives while a disconnect is tearing the id down waits the teardown out
    // first, because the epoch it would otherwise capture is that disconnect's
    // own and would carry it past every check.
    const epoch = await this.admitRestore(sessionId);

    // A login that ran while we waited may already have published. Rebuilding
    // here would install a second client over the top of a live one.
    const successor = await this.publishedClient(sessionId);
    if (successor) return successor;

    const sessionString = await this.readSession(sessionId, epoch);
    if (!sessionString) {
      throw new Error("No saved Telegram session is available for this profile");
    }
    const client = await this.createClient(sessionString);
    await client.connect();
    if (this.sessionMoved(sessionId, epoch)) {
      await client.disconnect().catch(() => undefined);
      throw new Error(SESSION_RETIRED_MESSAGE);
    }
    this.clients.set(sessionId, client);
    this.trackClient(sessionId, client);
    this.markContact(sessionId);
    return client;
  }

  // Whatever this session already has, if anything. A pending login is answered
  // by waiting for it rather than by building a second client. A cached client is
  // returned as-is: teleproto reconnects the transport on its own with the
  // configured options above, and its connection getters misreport on a working
  // client, so we do NOT health-check or rebuild here: doing so caused a
  // reconnect storm. A genuine stall is surfaced via sessionHealth (contact
  // recency) for the operator instead.
  private async publishedClient(sessionId: string) {
    const pending = this.pending.get(sessionId);
    if (pending) {
      await pending.loginPromise;
      if (pending.error) throw new Error(pending.error);
      return pending.client;
    }
    return this.clients.get(sessionId);
  }

  private async createClient(sessionString: string): Promise<TeleprotoClient> {
    const apiId = process.env.TELEGRAM_API_ID;
    const apiHash = process.env.TELEGRAM_API_HASH;
    if (!apiId || !apiHash) {
      throw new Error(
        "TELEGRAM_API_ID and TELEGRAM_API_HASH are required to reuse a saved session",
      );
    }
    return this.createClientFor(sessionString, Number(apiId), apiHash);
  }

  private markContact(sessionId: string) {
    this.lastContactAt.set(sessionId, Date.now());
  }

  sessionHealth(sessionId: string): TelegramSessionHealth {
    const last = this.lastContactAt.get(sessionId);
    const stalledSeconds = last !== undefined ? Math.floor((Date.now() - last) / 1000) : undefined;
    // Health is judged by how recently a Telegram RPC actually succeeded, not by
    // teleproto connection getters (which misreport). A session that has not made
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

  // The epoch is required rather than optional. Importing a legacy session seeds
  // `<sessionId>.json`, so both of these are a way to put a session file back for
  // an id a disconnect has already cleared, and an optional parameter is how the
  // polling path came to reach them with no guard at all.
  private async readSession(sessionId: string, epoch: number) {
    try {
      return await readFile(join(this.sessionDir, `${sessionId}.json`), "utf8");
    } catch {
      return await this.importExistingSession(sessionId, epoch);
    }
  }

  private async importExistingSession(sessionId: string, epoch: number) {
    const explicitPath = process.env.TELEGRAM_SESSION_FILE;
    if (explicitPath) {
      const sessionString = (await readFile(explicitPath, "utf8")).trim();
      await this.writeSession(sessionId, sessionString, epoch);
      return sessionString;
    }

    if (process.env.TELEGRAM_IMPORT_EXISTING_SESSION !== "true") return "";

    try {
      const files = (await readdir(this.sessionDir)).filter((file) => file.endsWith(".json"));
      if (files.length !== 1) return "";
      const sessionString = (await readFile(join(this.sessionDir, files[0]!), "utf8")).trim();
      await this.writeSession(sessionId, sessionString, epoch);
      return sessionString;
    } catch {
      return "";
    }
  }

  private async sessionMatchesPhone(client: TeleprotoClient, requestedPhone: string) {
    try {
      await client.connect();
      if (!(await client.isUserAuthorized())) return false;
      const me = await client.getMe();
      return normalizePhone(String(me.phone ?? "")) === normalizePhone(requestedPhone);
    } catch {
      return false;
    }
  }

  // The single gate on the session file. Every caller that would write one comes
  // through here and has to name the epoch it is writing for, so the check and
  // the queueing it guards happen in one synchronous turn. A disconnect that
  // bumped before this point finds the write refused. One that bumps after it
  // takes the same critical section, which puts it behind this write however long
  // the write runs, and then finds the file claimed and leaves it alone if the
  // claim is newer than itself.
  private async writeSession(sessionId: string, sessionString: string, epoch: number) {
    if (this.sessionMoved(sessionId, epoch)) return;
    await this.withSessionFile(sessionId, async () => {
      // Bounded inside persistSession, for the same reason the transport close is.
      // This runs in the session's critical section and a disconnect queues behind
      // it, so a write that never returns would hold that disconnect, and the
      // teardown window with it, open for the life of the process. A write that
      // passes the bound claims nothing, because the claim is below this line, and
      // marks nothing unrestorable, because an indeterminate file is still a file
      // a later disconnect may remove.
      await this.persistSession(sessionId, sessionString);
      // Claimed only once the bytes are on disk, and in the same critical section
      // the disconnect's ownership decision takes. A claim staked before the write
      // outlives a write that failed, and the disconnect then spares the
      // pre-disconnect file believing a newer one replaced it.
      this.sessionFileEpochs.set(sessionId, epoch);
      // A login that got its own session onto disk has replaced whatever a failed
      // removal left there, so the id is restorable again.
      this.unremovedSessions.delete(sessionId);
    });
  }

  // Written beside the session file and renamed onto it, never written in place.
  // The bound below is a race and a race does not cancel: the write it gives up
  // on carries on and finishes. Writing in place meant those bytes landed on the
  // session path afterwards, which put a valid session back for an id a
  // disconnect had already finished removing. An abandoned write can only ever
  // finish onto this private name, which nothing reads, and the rename runs only
  // once the write has been seen to finish. AbortSignal is not an alternative
  // here: on this runtime an aborted writeFile rejects and still lands its bytes
  // in full, so it is the same race under a different name.
  //
  // The name is unique per write. Sharing one temp name would let an abandoned
  // write and the write that replaced it hold the same inode, and the rename
  // would then publish whichever of them finished last. The rename itself is not
  // bounded: it runs only after a write this call watched finish, so there is
  // nothing abandoned to sequence against it.
  private async persistSession(sessionId: string, sessionString: string) {
    await mkdir(this.sessionDir, { recursive: true });
    const pendingDir = join(this.sessionDir, PENDING_WRITE_DIR);
    await mkdir(pendingDir, { recursive: true });
    this.writeSequence += 1;
    const pending = join(pendingDir, `${sessionId}.json.${this.writeSequence}.tmp`);
    try {
      await withTelegramRpcTimeout(
        writeFile(pending, sessionString, { mode: 0o600 }),
        telegramSessionFileTimeoutMs(),
      );
    } catch (error) {
      // Not awaited. This only ever names this one write's private target, so a
      // removal that is slow or never returns cannot reach anything else, and
      // waiting for it would hand back the hang the bound just escaped. Removing
      // it now means an abandoned write finishes into an inode nothing can reach.
      void unlink(pending).catch(() => undefined);
      throw error;
    }
    await rename(pending, join(this.sessionDir, `${sessionId}.json`));
  }

  private dialogKey(sessionId: string, dialogId: string) {
    return `${sessionId}:${dialogId}`;
  }
}

export async function createTeleprotoClient(
  session: string | Session,
  apiId: number,
  apiHash: string,
): Promise<TeleprotoClient> {
  const [{ TelegramClient }, { StringSession }] = await Promise.all([
    import("teleproto"),
    import("teleproto/sessions"),
  ]);
  const clientSession = typeof session === "string" ? new StringSession(session) : session;
  return new TelegramClient(
    clientSession,
    apiId,
    apiHash,
    TELEPROTO_CLIENT_OPTIONS,
  ) as unknown as TeleprotoClient;
}

function forwardedFrom(header: TeleprotoMessage["fwdFrom"]): TelegramForwardedFrom | undefined {
  if (!header) return undefined;
  const peer = forwardedPeer(header.fromId);
  return {
    ...(peer ? { peer } : {}),
    ...(header.fromName ? { name: header.fromName } : {}),
  };
}

function forwardedPeer(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") return String(value);
  const peer = value as Record<string, unknown>;
  for (const key of ["channelId", "chatId", "userId", "id"]) {
    const id = peer[key];
    if (id !== undefined && id !== null) return `${key}:${String(id)}`;
  }
  return undefined;
}

function telegramDateIso(seconds: number | undefined): string | undefined {
  return seconds !== undefined && Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : undefined;
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
