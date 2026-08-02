import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import {
  createTelegramAdapter,
  createTeleprotoClient,
  TELEPROTO_CLIENT_OPTIONS,
  type TelegramCapturedMessage,
  type TeleprotoClient,
  telegramLogLevel,
} from "./telegram";

// Every adapter in this file is signed in through the public surface: startLogin,
// then submitCode, with the injectable client factory standing in for the socket.
// Nothing reaches into the adapter for a shortcut, and nothing can: the state
// that decides which client an RPC reaches is `#`-private. The shortcut is what
// let the same post-login lookup defect ship four times, because a test that
// seeds a client never runs the code that publishes one. Now a fetch test only
// sees messages if the login path put the client there itself.
const LOGIN_INPUT = {
  appSessionId: "session",
  profileId: "profile-fetch",
  apiId: "12345",
  apiHash: "api-hash",
  phone: "+27821234567",
};

// Every member of TeleprotoTelegramAdapter that must stay unreachable: the state
// that decides which client an RPC reaches, and each method that reads or
// publishes it. The guards below assert the adapter's private members are
// exactly this set, so a field or method that stops being private fails here,
// and one added without being listed fails too. An earlier version of this list
// held only the eight session-keyed maps and the guard merely counted what it
// found, which meant reverting `#writeSequence` to `private` left both guards
// green: a primed sequence lets an abandoned write reuse a staging target and
// publish the wrong session, which is the resurrection the staging design exists
// to prevent.
const PRIVATE_ADAPTER_MEMBERS = [
  // State.
  "pending",
  "clients",
  "sessionClients",
  "sessionEpochs",
  "sessionFileEpochs",
  "unremovedSessions",
  "teardowns",
  "sessionFileLocks",
  "writeSequence",
  "sessionDir",
  "createClientFor",
  // Methods. A prototype method is shadowed by an own property of the same
  // name, so leaving any of these public-by-omission reopens the bypass.
  "sessionEpoch",
  "retireSession",
  "sessionMoved",
  "openTeardownWindow",
  "admitRestore",
  "trackClient",
  "withSessionFile",
  "runTeardown",
  "removeSessionFile",
  "connectedClient",
  "publishedClient",
  "createClient",
  "requirePending",
  "waitForState",
  "readSession",
  "importExistingSession",
  "sessionMatchesPhone",
  "writeSession",
  "persistSession",
];

const sessionDirs: string[] = [];
const savedEnv = {
  sessionFile: process.env.TELEGRAM_SESSION_FILE,
  importExisting: process.env.TELEGRAM_IMPORT_EXISTING_SESSION,
};

beforeEach(() => {
  // A login imports whatever these point at, which would put a session on disk
  // for reasons that have nothing to do with the test running.
  delete process.env.TELEGRAM_SESSION_FILE;
  delete process.env.TELEGRAM_IMPORT_EXISTING_SESSION;
});

