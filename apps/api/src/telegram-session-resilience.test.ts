import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "./app";
import { createTelegramAdapter, type TelegramAdapter, type TeleprotoClient } from "./telegram";

const savedEnv = {
  apiId: process.env.TELEGRAM_API_ID,
  apiHash: process.env.TELEGRAM_API_HASH,
  importExisting: process.env.TELEGRAM_IMPORT_EXISTING_SESSION,
  sessionFile: process.env.TELEGRAM_SESSION_FILE,
};

beforeEach(() => {
  delete process.env.TELEGRAM_API_ID;
  delete process.env.TELEGRAM_API_HASH;
  delete process.env.TELEGRAM_IMPORT_EXISTING_SESSION;
  delete process.env.TELEGRAM_SESSION_FILE;
});

afterEach(() => {
  if (savedEnv.apiId === undefined) delete process.env.TELEGRAM_API_ID;
  else process.env.TELEGRAM_API_ID = savedEnv.apiId;
  if (savedEnv.apiHash === undefined) delete process.env.TELEGRAM_API_HASH;
  else process.env.TELEGRAM_API_HASH = savedEnv.apiHash;
  if (savedEnv.importExisting === undefined) delete process.env.TELEGRAM_IMPORT_EXISTING_SESSION;
  else process.env.TELEGRAM_IMPORT_EXISTING_SESSION = savedEnv.importExisting;
  if (savedEnv.sessionFile === undefined) delete process.env.TELEGRAM_SESSION_FILE;
  else process.env.TELEGRAM_SESSION_FILE = savedEnv.sessionFile;
});

function createStubTelegram(overrides: Partial<TelegramAdapter> = {}): TelegramAdapter {
  return {
    name: "mock",
    async startLogin() {
      return { status: "CODE_REQUIRED" as const };
    },
    async submitCode() {
      return { status: "CONNECTED" as const };
    },
    async submitPassword() {
      return { status: "CONNECTED" as const };
    },
    async disconnect() {},
    async listDialogs() {
      return [];
    },
    async fetchRecentMessages() {
      return { messages: [], gap: undefined };
    },
    ...overrides,
  };
}

async function responseJson<T>(response: Response | Promise<Response>) {
  return (await response).json() as T;
}

function savedSessionString(seed: number) {
  const authKey = Buffer.from(Array.from({ length: 256 }, (_, index) => (index + seed) % 256));
  const address = Buffer.from("149.154.167.50");
  const addressLength = Buffer.alloc(2);
  addressLength.writeInt16BE(address.length);
  const port = Buffer.alloc(2);
  port.writeInt16BE(443);
  return `1${Buffer.concat([Buffer.from([2]), addressLength, address, port, authKey]).toString("base64")}`;
}

function probeClient(authorized: boolean, phone = "+27821234567") {
  const calls = { connect: 0, authorized: 0, disconnect: 0 };
  const client: TeleprotoClient = {
    connect: async () => {
      calls.connect += 1;
      return true;
    },
    start: async () => {},
    disconnect: async () => {
      calls.disconnect += 1;
    },
    isUserAuthorized: async () => {
      calls.authorized += 1;
      return authorized;
    },
    getMe: async () => ({ phone }),
    getDialogs: async () => [],
    iterMessages: async function* () {},
  };
  return { client, calls };
}

