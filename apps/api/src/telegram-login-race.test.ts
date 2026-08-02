import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTelegramAdapter, type TelegramAdapter, type TeleprotoClient } from "./telegram";

// Every test here drives the real login path through the public adapter surface:
// startLogin, submitCode, disconnect and listDialogs. The only thing injected is
// the client factory, which is what holds a login open at a chosen point without
// seeding the adapter's own maps. Preparation windows are held with deferred
// promises or with a named pipe, never with timers.

const LOGIN_INPUT = {
  appSessionId: "session-race",
  profileId: "profile-race",
  apiId: "12345",
  apiHash: "api-hash",
  phone: "+27821234567",
};

const NO_SAVED_SESSION = "No saved Telegram session is available for this profile";
const CANCELLED = "cancelled because the session was disconnected";
const RETIRED = "disconnected while its saved session was being restored";
const FILE_STUCK = "could not be removed on disconnect";
const TIMED_OUT = "Telegram RPC timed out";

type LoginCallbacks = Parameters<TeleprotoClient["start"]>[0];

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function exists(path: string) {
  return await stat(path).then(
    () => true,
    () => false,
  );
}

// Waits on a filesystem effect rather than on a duration. A session write in
// flight is visible as a temp file beside the session file: the adapter writes
// there and renames onto the session path only once the write has finished, so
// the moment this returns the write that created it is registered and still
// running, and the session path itself is untouched.
async function waitForPendingWrite(dir: string) {
  for (let attempt = 0; attempt < 20_000; attempt += 1) {
    const staged = await readdir(join(dir, "pending")).catch(() => [] as string[]);
    const pending = staged.find((name) => name.endsWith(".tmp"));
    if (pending) return pending;
  }
  return undefined;
}

// Drains the microtask queue. A pending filesystem operation cannot settle while
// only microtasks are running, so this advances a login to its next await without
// letting a write, an unlink or waitForState's poll timer make progress.
async function drainMicrotasks() {
  for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
}

// Gives a caller that is already running every turn it needs to finish the
// filesystem work it has queued, and reports whether `path` was still there. The
// stat goes into the same pool behind whatever that caller submitted before it,
// so by the time it comes back that earlier read has been served, and the drains
// on either side let the continuations it unblocked run on to their next
// filesystem call. Nothing here waits on a duration.
async function settleQueuedReads(path: string) {
  await drainMicrotasks();
  const present = await exists(path);
  await drainMicrotasks();
  return present;
}

// The fake client never loads its session, so the string a completed login saves
// is empty and the file it writes is zero bytes. A restore refuses an empty
// session on its own account, which would mask whatever a test is actually
// holding, so tests that need a restore to get as far as building a client give
// the file the content an authorised session would have. Reading the session's
// own dialogs first is what forces its write to land, so this replaces a
// finished file rather than racing one.
// Waits out a write the adapter has abandoned, without waiting on a duration.
// The bound the adapter applies is a race, so the write it gave up on is still
// running; this probe is three times its size and is submitted into the same
// filesystem pool afterwards, so by the time the probe returns the abandoned
// write has been served and whatever it was going to do to the directory it has
// already done.
async function drainAbandonedWrite(dir: string, megabytes: number) {
  const probe = join(dir, "drain-probe.bin");
  await writeFile(probe, "A".repeat(megabytes * 1024 * 1024));
  await rm(probe, { force: true });
}

async function fillSessionFile(adapter: TelegramAdapter, path: string) {
  expect(await adapter.listDialogs(LOGIN_INPUT.appSessionId)).toHaveLength(1);
  await writeFile(path, savedSessionString());
}

// A client that opens no socket. `onStart` stands in for the phone-code and 2FA
// round trip and `onDisconnect` for a teardown that takes a while, so a test can
// hold either side of the race at any point of the real path.
function createFakeClient(
  onStart: (params: LoginCallbacks) => Promise<void> = async () => {},
  onDisconnect: () => Promise<void> = async () => {},
) {
  const calls = { start: 0, disconnect: 0, connect: 0 };
  const client: TeleprotoClient = {
    connect: async () => {
      calls.connect += 1;
      return true;
    },
    start: async (params) => {
      calls.start += 1;
      await onStart(params);
    },
    disconnect: async () => {
      calls.disconnect += 1;
      await onDisconnect();
    },
    isUserAuthorized: async () => true,
    getMe: async () => ({ phone: LOGIN_INPUT.phone }),
    getDialogs: async () => [
      {
        id: "dialog-alpha",
        title: "Alpha FX Signals",
        isChannel: true,
        unreadCount: 0,
        entity: { id: "dialog-alpha" },
      },
    ],
    iterMessages: async function* () {},
  };
  return { client, calls };
}

// A saved session in the format the operator's own session file uses, so the
// import path parses it instead of failing for an unrelated reason.
function savedSessionString() {
  const authKey = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  const address = Buffer.from("149.154.167.50");
  const addressLength = Buffer.alloc(2);
  addressLength.writeInt16BE(address.length);
  const port = Buffer.alloc(2);
  port.writeInt16BE(443);
  return `1${Buffer.concat([Buffer.from([2]), addressLength, address, port, authKey]).toString("base64")}`;
}

// Big enough that the write it triggers is still in flight while the rest of the
// test runs. That is what puts two session writes in flight at the same time
// without reaching into the adapter to hold one of them open.
function bulkySessionString(megabytes = 64) {
  return `${savedSessionString()}${"A".repeat(megabytes * 1024 * 1024)}`;
}

