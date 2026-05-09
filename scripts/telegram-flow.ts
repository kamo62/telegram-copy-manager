import { mkdir, writeFile } from "node:fs/promises";

const apiBase = process.env.TELEGRAM_TC_API_URL ?? "http://127.0.0.1:8787/api";
const statePath = "data/telegram-flow-state.json";
const targetDialog = process.env.TELEGRAM_TARGET_DIALOG ?? "KAL VIP";

interface FlowState {
  profileId: string;
  sessionId: string;
  providerId?: string;
}

const command = process.argv[2];

if (!command) {
  usage();
  process.exit(1);
}

switch (command) {
  case "start":
    await startLogin();
    break;
  case "code":
    await submitCode(requireArg("code"));
    break;
  case "password":
    await submitPassword(requireArg("password"));
    break;
  case "dialogs":
    await listDialogs();
    break;
  case "select":
    await selectKalVip();
    break;
  case "import":
    await importHistory();
    break;
  case "backtest":
    await backtest();
    break;
  default:
    usage();
    process.exit(1);
}

async function startLogin() {
  const apiId = process.env.TELEGRAM_API_ID;
  const apiHash = process.env.TELEGRAM_API_HASH;
  const phone = process.env.TELEGRAM_PHONE_NUMBER;
  if (!apiId || !apiHash || !phone) {
    throw new Error("TELEGRAM_API_ID, TELEGRAM_API_HASH, and TELEGRAM_PHONE_NUMBER are required");
  }
  const started = await postJson<FlowState & { status: string }>("/telegram/start", {
    apiId,
    apiHash,
    phone,
  });
  await saveState({ profileId: started.profileId, sessionId: started.sessionId });
  console.log(`Telegram login status: ${started.status}`);
  console.log(`Saved flow state to ${statePath}`);
  if (started.status === "CODE_REQUIRED") {
    console.log("Run: bun scripts/telegram-flow.ts code <telegram-code>");
  }
  if (started.status === "PASSWORD_REQUIRED") {
    console.log("Run: bun scripts/telegram-flow.ts password <2fa-password>");
  }
}

async function submitCode(code: string) {
  const state = await readState();
  const result = await postJson<{ status: string; profileId: string; sessionId: string }>(
    "/telegram/verify-code",
    { sessionId: state.sessionId, code },
  );
  console.log(`Telegram login status: ${result.status}`);
  if (result.status === "PASSWORD_REQUIRED") {
    console.log("Run: bun scripts/telegram-flow.ts password <2fa-password>");
    return;
  }
  if (result.status === "CONNECTED") {
    await selectKalVip();
  }
}

async function submitPassword(password: string) {
  const state = await readState();
  const result = await postJson<{ status: string }>("/telegram/submit-password", {
    sessionId: state.sessionId,
    password,
  });
  console.log(`Telegram login status: ${result.status}`);
  if (result.status === "CONNECTED") {
    await selectKalVip();
  }
}

async function listDialogs() {
  const state = await readState();
  const response = await getJson<{ dialogs: Array<{ id: string; title: string; type: string }> }>(
    `/telegram/dialogs?profileId=${encodeURIComponent(state.profileId)}`,
  );
  console.log(JSON.stringify(response.dialogs, null, 2));
}

async function selectKalVip() {
  const state = await readState();
  const dialogs = await getJson<{ dialogs: Array<{ id: string; title: string; type: string }> }>(
    `/telegram/dialogs?profileId=${encodeURIComponent(state.profileId)}`,
  );
  const dialog =
    dialogs.dialogs.find((item) => item.title.toLowerCase() === targetDialog.toLowerCase()) ??
    dialogs.dialogs.find((item) => item.title.toLowerCase().includes(targetDialog.toLowerCase())) ??
    (dialogs.dialogs.length === 1 ? dialogs.dialogs[0] : undefined);
  if (!dialog) {
    console.log(JSON.stringify(dialogs.dialogs, null, 2));
    throw new Error(`Could not find Telegram dialog '${targetDialog}'`);
  }
  const selected = await postJson<{ provider: { id: string; title: string } }>("/providers", {
    profileId: state.profileId,
    dialogId: dialog.id,
    title: dialog.title,
  });
  await saveState({ ...state, providerId: selected.provider.id });
  console.log(`Selected provider: ${selected.provider.title} (${selected.provider.id})`);
}

async function importHistory() {
  const state = await ensureProviderState();
  const dateFrom = new Date(Date.now() - 92 * 24 * 60 * 60 * 1000).toISOString();
  const result = await postJson<{
    providerId: string;
    captured: number;
    inserted: number;
    total: number;
  }>(`/providers/${state.providerId}/import-messages`, {
    dateFrom,
    limit: Number(process.env.TELEGRAM_IMPORT_LIMIT ?? 50_000),
  });
  console.log(JSON.stringify(result, null, 2));
}

async function backtest() {
  const state = await ensureProviderState();
  const dateFrom = new Date(Date.now() - 92 * 24 * 60 * 60 * 1000).toISOString();
  const result = await postJson<unknown>(`/providers/${state.providerId}/backtest`, { dateFrom });
  await mkdir("data/backtests", { recursive: true });
  const outputPath = `data/backtests/${state.providerId}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(`Wrote ${outputPath}`);
  console.log(JSON.stringify(result, null, 2));
}

async function ensureProviderState() {
  const state = await readState();
  if (state.providerId) return state;
  await selectKalVip();
  return await readState();
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await parseResponse<T>(response);
}

async function getJson<T>(path: string): Promise<T> {
  return await parseResponse<T>(await fetch(`${apiBase}${path}`));
}

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return JSON.parse(text) as T;
}

async function readState() {
  return (await Bun.file(statePath).json()) as FlowState;
}

async function saveState(state: FlowState) {
  await mkdir("data", { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function requireArg(name: string) {
  const value = process.argv[3];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function usage() {
  console.log(
    "Usage: bun scripts/telegram-flow.ts <start|code|password|dialogs|select|import|backtest>",
  );
}