describe("Telegram stored-session recovery", () => {
  test("probes and publishes one authorized stored client, then reuses it", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "telegram-probe-"));
    try {
      await writeFile(join(sessionDir, "tg-stored.json"), "stored-session");
      const restored = probeClient(true);
      let factoryCalls = 0;
      const adapter = createTelegramAdapter("gramjs", {
        sessionDir,
        createClient: async () => {
          factoryCalls += 1;
          return restored.client;
        },
      });

      expect(await adapter.probeStoredSession?.("tg-stored", "12345", "hash")).toBe("CONNECTED");
      expect(await adapter.probeStoredSession?.("tg-stored", "12345", "hash")).toBe("CONNECTED");
      expect(factoryCalls).toBe(1);
      expect(restored.calls.connect).toBe(1);
      expect(restored.calls.authorized).toBe(2);
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  test("adopts the newest legacy JSON session when more than one exists", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "telegram-import-"));
    const oldSession = savedSessionString(1);
    const newSession = savedSessionString(2);
    try {
      const oldPath = join(sessionDir, "tg-old.json");
      const newPath = join(sessionDir, "tg-new.json");
      await writeFile(oldPath, oldSession);
      await writeFile(newPath, newSession);
      await utimes(oldPath, new Date(1_000), new Date(1_000));
      await utimes(newPath, new Date(2_000), new Date(2_000));
      process.env.TELEGRAM_IMPORT_EXISTING_SESSION = "true";
      const restored = probeClient(true);
      restored.client.start = async (params) => {
        await params.phoneCode(true);
      };
      const sessions: string[] = [];
      const adapter = createTelegramAdapter("gramjs", {
        sessionDir,
        createClient: async (session) => {
          sessions.push(
            typeof session === "string" ? session : (session as { save: () => string }).save(),
          );
          return restored.client;
        },
      });

      expect(
        (
          await adapter.startLogin({
            appSessionId: "tg-adopted",
            profileId: "profile-adopted",
            apiId: "12345",
            apiHash: "hash",
            phone: "+27821234567",
          })
        ).status,
      ).toBe("CODE_REQUIRED");
      expect(sessions).toHaveLength(1);
      expect(await readFile(join(sessionDir, "tg-adopted.json"), "utf8")).toBe(newSession);
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  test("restores matching rows at boot, audits it, and never downgrades connected rows", async () => {
    const databasePath = join(await mkdtemp(join(tmpdir(), "telegram-boot-db-")), "test.db");
    const sessionDir = await mkdtemp(join(tmpdir(), "telegram-boot-session-"));
    try {
      const seedApp = createApi({
        databasePath,
        telegram: createStubTelegram(),
        telegramPollingEnabled: false,
      });
      const started = await responseJson<{ sessionId: string; profileId: string }>(
        seedApp.request("/api/telegram/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ apiId: "12345", apiHash: "hash", phone: "+27821234567" }),
        }),
      );
      await writeFile(join(sessionDir, `${started.sessionId}.json`), "stored-session");

      process.env.TELEGRAM_API_ID = "12345";
      process.env.TELEGRAM_API_HASH = "hash";
      const restored = probeClient(true);
      const restoredApp = createApi({
        databasePath,
        telegram: createTelegramAdapter("gramjs", {
          sessionDir,
          createClient: async (session, apiId, apiHash) => {
            expect(session).toBe("stored-session");
            expect(apiId).toBe(12345);
            expect(apiHash).toBe("hash");
            return restored.client;
          },
        }),
        telegramPollingEnabled: false,
      });

      let status: { connected: boolean; telegramSessions: Array<{ id: string; status: string }> };
      for (let attempt = 0; attempt < 20; attempt += 1) {
        status = await responseJson(restoredApp.request("/api/telegram/status"));
        if (restored.calls.authorized > 0 && status.connected) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      status = await responseJson(restoredApp.request("/api/telegram/status"));
      expect(status.connected).toBe(true);
      expect(
        status.telegramSessions.find((session) => session.id === started.sessionId),
      ).toMatchObject({
        id: started.sessionId,
        status: "CONNECTED",
      });
      expect(restored.calls.connect).toBe(1);
      expect(restored.calls.authorized).toBe(1);
      const audit = await responseJson<{ logs: Array<{ eventType: string }> }>(
        restoredApp.request("/api/audit-logs?event=telegram.session.restored"),
      );
      expect(audit.logs[0]?.eventType).toBe("telegram.session.restored");

      const noDowngrade = probeClient(false);
      const noDowngradeApp = createApi({
        databasePath,
        telegram: createTelegramAdapter("gramjs", {
          sessionDir,
          createClient: async () => noDowngrade.client,
        }),
        telegramPollingEnabled: false,
      });
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (noDowngrade.calls.authorized > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const afterFailedProbe = await responseJson<typeof status>(
        noDowngradeApp.request("/api/telegram/status"),
      );
      expect(noDowngrade.calls.connect).toBe(1);
      expect(noDowngrade.calls.authorized).toBe(1);
      expect(afterFailedProbe.connected).toBe(true);
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
      await rm(join(databasePath, ".."), { recursive: true, force: true });
    }
  });

  test("reuses the connected profile first, otherwise the newest matching session", async () => {
    const root = await mkdtemp(join(tmpdir(), "telegram-reuse-"));
    const databasePath = join(root, "test.db");
    try {
      const app = createApi({
        databasePath,
        telegram: createStubTelegram(),
        telegramPollingEnabled: false,
      });
      const start = async (phone: string) =>
        await responseJson<{ sessionId: string; profileId: string }>(
          app.request("/api/telegram/start", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ apiId: "12345", apiHash: "hash", phone }),
          }),
        );

      const first = await start("+27 82 123 4567");
      const db = new Database(databasePath);
      db.query("INSERT INTO profiles (id, display_name, created_at) VALUES (?, ?, ?)").run(
        "profile-newest",
        "Newest",
        "2026-08-24T00:00:00.000Z",
      );
      db.query(
        "INSERT INTO telegram_sessions (id, profile_id, phone, api_id_hint, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "tg-newest",
        "profile-newest",
        "0027821234567",
        "api_hash",
        "CODE_REQUIRED",
        "2026-08-24T00:00:00.000Z",
        "2099-01-01T00:00:00.000Z",
      );
      db.close();

      expect(await start("+27821234567")).toMatchObject({
        sessionId: "tg-newest",
        profileId: "profile-newest",
      });

      const connectedDb = new Database(databasePath);
      connectedDb
        .query("UPDATE telegram_sessions SET status = ? WHERE id = ?")
        .run("CONNECTED", first.sessionId);
      connectedDb.close();
      expect(await start("+27821234567")).toMatchObject(first);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a stored-session probe that never settles cannot hold the ingestion gate shut", async () => {
    const databasePath = join(await mkdtemp(join(tmpdir(), "telegram-gate-db-")), "test.db");
    try {
      const seedApp = createApi({
        databasePath,
        telegram: createStubTelegram(),
        telegramPollingEnabled: false,
      });
      await seedApp.request("/api/telegram/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiId: "12345", apiHash: "hash", phone: "+27821234567" }),
      });

      process.env.TELEGRAM_API_ID = "12345";
      process.env.TELEGRAM_API_HASH = "hash";
      let probesStarted = 0;
      const wedged = createApi({
        databasePath,
        telegram: createStubTelegram({
          // Models the real hazard: connectionRetries is POSITIVE_INFINITY and
          // #admitRestore has no deadline, so a probe can hang forever.
          probeStoredSession: () => {
            probesStarted += 1;
            return new Promise<"CONNECTED" | "DISCONNECTED">(() => {});
          },
        }),
        telegramPollingEnabled: false,
        telegramRpcTimeoutMs: 50,
      });

      const result = await Promise.race([
        wedged.runTelegramIngestionOnce().then(() => "ingested" as const),
        new Promise<"blocked">((resolve) => {
          setTimeout(() => resolve("blocked"), 5_000).unref?.();
        }),
      ]);

      expect(probesStarted).toBe(1);
      expect(result).toBe("ingested");
    } finally {
      await rm(join(databasePath, ".."), { recursive: true, force: true });
    }
  });
});