describe("Telegram login versus disconnect", () => {
  let sessionDir = "";
  let sessionFile = "";
  let legacyFile = "";
  let legacyPipe = "";
  let pendingWriteDir = "";
  const savedEnv = {
    sessionFile: process.env.TELEGRAM_SESSION_FILE,
    importExisting: process.env.TELEGRAM_IMPORT_EXISTING_SESSION,
    disconnectTimeout: process.env.TELEGRAM_DISCONNECT_TIMEOUT_MS,
    fileTimeout: process.env.TELEGRAM_SESSION_FILE_TIMEOUT_MS,
    apiId: process.env.TELEGRAM_API_ID,
    apiHash: process.env.TELEGRAM_API_HASH,
  };

  beforeEach(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), "tg-login-race-"));
    sessionFile = join(sessionDir, `${LOGIN_INPUT.appSessionId}.json`);
    legacyFile = join(sessionDir, "operator-session.txt");
    legacyPipe = join(sessionDir, "operator-session.pipe");
    pendingWriteDir = join(sessionDir, "pending");
    delete process.env.TELEGRAM_SESSION_FILE;
    delete process.env.TELEGRAM_IMPORT_EXISTING_SESSION;
    delete process.env.TELEGRAM_DISCONNECT_TIMEOUT_MS;
    delete process.env.TELEGRAM_SESSION_FILE_TIMEOUT_MS;
    // Restoring a saved session needs credentials the login path takes from its
    // input instead. Only the polling tests reach that branch.
    process.env.TELEGRAM_API_ID = LOGIN_INPUT.apiId;
    process.env.TELEGRAM_API_HASH = LOGIN_INPUT.apiHash;
  });

  afterEach(async () => {
    if (savedEnv.sessionFile === undefined) delete process.env.TELEGRAM_SESSION_FILE;
    else process.env.TELEGRAM_SESSION_FILE = savedEnv.sessionFile;
    if (savedEnv.importExisting === undefined) delete process.env.TELEGRAM_IMPORT_EXISTING_SESSION;
    else process.env.TELEGRAM_IMPORT_EXISTING_SESSION = savedEnv.importExisting;
    if (savedEnv.disconnectTimeout === undefined) delete process.env.TELEGRAM_DISCONNECT_TIMEOUT_MS;
    else process.env.TELEGRAM_DISCONNECT_TIMEOUT_MS = savedEnv.disconnectTimeout;
    if (savedEnv.apiId === undefined) delete process.env.TELEGRAM_API_ID;
    else process.env.TELEGRAM_API_ID = savedEnv.apiId;
    if (savedEnv.apiHash === undefined) delete process.env.TELEGRAM_API_HASH;
    else process.env.TELEGRAM_API_HASH = savedEnv.apiHash;
    if (savedEnv.fileTimeout === undefined) delete process.env.TELEGRAM_SESSION_FILE_TIMEOUT_MS;
    else process.env.TELEGRAM_SESSION_FILE_TIMEOUT_MS = savedEnv.fileTimeout;
    // A test that made the directory read-only to fail a removal has to hand it
    // back before the cleanup can run.
    await chmod(sessionDir, 0o700).catch(() => undefined);
    await rm(sessionDir, { recursive: true, force: true });
  });

  test("a disconnect inside the login preparation window leaves nothing to restore", async () => {
    const enteredFactory = deferred();
    const releaseFactory = deferred();
    const { client, calls } = createFakeClient();
    let clientsBuilt = 0;
    const adapter = createTelegramAdapter("gramjs", {
      sessionDir,
      createClient: async () => {
        clientsBuilt += 1;
        enteredFactory.resolve();
        await releaseFactory.promise;
        return client;
      },
    });

    // Deliberately not awaited: this login is held mid-preparation, before it has
    // registered anything, which is the window the disconnect used to fall into.
    const settled = adapter.startLogin(LOGIN_INPUT).then(
      () => "resolved" as const,
      (error: Error) => error,
    );
    await enteredFactory.promise;

    await adapter.disconnect(LOGIN_INPUT.appSessionId);

    expect(await exists(sessionFile)).toBe(false);
    await expect(adapter.listDialogs(LOGIN_INPUT.appSessionId)).rejects.toThrow(NO_SAVED_SESSION);

    releaseFactory.resolve();
    const outcome = await settled;

    // The session stays gone once the login that started first finishes.
    expect(await exists(sessionFile)).toBe(false);
    await expect(adapter.listDialogs(LOGIN_INPUT.appSessionId)).rejects.toThrow(NO_SAVED_SESSION);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain(CANCELLED);
    // The login never signed in, and it closed the client it had half built.
    expect(clientsBuilt).toBe(1);
    expect(calls.start).toBe(0);
    expect(calls.disconnect).toBe(1);
  });

  test("a session write already in flight cannot outlive the disconnect", async () => {
    const startReached = deferred();
    const releaseStart = deferred();
    const { client, calls } = createFakeClient(async () => {
      startReached.resolve();
      await releaseStart.promise;
    });
    const adapter = createTelegramAdapter("gramjs", {
      sessionDir,
      createClient: async () => client,
    });

    const settled = adapter.startLogin(LOGIN_INPUT).then(
      () => "resolved" as const,
      (error: Error) => error,
    );
    await startReached.promise;

    // Let the login complete and reach its session write. After the drain the
    // write is registered and its first filesystem call is in flight, so the
    // disconnect below lands in the middle of it by construction.
    releaseStart.resolve();
    await drainMicrotasks();

    await adapter.disconnect(LOGIN_INPUT.appSessionId);
    expect(await exists(sessionFile)).toBe(false);

    const outcome = await settled;
    expect(await exists(sessionFile)).toBe(false);
    await expect(adapter.listDialogs(LOGIN_INPUT.appSessionId)).rejects.toThrow(NO_SAVED_SESSION);
    expect(outcome).toBeInstanceOf(Error);
    expect(calls.disconnect).toBe(1);
  });

  test("a cancelled login does not re-import a session file for the id", async () => {
    await writeFile(legacyFile, savedSessionString());
    process.env.TELEGRAM_SESSION_FILE = legacyFile;
    const { client } = createFakeClient();
    const adapter = createTelegramAdapter("gramjs", {
      sessionDir,
      createClient: async () => client,
    });

    // The disconnect is issued in the same turn as startLogin, before the login's
    // first await resumes, so the login imports the saved session with the id
    // already disconnected.
    const settled = adapter.startLogin(LOGIN_INPUT).then(
      () => "resolved" as const,
      (error: Error) => error,
    );
    await adapter.disconnect(LOGIN_INPUT.appSessionId);

    expect(await exists(sessionFile)).toBe(false);
    const outcome = await settled;
    expect(await exists(sessionFile)).toBe(false);
    expect(outcome).toBeInstanceOf(Error);
    // Only the copy under the session directory is removed. The operator's own
    // authorised session file is left alone.
    expect(await exists(legacyFile)).toBe(true);
  });

  test("a cancelled login's teardown does not release the claim of the login after it", async () => {
    const releaseFirstStart = deferred();
    const firstStartReached = deferred();
    const first = createFakeClient(async () => {
      firstStartReached.resolve();
      await releaseFirstStart.promise;
    });
    const second = createFakeClient();
    const secondFactoryEntered = deferred();
    const releaseSecondFactory = deferred();
    const clients = [
      async () => first.client,
      async () => {
        secondFactoryEntered.resolve();
        await releaseSecondFactory.promise;
        return second.client;
      },
    ];
    let built = 0;
    const adapter = createTelegramAdapter("gramjs", {
      sessionDir,
      createClient: async () => {
        const build = clients[Math.min(built, clients.length - 1)]!;
        built += 1;
        return await build();
      },
    });

    const firstSettled = adapter.startLogin(LOGIN_INPUT).then(
      () => "resolved" as const,
      (error: Error) => error,
    );
    await firstStartReached.promise;
    await adapter.disconnect(LOGIN_INPUT.appSessionId);

    // A second login for the same id, held in its own preparation window while the
    // first login is still unwinding.
    const secondSettled = adapter.startLogin(LOGIN_INPUT).then(
      () => "resolved" as const,
      (error: Error) => error,
    );
    await secondFactoryEntered.promise;

    // The first login now finishes and forgets its own attempt. It must not take
    // the second login's claim with it, or the second login becomes invisible to
    // the disconnect below and restores the session the operator just removed.
    releaseFirstStart.resolve();
    await drainMicrotasks();
    expect(await firstSettled).toBeInstanceOf(Error);

    await adapter.disconnect(LOGIN_INPUT.appSessionId);
    releaseSecondFactory.resolve();
    const secondOutcome = await secondSettled;

    expect(await exists(sessionFile)).toBe(false);
    await expect(adapter.listDialogs(LOGIN_INPUT.appSessionId)).rejects.toThrow(NO_SAVED_SESSION);
    expect(secondOutcome).toBeInstanceOf(Error);
    expect((secondOutcome as Error).message).toContain(CANCELLED);
    expect(second.calls.start).toBe(0);
  });

  test("an undisturbed login still reaches CONNECTED and its disconnect still clears the file", async () => {
    const submitted: string[] = [];
    const { client, calls } = createFakeClient(async (params) => {
      await params.phoneNumber();
      submitted.push(await params.phoneCode(true));
    });
    const adapter = createTelegramAdapter("gramjs", {
      sessionDir,
      createClient: async () => client,
    });

    const started = await adapter.startLogin(LOGIN_INPUT);
    expect(started).toMatchObject({ status: "CODE_REQUIRED", isCodeViaApp: true });

    const verified = await adapter.submitCode(LOGIN_INPUT.appSessionId, "11111");
    expect(verified.status).toBe("CONNECTED");
    expect(submitted).toEqual(["11111"]);
    expect(await exists(sessionFile)).toBe(true);
    expect(await adapter.listDialogs(LOGIN_INPUT.appSessionId)).toHaveLength(1);

    await adapter.disconnect(LOGIN_INPUT.appSessionId);
    expect(await exists(sessionFile)).toBe(false);
    await expect(adapter.listDialogs(LOGIN_INPUT.appSessionId)).rejects.toThrow(NO_SAVED_SESSION);
    expect(calls.disconnect).toBe(1);
  });

  test("two logins in flight on one session id are both retired by one disconnect", async () => {
    const first = createFakeClient();
    const second = createFakeClient();
    const entered = [deferred(), deferred()];
    const release = [deferred(), deferred()];
    const builds = [
      async () => {
        entered[0]!.resolve();
        await release[0]!.promise;
        return first.client;
      },
      async () => {
        entered[1]!.resolve();
        await release[1]!.promise;
        return second.client;
      },
    ];
    let built = 0;
    const adapter = createTelegramAdapter("gramjs", {
      sessionDir,
      createClient: async () => {
        const build = builds[Math.min(built, builds.length - 1)]!;
        built += 1;
        return await build();
      },
    });

    // Both logins are simply in flight. Neither has been disconnected, cancelled
    // or superseded, which is the case a single claim per session id could not
    // represent: the second used to overwrite the first's claim and the first
    // then survived the disconnect.
    const firstSettled = adapter.startLogin(LOGIN_INPUT).then(
      () => "resolved" as const,
      (error: Error) => error,
    );
    await entered[0]!.promise;
    const secondSettled = adapter.startLogin(LOGIN_INPUT).then(
      () => "resolved" as const,
      (error: Error) => error,
    );
    await entered[1]!.promise;

    await adapter.disconnect(LOGIN_INPUT.appSessionId);

    release[0]!.resolve();
    release[1]!.resolve();
    const outcomes = [await firstSettled, await secondSettled];

    for (const outcome of outcomes) {
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain(CANCELLED);
    }
    // Neither login signed in, neither registered itself, and each closed the
    // client it had half built.
    expect([first.calls.start, second.calls.start]).toEqual([0, 0]);
    expect([first.calls.disconnect, second.calls.disconnect]).toEqual([1, 1]);
    expect(await exists(sessionFile)).toBe(false);
    await expect(adapter.listDialogs(LOGIN_INPUT.appSessionId)).rejects.toThrow(NO_SAVED_SESSION);
  });

  test("a poll parked inside a session restore rebuilds neither the file nor the client", async () => {
    execFileSync("mkfifo", [legacyPipe]);
    process.env.TELEGRAM_SESSION_FILE = legacyPipe;
    const { client, calls } = createFakeClient();
    const adapter = createTelegramAdapter("gramjs", {
      sessionDir,
      createClient: async () => client,
    });

    // A poll with a cold cache, so it takes the restore path: read the legacy
    // session, copy it to this id, build a client, connect, publish. This is the
    // route that had no cancellation check anywhere along it.
    const polled = adapter.listDialogs(LOGIN_INPUT.appSessionId).then(
      () => "resolved" as const,
      (error: Error) => error,
    );
    // Opening the pipe for writing only completes once the poll has opened it for
    // reading. That is the latch: the poll is parked inside the import, past the
    // point where it chose the file and before it has written anything.
    const feed = await open(legacyPipe, "w");

    await adapter.disconnect(LOGIN_INPUT.appSessionId);

    await feed.write(savedSessionString());
    await feed.close();
    const outcome = await polled;

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain(RETIRED);
    // The copy the import would have made is not there.
    expect(await exists(sessionFile)).toBe(false);
    // The client it had already connected was closed instead of published.
    expect(calls.disconnect).toBe(1);
    // With the legacy file out of the picture a later poll has nothing to find,
    // so this rejecting is proof no client was left in the adapter.
    delete process.env.TELEGRAM_SESSION_FILE;
    await expect(adapter.listDialogs(LOGIN_INPUT.appSessionId)).rejects.toThrow(NO_SAVED_SESSION);
  });

  test("a disconnect waits for every session write in flight, not only the newest", async () => {
    execFileSync("mkfifo", [legacyPipe]);
    process.env.TELEGRAM_SESSION_FILE = legacyPipe;
    const loginStarted = deferred();
    const releaseLogin = deferred();
    const { client } = createFakeClient(async () => {
      loginStarted.resolve();
      await releaseLogin.promise;
    });
    const adapter = createTelegramAdapter("gramjs", {
      sessionDir,
      createClient: async () => client,
    });

    // First write: a cold-cache poll importing the legacy session, parked on the
    // pipe so it has chosen its file and written nothing yet.
    const polled = adapter.listDialogs(LOGIN_INPUT.appSessionId).then(
      () => "resolved" as const,
      (error: Error) => error,
    );
    const feed = await open(legacyPipe, "w");

    // Second write: a login on the same id. Its own import finds nothing, because
    // the pipe is no longer the configured legacy file and the poll has not
    // created the session file yet, so its only write is the one it makes on
    // signing in.
    delete process.env.TELEGRAM_SESSION_FILE;
    const loginSettled = adapter.startLogin(LOGIN_INPUT).then(
      () => "resolved" as const,
      (error: Error) => error,
    );
    await loginStarted.promise;

    // Release the poll. Its write is tens of megabytes, so it registers first and
    // stays in flight for the rest of the test.
    await feed.write(bulkySessionString());
    await feed.close();
    expect(await waitForPendingWrite(sessionDir)).toBeDefined();
    // Each write has a private target and is published by a rename, so the two
    // writes here never share an inode and the session path shows nothing until
    // one of them completes.
    expect(await exists(sessionFile)).toBe(false);

    // The login's write registers second and finishes first. Draining its own
    // promise chain through a poll is the proof: that chain resolves only after
    // the write completed and the client was published.
    releaseLogin.resolve();
    expect(await adapter.listDialogs(LOGIN_INPUT.appSessionId)).toHaveLength(1);

    // The disconnect must not return before the poll's write has landed. If it
    // only tracked the newest write it would find nothing to wait for, because
    // the login's write has already deregistered itself.
    const order: string[] = [];
    const pollDone = polled.then(() => {
      order.push("import-write");
    });
    const disconnectDone = adapter.disconnect(LOGIN_INPUT.appSessionId).then(() => {
      order.push("disconnect");
    });
    await Promise.all([pollDone, disconnectDone]);
    await loginSettled;

    expect(order).toEqual(["import-write", "disconnect"]);
    expect(await exists(sessionFile)).toBe(false);
  });

  test("a disconnect does not delete the session file of the login that replaced it", async () => {
    const teardownReached = deferred();
    const releaseTeardown = deferred();
    const first = createFakeClient(
      async (params) => {
        await params.phoneNumber();
        await params.phoneCode(true);
      },
      async () => {
        teardownReached.resolve();
        await releaseTeardown.promise;
      },
    );
    const second = createFakeClient(async (params) => {
      await params.phoneNumber();
      await params.phoneCode(true);
    });
    let built = 0;
    const adapter = createTelegramAdapter("gramjs", {
      sessionDir,
      createClient: async () => {
        built += 1;
        return built === 1 ? first.client : second.client;
      },
    });

    await adapter.startLogin(LOGIN_INPUT);
    expect((await adapter.submitCode(LOGIN_INPUT.appSessionId, "11111")).status).toBe("CONNECTED");
    expect(await exists(sessionFile)).toBe(true);

    // The disconnect is now inside its teardown await, having already dropped
    // everything it owns.
    const disconnected = adapter.disconnect(LOGIN_INPUT.appSessionId);
    await teardownReached.promise;

    // The operator signs in again while that teardown is still running. This
    // session is newer than the disconnect, so the disconnect has no claim on it.
    await adapter.startLogin(LOGIN_INPUT);
    expect((await adapter.submitCode(LOGIN_INPUT.appSessionId, "11111")).status).toBe("CONNECTED");
    expect(await adapter.listDialogs(LOGIN_INPUT.appSessionId)).toHaveLength(1);

    releaseTeardown.resolve();
    await disconnected;

    // The successor keeps both halves of its session. Removing the file here
    // would leave a live client whose session is gone at the next restart.
    expect(await exists(sessionFile)).toBe(true);
    expect(await adapter.listDialogs(LOGIN_INPUT.appSessionId)).toHaveLength(1);
    expect(second.calls.disconnect).toBe(0);
  });

  test("a login that signs in during the disconnect's teardown publishes nothing", async () => {
    const startReached = deferred();
    const releaseStart = deferred();
    const teardownReached = deferred();
    const releaseTeardown = deferred();
    const { client, calls } = createFakeClient(
      async () => {
        startReached.resolve();
        await releaseStart.promise;
      },
      async () => {
        teardownReached.resolve();
        await releaseTeardown.promise;
      },
    );
    const adapter = createTelegramAdapter("gramjs", {
      sessionDir,
      createClient: async () => client,
    });

    const settled = adapter.startLogin(LOGIN_INPUT).then(
      () => "resolved" as const,
      (error: Error) => error,
    );
    await startReached.promise;

    const disconnected = adapter.disconnect(LOGIN_INPUT.appSessionId);
    await teardownReached.promise;

    // The login signs in while the disconnect is between dropping the session and
    // removing its file. It started before the disconnect, so neither half of it
    // may be published.
    releaseStart.resolve();
    const outcome = await settled;

    releaseTeardown.resolve();
    await disconnected;

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain(CANCELLED);
    expect(await exists(sessionFile)).toBe(false);
    await expect(adapter.listDialogs(LOGIN_INPUT.appSessionId)).rejects.toThrow(NO_SAVED_SESSION);
    expect(calls.disconnect).toBe(1);
  });

  test("a poll that starts inside the teardown window publishes nothing", async () => {
    const teardownReached = deferred();
    const releaseTeardown = deferred();
    const signedIn = createFakeClient(
      async (params) => {
        await params.phoneNumber();
        await params.phoneCode(true);
      },
      async () => {
        teardownReached.resolve();
        await releaseTeardown.promise;
      },
    );
    const restored = createFakeClient();
    let built = 0;
    const adapter = createTelegramAdapter("gramjs", {
      sessionDir,
      createClient: async () => {
        built += 1;
        return built === 1 ? signedIn.client : restored.client;
      },
    });

    await adapter.startLogin(LOGIN_INPUT);
    expect((await adapter.submitCode(LOGIN_INPUT.appSessionId, "11111")).status).toBe("CONNECTED");
    expect(await exists(sessionFile)).toBe(true);
    await fillSessionFile(adapter, sessionFile);

    // The disconnect is inside its teardown await: the maps are already cleared,
    // the epoch is already bumped, and the session file is still on disk.
    const disconnected = adapter.disconnect(LOGIN_INPUT.appSessionId);
    await teardownReached.promise;

    // A real poll, on the cold-cache restore path, admitted entirely after the
    // bump. Its epoch is the disconnect's own, so no epoch check can retire it.
    const polled = adapter.listDialogs(LOGIN_INPUT.appSessionId).then(
      () => "resolved" as const,
      (error: Error) => error,
    );
    // The teardown is still parked here and the file is still readable, so the
    // poll has as long as it needs to restore from it. It is held, not outrun.
    expect(await settleQueuedReads(sessionFile)).toBe(true);

    releaseTeardown.resolve();
    await disconnected;
    const outcome = await polled;

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain(NO_SAVED_SESSION);
    // Nothing was rebuilt, so there is no live client left holding an authorised
    // account open against a session file that no longer exists.
    expect(built).toBe(1);
    expect(restored.calls.connect).toBe(0);
    expect(await exists(sessionFile)).toBe(false);
    await expect(adapter.listDialogs(LOGIN_INPUT.appSessionId)).rejects.toThrow(NO_SAVED_SESSION);
  });

  test("a poll waits out a second disconnect that opens while it is already waiting", async () => {
    const firstTeardown = deferred();
    const releaseFirstTeardown = deferred();
    const secondTeardown = deferred();
    const releaseSecondTeardown = deferred();
    const signIn = async (params: LoginCallbacks) => {
      await params.phoneNumber();
      await params.phoneCode(true);
    };
    const first = createFakeClient(signIn, async () => {
      firstTeardown.resolve();
      await releaseFirstTeardown.promise;
    });
    const second = createFakeClient(signIn, async () => {
      secondTeardown.resolve();
      await releaseSecondTeardown.promise;
    });
    const restored = createFakeClient();
    let built = 0;
    const adapter = createTelegramAdapter("gramjs", {
      sessionDir,
      createClient: async () => {
        built += 1;
        return built === 1 ? first.client : built === 2 ? second.client : restored.client;
      },
    });

    await adapter.startLogin(LOGIN_INPUT);
    expect((await adapter.submitCode(LOGIN_INPUT.appSessionId, "11111")).status).toBe("CONNECTED");

    const firstDisconnect = adapter.disconnect(LOGIN_INPUT.appSessionId);
    await firstTeardown.promise;

    // The poll parks on the only teardown open at the time it is admitted.
    const polled = adapter.listDialogs(LOGIN_INPUT.appSessionId).then(
      () => "resolved" as const,
      (error: Error) => error,
    );
    await drainMicrotasks();

    // The operator signs in again and disconnects again, both while that poll is
    // still parked. The second disconnect is not the one the poll is waiting for.
    await adapter.startLogin(LOGIN_INPUT);
    expect((await adapter.submitCode(LOGIN_INPUT.appSessionId, "11111")).status).toBe("CONNECTED");
    await fillSessionFile(adapter, sessionFile);
    const secondDisconnect = adapter.disconnect(LOGIN_INPUT.appSessionId);
    await secondTeardown.promise;

    // The first disconnect finishes and leaves the successor's file alone. The
    // second is still parked, so a poll that stopped waiting once the first one
    // closed has all the time it needs to restore from that file.
    releaseFirstTeardown.resolve();
    await firstDisconnect;
    expect(await settleQueuedReads(sessionFile)).toBe(true);

    releaseSecondTeardown.resolve();
    await secondDisconnect;
    const outcome = await polled;

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain(NO_SAVED_SESSION);
    expect(built).toBe(2);
    expect(restored.calls.connect).toBe(0);
    expect(await exists(sessionFile)).toBe(false);
    await expect(adapter.listDialogs(LOGIN_INPUT.appSessionId)).rejects.toThrow(NO_SAVED_SESSION);
  });

  test("a disconnect keeps the successor's file when an older write is still in flight", async () => {
    const successorPipe = join(sessionDir, "successor-session.pipe");
    execFileSync("mkfifo", [legacyPipe]);
    execFileSync("mkfifo", [successorPipe]);
    process.env.TELEGRAM_SESSION_FILE = legacyPipe;
    const { client } = createFakeClient(async (params) => {
      await params.phoneNumber();
      await params.phoneCode(true);
    });
    const adapter = createTelegramAdapter("gramjs", {
      sessionDir,
      createClient: async () => client,
    });

    // A cold-cache poll importing the legacy session, parked on the pipe.
    const polled = adapter.listDialogs(LOGIN_INPUT.appSessionId).then(
      () => "resolved" as const,
      (error: Error) => error,
    );
    const feed = await open(legacyPipe, "w");
    // The next import takes the other pipe. This one has already been chosen by
    // the poll above.
    process.env.TELEGRAM_SESSION_FILE = successorPipe;

    // Tens of megabytes, so this write stays in flight for the rest of the test
    // and every ownership claim after it is racing a write that has not landed.
    await feed.write(bulkySessionString());
    await feed.close();
    expect(await waitForPendingWrite(sessionDir)).toBeDefined();
    // The bulky write has a private target and has not been published yet, so the
    // successor below writes a file of its own rather than sharing an inode.
    expect(await exists(sessionFile)).toBe(false);

    // No client and no pending login, so this disconnect goes straight to
    // draining the import write. Its drain snapshot is taken here, before the
    // successor's write exists, which is the gap the ownership decision has to
    // hold against.
    const disconnected = adapter.disconnect(LOGIN_INPUT.appSessionId);

    // The successor: a login that starts after the disconnect and imports a
    // session of its own. Its write registers second and, being small, lands
    // first. It stops at the phone code, so this file is the only one it writes.
    const started = adapter.startLogin(LOGIN_INPUT).then(
      () => "resolved" as const,
      (error: Error) => error,
    );
    const successorFeed = await open(successorPipe, "w");
    await successorFeed.write(savedSessionString());
    await successorFeed.close();

    await disconnected;
    expect(await started).toBe("resolved");
    expect(await polled).toBeInstanceOf(Error);

    // The claim on the file has to describe what is actually on disk. The older
    // write finishes last, and if it can stake its claim after the successor's,
    // the disconnect reads the file as pre-disconnect and deletes the one the
    // successor is relying on.
    expect(await exists(sessionFile)).toBe(true);
    expect((await stat(sessionFile)).size).toBe(savedSessionString().length);
  });

  test("a successor whose session write fails does not save the pre-disconnect file", async () => {
    const teardownReached = deferred();
    const releaseTeardown = deferred();
    const signIn = async (params: LoginCallbacks) => {
      await params.phoneNumber();
      await params.phoneCode(true);
    };
    const first = createFakeClient(signIn, async () => {
      teardownReached.resolve();
      await releaseTeardown.promise;
    });
    const second = createFakeClient(signIn);
    let built = 0;
    const adapter = createTelegramAdapter("gramjs", {
      sessionDir,
      createClient: async () => {
        built += 1;
        return built === 1 ? first.client : second.client;
      },
    });

    await adapter.startLogin(LOGIN_INPUT);
    expect((await adapter.submitCode(LOGIN_INPUT.appSessionId, "11111")).status).toBe("CONNECTED");
    await fillSessionFile(adapter, sessionFile);
    // A plain file sitting where session writes stage themselves. Every write
    // fails on it and the session file beside it stays removable, which is what
    // separates "the successor replaced this file" from "the successor claimed it
    // and never wrote it".
    await rm(pendingWriteDir, { recursive: true, force: true });
    await writeFile(pendingWriteDir, "not a directory");

    const disconnected = adapter.disconnect(LOGIN_INPUT.appSessionId);
    await teardownReached.promise;

    // A login that starts after the disconnect, signs in, and then fails to
    // persist. Reading its dialogs is both how the test waits for that write to
    // settle and how the failure is observed through the adapter, so it is
    // attached before the write can fail.
    await adapter.startLogin(LOGIN_INPUT);
    const successorDialogs = adapter.listDialogs(LOGIN_INPUT.appSessionId).then(
      () => "resolved" as const,
      (error: Error) => error,
    );
    await adapter.submitCode(LOGIN_INPUT.appSessionId, "11111").catch(() => undefined);
    expect(await successorDialogs).toBeInstanceOf(Error);
    expect(built).toBe(2);

    releaseTeardown.resolve();
    await disconnected;

    // Nothing replaced the pre-disconnect session, so the disconnect still has to
    // remove it. Sparing it on the strength of a claim whose write never landed is
    // how a disconnected account comes back at the next boot.
    expect(await exists(sessionFile)).toBe(false);
  });

  test("a teardown that never settles does not hold the session file or the caller", async () => {
    process.env.TELEGRAM_DISCONNECT_TIMEOUT_MS = "20";
    const { client } = createFakeClient(
      async (params) => {
        await params.phoneNumber();
        await params.phoneCode(true);
      },
      // Stands in for a transport that hangs mid-close. Never resolved.
      () => new Promise<void>(() => {}),
    );
    const adapter = createTelegramAdapter("gramjs", {
      sessionDir,
      createClient: async () => client,
    });

    await adapter.startLogin(LOGIN_INPUT);
    expect((await adapter.submitCode(LOGIN_INPUT.appSessionId, "11111")).status).toBe("CONNECTED");
    expect(await exists(sessionFile)).toBe(true);

    // Returns rather than hanging, and the durable session goes with it. Leaving
    // the file behind would let the next boot re-import and re-authorise it.
    await adapter.disconnect(LOGIN_INPUT.appSessionId);
    expect(await exists(sessionFile)).toBe(false);
    await expect(adapter.listDialogs(LOGIN_INPUT.appSessionId)).rejects.toThrow(NO_SAVED_SESSION);
  });

  test("a disconnect closes the client of a login a second login displaced", async () => {
    const firstRegistered = deferred();
    const releaseFirst = deferred();
    const secondRegistered = deferred();
    const first = createFakeClient(async (params) => {
      await params.phoneNumber();
      firstRegistered.resolve();
      await releaseFirst.promise;
    });
    const second = createFakeClient(async (params) => {
      await params.phoneNumber();
      secondRegistered.resolve();
      await params.phoneCode(true);
    });
    let built = 0;
    const adapter = createTelegramAdapter("gramjs", {
      sessionDir,
      createClient: async () => {
        built += 1;
        return built === 1 ? first.client : second.client;
      },
    });

    // The first login is past registration: the adapter is holding its client and
    // it is inside start(). start() only runs after the pending entry is set, so
    // reaching it is the proof that registration happened.
    const firstSettled = adapter.startLogin(LOGIN_INPUT).then(
      () => "resolved" as const,
      (error: Error) => error,
    );
    await firstRegistered.promise;

    // A second login on the same id registers over the top of it. Neither login
    // has been cancelled and nothing has closed the first client.
    const secondSettled = adapter.startLogin(LOGIN_INPUT).then(
      () => "resolved" as const,
      (error: Error) => error,
    );
    await secondRegistered.promise;

    await adapter.disconnect(LOGIN_INPUT.appSessionId);
    releaseFirst.resolve();

    // Both, not just the one the id currently answers with. The displaced client
    // is authorised and reconnects forever on infinite retries, so leaving it open
    // is a session that outlives the disconnect that reported it gone.
    expect([first.calls.disconnect, second.calls.disconnect]).toEqual([1, 1]);
    for (const outcome of [await firstSettled, await secondSettled]) {
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain(CANCELLED);
    }
    expect(await exists(sessionFile)).toBe(false);
    await expect(adapter.listDialogs(LOGIN_INPUT.appSessionId)).rejects.toThrow(NO_SAVED_SESSION);
  });

  test("a disconnect that cannot remove the session file refuses to restore it", async () => {
    const { client } = createFakeClient(async (params) => {
      await params.phoneNumber();
      await params.phoneCode(true);
    });
    let built = 0;
    const adapter = createTelegramAdapter("gramjs", {
      sessionDir,
      createClient: async () => {
        built += 1;
        return client;
      },
    });

    await adapter.startLogin(LOGIN_INPUT);
    expect((await adapter.submitCode(LOGIN_INPUT.appSessionId, "11111")).status).toBe("CONNECTED");
    await fillSessionFile(adapter, sessionFile);

    // A read-only directory. The session file stays readable, so a restore could
    // still adopt it, but it cannot be unlinked.
    await chmod(sessionDir, 0o500);
    const outcome = await adapter.disconnect(LOGIN_INPUT.appSessionId).then(
      () => "resolved" as const,
      (error: Error) => error,
    );

    // The operator is told the disconnect failed instead of being shown a success
    // over an authorised session that is still on disk.
    expect(outcome).toBeInstanceOf(Error);
    expect(await exists(sessionFile)).toBe(true);

    // And nothing may bring that file back into service. This rejects rather than
    // hanging, which is also the proof that the teardown window was released: a
    // refusal that waited for the removal would never return.
    await expect(adapter.listDialogs(LOGIN_INPUT.appSessionId)).rejects.toThrow(FILE_STUCK);
    expect(built).toBe(1);

    // Once the removal can succeed, a later disconnect completes and takes the
    // refusal with it.
    await chmod(sessionDir, 0o700);
    await adapter.disconnect(LOGIN_INPUT.appSessionId);
    expect(await exists(sessionFile)).toBe(false);
    await expect(adapter.listDialogs(LOGIN_INPUT.appSessionId)).rejects.toThrow(NO_SAVED_SESSION);
  });

  test("a session write that passes its bound cannot put the session back", async () => {
    process.env.TELEGRAM_SESSION_FILE_TIMEOUT_MS = "1";
    execFileSync("mkfifo", [legacyPipe]);
    process.env.TELEGRAM_SESSION_FILE = legacyPipe;
    const { client } = createFakeClient();
    const adapter = createTelegramAdapter("gramjs", {
      sessionDir,
      createClient: async () => client,
    });

    // A cold-cache poll importing the legacy session. The import is megabytes
    // wide, so its write runs orders of magnitude past the bound above.
    const polled = adapter.listDialogs(LOGIN_INPUT.appSessionId).then(
      () => "resolved" as const,
      (error: Error) => error,
    );
    const feed = await open(legacyPipe, "w");
    delete process.env.TELEGRAM_SESSION_FILE;
    await feed.write(bulkySessionString(16));
    await feed.close();

    const outcome = await polled;
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain(TIMED_OUT);

    // Giving up on the write releases the session, so the disconnect runs instead
    // of queueing behind a write nobody is waiting for any more.
    await adapter.disconnect(LOGIN_INPUT.appSessionId);
    expect(await exists(sessionFile)).toBe(false);

    // The bound is a race, and a race does not stop the write it gave up on. Once
    // that write finishes, its bytes must not be at the session path: a valid
    // session landing after a completed disconnect is the session coming back.
    await drainAbandonedWrite(sessionDir, 64);
    expect(await exists(sessionFile)).toBe(false);
    await expect(adapter.listDialogs(LOGIN_INPUT.appSessionId)).rejects.toThrow(NO_SAVED_SESSION);
  });

  test("a session write is published whole or not at all", async () => {
    execFileSync("mkfifo", [legacyPipe]);
    process.env.TELEGRAM_SESSION_FILE = legacyPipe;
    const { client } = createFakeClient();
    const adapter = createTelegramAdapter("gramjs", {
      sessionDir,
      createClient: async () => client,
    });

    const polled = adapter.listDialogs(LOGIN_INPUT.appSessionId).then(
      () => "resolved" as const,
      (error: Error) => error,
    );
    const feed = await open(legacyPipe, "w");
    delete process.env.TELEGRAM_SESSION_FILE;
    const saved = bulkySessionString(16);
    await feed.write(saved);
    await feed.close();

    // While that write is running the session path holds nothing. A restore can
    // therefore never read a half-written session, and an abandoned write has
    // nowhere to land except its own private target.
    expect(await waitForPendingWrite(sessionDir)).toBeDefined();
    expect(await exists(sessionFile)).toBe(false);

    // It appears whole, in one step, when the write is done.
    expect(await polled).toBe("resolved");
    expect((await stat(sessionFile)).size).toBe(saved.length);
  });

  test("a 2FA login reaches CONNECTED and its disconnect still clears the file", async () => {
    const submitted: string[] = [];
    const { client, calls } = createFakeClient(async (params) => {
      await params.phoneNumber();
      submitted.push(await params.phoneCode(true));
      submitted.push(await params.password("cloud hint"));
    });
    const adapter = createTelegramAdapter("gramjs", {
      sessionDir,
      createClient: async () => client,
    });

    expect(await adapter.startLogin(LOGIN_INPUT)).toMatchObject({ status: "CODE_REQUIRED" });
    const afterCode = await adapter.submitCode(LOGIN_INPUT.appSessionId, "22222");
    expect(afterCode).toMatchObject({ status: "PASSWORD_REQUIRED", passwordHint: "cloud hint" });

    const verified = await adapter.submitPassword(LOGIN_INPUT.appSessionId, "hunter2");
    expect(verified.status).toBe("CONNECTED");
    expect(submitted).toEqual(["22222", "hunter2"]);
    expect(await exists(sessionFile)).toBe(true);
    expect(await adapter.listDialogs(LOGIN_INPUT.appSessionId)).toHaveLength(1);

    await adapter.disconnect(LOGIN_INPUT.appSessionId);
    expect(await exists(sessionFile)).toBe(false);
    await expect(adapter.listDialogs(LOGIN_INPUT.appSessionId)).rejects.toThrow(NO_SAVED_SESSION);
    expect(calls.disconnect).toBe(1);
  });
});