afterEach(async () => {
  if (savedEnv.sessionFile === undefined) delete process.env.TELEGRAM_SESSION_FILE;
  else process.env.TELEGRAM_SESSION_FILE = savedEnv.sessionFile;
  if (savedEnv.importExisting === undefined) delete process.env.TELEGRAM_IMPORT_EXISTING_SESSION;
  else process.env.TELEGRAM_IMPORT_EXISTING_SESSION = savedEnv.importExisting;
  for (const dir of sessionDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

// Signs a client in for real and hands back the adapter that published it. The
// client opens no socket and asks for its phone code in the same turn start() is
// called, so the login reaches CODE_REQUIRED without waiting on a timer.
async function signedInAdapter(transport: Pick<TeleprotoClient, "getDialogs" | "iterMessages">) {
  const sessionDir = await mkdtemp(join(tmpdir(), "tg-fetch-"));
  sessionDirs.push(sessionDir);
  const client: TeleprotoClient = {
    connect: async () => true,
    start: async (params) => {
      await params.phoneCode(true);
    },
    disconnect: async () => {},
    isUserAuthorized: async () => true,
    getMe: async () => ({ phone: LOGIN_INPUT.phone }),
    ...transport,
  };
  const adapter = createTelegramAdapter("gramjs", {
    sessionDir,
    createClient: async () => client,
  });

  expect((await adapter.startLogin(LOGIN_INPUT)).status).toBe("CODE_REQUIRED");
  expect((await adapter.submitCode(LOGIN_INPUT.appSessionId, "11111")).status).toBe("CONNECTED");
  return adapter;
}

async function* messagesWith(
  replyToMsgId?: string | number | bigint,
  fwdFrom?: { fromId?: unknown; fromName?: string; date?: number },
) {
  yield {
    id: 42,
    date: 1_784_344_000,
    message: "BUY XAUUSD",
    replyTo: replyToMsgId === undefined ? undefined : { replyToMsgId },
    fwdFrom,
    getReplyMessage: async () => undefined,
  };
}

async function teleprotoAdapterWithReply(
  replyToMsgId?: string | number | bigint,
  fwdFrom?: { fromId?: unknown; fromName?: string; date?: number },
) {
  return await signedInAdapter({
    getDialogs: async () => [{ id: "dialog", entity: { id: "dialog" } }],
    iterMessages: () => messagesWith(replyToMsgId, fwdFrom),
  });
}

describe("teleproto reply-link capture", () => {
  test("captures replyToMessageId from the structured reply header", async () => {
    const adapter = await teleprotoAdapterWithReply(7n);
    const { messages } = await adapter.fetchRecentMessages("session", "dialog", 1);

    expect(messages[0]).toMatchObject({ replyToMessageId: "7", quotedText: undefined });
  });

  test("leaves replyToMessageId undefined when the reply header is absent", async () => {
    const adapter = await teleprotoAdapterWithReply();
    const { messages } = await adapter.fetchRecentMessages("session", "dialog", 1);

    expect(messages[0]?.replyToMessageId).toBeUndefined();
  });

  test("round-trips forwarded metadata and leaves it null for ordinary messages", async () => {
    const forwardedAdapter = await teleprotoAdapterWithReply(undefined, {
      fromId: { channelId: 991n },
      fromName: "VIP Gold",
      date: 1_784_344_000,
    });
    const { messages: forwarded } = await forwardedAdapter.fetchRecentMessages(
      "session",
      "dialog",
      1,
    );
    const ordinaryAdapter = await teleprotoAdapterWithReply();
    const { messages: ordinary } = await ordinaryAdapter.fetchRecentMessages(
      "session",
      "dialog",
      1,
    );

    expect(forwarded[0]).toMatchObject({
      forwardedFrom: { peer: "channelId:991", name: "VIP Gold" },
      forwardedDate: "2026-07-18T03:06:40.000Z",
    });
    expect(ordinary[0]?.forwardedFrom).toBeUndefined();
    expect(ordinary[0]?.forwardedDate).toBeUndefined();
  });
});

describe("mock Telegram adapter", () => {
  test("keeps deterministic local dialogs and messages", async () => {
    const adapter = createTelegramAdapter("mock");
    const dialogs = await adapter.listDialogs("local");
    const messages = await adapter.fetchRecentMessages("local", "dialog-alpha", 1);

    expect(adapter.name).toBe("mock");
    expect(dialogs).toHaveLength(3);
    expect(messages.messages[0]?.rawText).toContain("BUY EURUSD");
  });
});

function backlog(count: number) {
  const start = Date.parse("2026-07-01T00:00:00.000Z");
  return Array.from({ length: count }, (_, index) => {
    const id = count - index;
    return { id, date: Math.floor((start + id * 1_000) / 1_000), message: `signal ${id}` };
  });
}

async function teleprotoAdapterWithBacklog(messages: ReturnType<typeof backlog>) {
  const calls: Array<{ limit: number; offsetDate?: number; offsetId?: number }> = [];
  const adapter = await signedInAdapter({
    getDialogs: async () => [{ id: "dialog", entity: { id: "dialog" } }],
    iterMessages: (_entity, params) => {
      calls.push(params);
      const start =
        params.offsetId === undefined
          ? 0
          : messages.findIndex((message) => message.id < params.offsetId!);
      return (async function* () {
        for (const message of messages.slice(
          start < 0 ? messages.length : start,
          start + params.limit,
        )) {
          yield message;
        }
      })();
    },
  });
  return { adapter, calls };
}

describe("teleproto backlog pagination", () => {
  test("drains a backlog larger than one page without duplicates", async () => {
    const { adapter } = await teleprotoAdapterWithBacklog(backlog(130));
    const result = await adapter.fetchRecentMessages("session", "dialog", 50, {
      dateFrom: "2026-06-30T00:00:00.000Z",
    });

    expect(result.gap).toBeUndefined();
    expect(result.messages).toHaveLength(130);
    expect(result.messages.map((message) => message.telegramMessageId)).toEqual(
      Array.from({ length: 130 }, (_, index) => String(130 - index)),
    );
    expect(new Set(result.messages.map((message) => message.telegramMessageId)).size).toBe(130);
    expect(result.messages[0]).toMatchObject({
      telegramMessageId: "130",
      rawText: "signal 130",
      messageDate: "2026-07-01T00:02:10.000Z",
    } satisfies Partial<TelegramCapturedMessage>);
  });

  test("stops paginating once it reaches dateFrom", async () => {
    const { adapter, calls } = await teleprotoAdapterWithBacklog(backlog(130));
    const result = await adapter.fetchRecentMessages("session", "dialog", 50, {
      dateFrom: "2026-07-01T00:01:10.000Z",
    });

    expect(result.messages.map((message) => message.telegramMessageId)).toEqual(
      Array.from({ length: 61 }, (_, index) => String(130 - index)),
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ limit: 50, offsetId: 81 });
  });

  test("fetches exactly one page when dateFrom is undefined", async () => {
    const { adapter, calls } = await teleprotoAdapterWithBacklog(backlog(130));
    const result = await adapter.fetchRecentMessages("session", "dialog", 50);

    expect(result.messages.map((message) => message.telegramMessageId)).toEqual(
      Array.from({ length: 50 }, (_, index) => String(130 - index)),
    );
    expect(calls).toEqual([{ limit: 50, offsetDate: undefined }]);
  });

  test("reports a gap when the page cap truncates a drain", async () => {
    const prior = process.env.TELEGRAM_FETCH_MAX_PAGES;
    process.env.TELEGRAM_FETCH_MAX_PAGES = "2";
    try {
      const { adapter } = await teleprotoAdapterWithBacklog(backlog(130));
      const result = await adapter.fetchRecentMessages("session", "dialog", 50, {
        dateFrom: "2026-06-30T00:00:00.000Z",
      });

      expect(result.messages.map((message) => message.telegramMessageId)).toEqual(
        Array.from({ length: 100 }, (_, index) => String(130 - index)),
      );
      expect(result.gap).toEqual({
        fromIso: "2026-06-30T00:00:00.000Z",
        toIso: "2026-07-01T00:00:31.000Z",
        reason: "page-cap",
        resumeOffsetId: "31",
      });
    } finally {
      if (prior === undefined) delete process.env.TELEGRAM_FETCH_MAX_PAGES;
      else process.env.TELEGRAM_FETCH_MAX_PAGES = prior;
    }
  });

  test("a bulk import is not cut down to the poll's message cap", async () => {
    // The historical import endpoint asks for up to 50,000 with a dateFrom.
    // Before pagination it received its whole page; the caps exist to bound a
    // 2-second poll, so they must not silently truncate a caller that asked
    // for more than the poll's budget.
    const { adapter } = await teleprotoAdapterWithBacklog(backlog(2_400));
    const result = await adapter.fetchRecentMessages("session", "dialog", 5_000, {
      dateFrom: "2026-06-01T00:00:00.000Z",
    });

    expect(result.messages).toHaveLength(2_400);
    expect(result.gap).toBeUndefined();
  });

  test("reports a gap when a truncated drain captured no text at all", async () => {
    // A budget spent entirely on media/empty messages still walked through the
    // backlog. Without a gap the caller reads the pass as complete and clears
    // the resume cursor, skipping every older message permanently.
    const prior = process.env.TELEGRAM_FETCH_MAX_PAGES;
    process.env.TELEGRAM_FETCH_MAX_PAGES = "2";
    try {
      const mediaOnly = backlog(130).map((message) => ({ ...message, message: "" }));
      const { adapter } = await teleprotoAdapterWithBacklog(mediaOnly);
      const result = await adapter.fetchRecentMessages("session", "dialog", 50, {
        dateFrom: "2026-06-30T00:00:00.000Z",
      });

      expect(result.messages).toHaveLength(0);
      expect(result.gap).toEqual({
        fromIso: "2026-06-30T00:00:00.000Z",
        toIso: "2026-06-30T00:00:00.000Z",
        reason: "page-cap",
        resumeOffsetId: "31",
      });
    } finally {
      if (prior === undefined) delete process.env.TELEGRAM_FETCH_MAX_PAGES;
      else process.env.TELEGRAM_FETCH_MAX_PAGES = prior;
    }
  });

  test("returns a partial drain and resume cursor when its reply work exhausts the budget", async () => {
    const { adapter } = await teleprotoAdapterWithBacklog(
      backlog(50).map((message) => ({
        ...message,
        getReplyMessage: async () => await new Promise((resolve) => setTimeout(resolve, 5)),
      })),
    );
    const result = await adapter.fetchRecentMessages("session", "dialog", 50, {
      dateFrom: "2026-06-30T00:00:00.000Z",
      budgetMs: 12,
    });

    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages.length).toBeLessThan(50);
    expect(result.gap).toMatchObject({
      reason: "time-cap",
      resumeOffsetId: result.messages.at(-1)?.telegramMessageId,
    });
  });
});

// The body of TeleprotoTelegramAdapter and nothing else. The class is the unit
// the rule is about, so a `#` member on some other class in this file must not
// be able to stand in for one that regressed here.
async function adapterClassBody() {
  const source = await Bun.file(new URL("./telegram.ts", import.meta.url)).text();
  const start = source.indexOf("\nclass TeleprotoTelegramAdapter ");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

// Every `#` member the class declares, field or method.
function declaredPrivateMembers(classBody: string) {
  return [...classBody.matchAll(/^ {2}(?:(?:readonly|static|async|get|set) )*#(\w+)\s*[=:(<]/gm)]
    .map((match) => match[1] as string)
    .sort();
}

describe("teleproto adapter encapsulation", () => {
  // These assert an equality, not a count and not a lower bound. The version
  // before review counted what it happened to find and required at least as many
  // matches as a list that named only eight of the eleven fields, so reverting
  // `#writeSequence` to `private` left both guards green. A set comparison fails
  // in both directions: a member that stops being private disappears from the
  // derived side, and one added without being considered appears on it.
  test("the adapter's private members are exactly the ones that must stay unreachable", async () => {
    const declared = declaredPrivateMembers(await adapterClassBody());

    expect(declared).toEqual([...PRIVATE_ADAPTER_MEMBERS].sort());
  });

  test("no private member is reachable on an adapter instance", async () => {
    const declared = declaredPrivateMembers(await adapterClassBody());
    const adapter = createTelegramAdapter("gramjs");
    const seam = adapter as unknown as Record<string, Map<string, unknown> | undefined>;

    // Both doors. Nothing answers to the name, so the state cannot be read or
    // seeded, and a method cannot be shadowed by assigning an own property over
    // it: `this.#name()` resolves a private name rather than a property.
    for (const member of declared) {
      expect(seam[member]).toBeUndefined();
      expect(() => (seam[member] as Map<string, unknown>).set("session", {})).toThrow(TypeError);
    }
    expect(Object.keys(adapter).filter((key) => declared.includes(key))).toEqual([]);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(adapter))).toEqual([
      "constructor",
      "startLogin",
      "submitCode",
      "submitPassword",
      "disconnect",
      "listDialogs",
      "fetchRecentMessages",
      "resolveDialogEntity",
      "markContact",
      "sessionHealth",
      "dialogKey",
    ]);
  });

  test("no call site reaches these members by property name", async () => {
    const classBody = await adapterClassBody();

    for (const member of PRIVATE_ADAPTER_MEMBERS) {
      // Bounded, so `#sessionEpoch` is not satisfied by `#sessionEpochs`.
      expect(classBody).toMatch(new RegExp(`#${member}\\b`));
      expect(classBody).not.toMatch(new RegExp(`this\\.${member}\\b`));
    }
  });
});

describe("teleproto client compatibility", () => {
  test("defaults teleproto to error-only logging while accepting supported overrides", () => {
    expect(String(TELEPROTO_CLIENT_OPTIONS.baseLogger.logLevel)).toBe("error");
    expect(String(telegramLogLevel("warn"))).toBe("warn");
    expect(String(telegramLogLevel("invalid"))).toBe("error");
  });

  test("matches teleproto Logger filtering semantics", () => {
    const logger = new Logger(telegramLogLevel("error"));
    expect(String(logger.logLevel)).toBe("error");
    expect(logger.canSend(telegramLogLevel("error"))).toBe(true);
    expect(logger.canSend(telegramLogLevel("warn"))).toBe(false);
    expect(logger.canSend(telegramLogLevel("info"))).toBe(false);
    expect(new Logger(telegramLogLevel("none")).canSend(telegramLogLevel("error"))).toBe(false);
  });

  test("passes the configured logger to the teleproto TelegramClient construction site", async () => {
    const source = await Bun.file(new URL("./telegram.ts", import.meta.url)).text();
    expect(source.match(/new TelegramClient\([\s\S]*?TELEPROTO_CLIENT_OPTIONS,/g)).toHaveLength(1);
  });

  test("constructs a teleproto client under Bun without connecting", async () => {
    const session = new StringSession("");
    const client = await createTeleprotoClient(session, 12345, "test-api-hash");
    const internals = client as unknown as {
      _connectionRetries: number;
      _reconnectRetries: number;
      _log: Logger;
      session: StringSession;
    };

    expect(client).toBeInstanceOf(TelegramClient);
    expect(internals.session).toBe(session);
    expect(internals._connectionRetries).toBe(Number.POSITIVE_INFINITY);
    expect(internals._reconnectRetries).toBe(Number.POSITIVE_INFINITY);
    expect(internals._log).toBeInstanceOf(Logger);
    expect(String(internals._log.logLevel)).toBe("error");
  });
});

describe("teleproto StringSession compatibility", () => {
  test("loads a GramJS-format session and round-trips its connection fields", async () => {
    const authKey = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
    const address = Buffer.from("149.154.167.50");
    const addressLength = Buffer.alloc(2);
    addressLength.writeInt16BE(address.length);
    const port = Buffer.alloc(2);
    port.writeInt16BE(443);
    const sessionString = `1${Buffer.concat([
      Buffer.from([2]),
      addressLength,
      address,
      port,
      authKey,
    ]).toString("base64")}`;

    const session = new StringSession(sessionString);
    await session.load();

    expect(session.dcId).toBe(2);
    expect(session.serverAddress).toBe("149.154.167.50");
    expect(session.port).toBe(443);
    expect(session.authKey?.getKey()).toEqual(authKey);
    expect(session.save()).toBe(sessionString);
  });
});
