// Mutation harness for the MT5 EA's lifecycle-mark guards.
//
// MQL5 cannot be compiled or executed here, so mt5-ea-source.test.ts asserts against
// the EA source text. Those assertions are only worth anything if breaking a guard
// actually fails a test, and that is easy to get wrong: an assertion can pass for the
// wrong reason, or stop covering the line it was written for after a refactor.
//
// Each entry below breaks one guard. The run applies it, executes the EA source test,
// restores the file, and reports which test caught it. A surviving mutation means the
// guard has no real coverage and the run exits non-zero.
//
//   bun scripts/mutate-ea-guards.ts            run every mutation
//   bun scripts/mutate-ea-guards.ts ownership  run those whose id contains "ownership"
//
// This is a review aid, not part of `bun test`: it rewrites a tracked file, so it must
// never run concurrently with anything else touching mt5/TelegramTC_EA.mq5.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const EA_PATH = "mt5/TelegramTC_EA.mq5";
const TEST_PATH = "apps/api/src/mt5-ea-source.test.ts";

type Mutation = {
  id: string;
  /** What protection is removed, so a survivor reads as a finding rather than a puzzle. */
  breaks: string;
  from: string;
  to: string;
};

const mutations: Mutation[] = [
  {
    id: "ownership/delete-ungated",
    breaks: "deletes a mark without checking this session wrote it",
    from: `      if(lifecycleMarks[index].owned)
         GlobalVariableDel(lifecycleMarks[index].variable);`,
    to: "      GlobalVariableDel(lifecycleMarks[index].variable);",
  },
  {
    id: "ownership/adoption-claims-ownership",
    breaks: "adopted marks become deletable, so another account's mark can be removed",
    from: "RegisterLifecycleMark(name, identity, ticket, false, 0);",
    to: "RegisterLifecycleMark(name, identity, ticket, true, 0);",
  },
  {
    id: "ownership/revocable",
    breaks: "ownership stops ratcheting, so re-registering can strip the deletion right",
    from: "lifecycleMarks[index].owned = lifecycleMarks[index].owned || owned;",
    to: "lifecycleMarks[index].owned = owned;",
  },
  {
    id: "ownership/writer-disclaims",
    breaks: "the only writer stops claiming ownership, so nothing is ever reclaimed",
    from: "RegisterLifecycleMark(variable, LifecycleAccountIdentity(), ticket, true, TimeLocal());",
    to: "RegisterLifecycleMark(variable, LifecycleAccountIdentity(), ticket, false, TimeLocal());",
  },
  {
    id: "identity/login-only",
    breaks: "identity drops server and company, so the same number at two brokers collides",
    from: `return IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + "|" +
          AccountInfoString(ACCOUNT_SERVER) + "|" +
          AccountInfoString(ACCOUNT_COMPANY);`,
    to: "return IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN));",
  },
  {
    id: "identity/reads-scoped-by-lossy-tag",
    breaks: "reads are scoped by the 32-bit fold instead of the full identity",
    from: 'string scopedKey = LifecycleAccountIdentity() + "|" + LifecycleCommandKey(command);',
    to: 'string scopedKey = StringFormat("%08X", LifecycleAccountTag()) + "|" + LifecycleCommandKey(command);',
  },
  {
    id: "identity/off-account-entry-released",
    breaks: "an off-account entry is dropped, and only OnInit could ever restore it",
    from: `      if(!connected || !sameAccount)
         continue;`,
    to: `      if(!connected || !sameAccount)
      {
         ReleaseLifecycleMarkSlot(index);
         continue;
      }`,
  },
  {
    id: "refresh/stops-off-account",
    breaks: "an owned mark stops refreshing while the terminal is on another account",
    from: "if((lifecycleMarks[index].owned || sameAccount) && refreshDue",
    to: "if((live) && refreshDue",
  },
  {
    id: "refresh/gated-on-connection",
    breaks: "a disconnection stops refreshing, not just reclamation",
    from: "   bool connected = TerminalInfoInteger(TERMINAL_CONNECTED) != 0;",
    to: `   if(!TerminalInfoInteger(TERMINAL_CONNECTED))
      return;
   bool connected = true;`,
  },
  {
    id: "refresh/server-clock",
    breaks: "the refresh clock uses TimeCurrent, which freezes while disconnected",
    from: "   datetime now = TimeLocal();\n   // Only deciding that a position is gone",
    to: "   datetime now = TimeCurrent();\n   // Only deciding that a position is gone",
  },
  {
    id: "refresh/unconfirmed-write-advances-clock",
    breaks: "a failed rewrite still advances the clock, so the mark expires anyway",
    from: `         && GlobalVariableSet(lifecycleMarks[index].variable, (double)TimeCurrent()) != 0)
         lifecycleMarks[index].refreshedAt = now;`,
    to: `        )
      {
         GlobalVariableSet(lifecycleMarks[index].variable, (double)TimeCurrent());
         lifecycleMarks[index].refreshedAt = now;
      }`,
  },
  {
    id: "refresh/adopted-not-refreshed-on-sight",
    breaks: "an adopted mark waits a full interval, so a nearly-expired one is lost",
    from: "bool refreshDue = lifecycleMarks[index].refreshedAt == 0\n         ||",
    to: "bool refreshDue = false\n         ||",
  },
  {
    id: "reclaim/grace-removed",
    breaks: "one absent reading deletes the mark, so a reconnect blip is enough",
    from: "if(now - lifecycleMarks[index].absentSince < LIFECYCLE_MARK_ABSENT_GRACE_SECONDS)",
    to: "if(false)",
  },
  {
    id: "reclaim/command-scoped-tracked",
    breaks: "CANCEL_PENDING marks are tracked again and reclaimed on a timer",
    from: `   if(ticket == 0)
      return;
   // Just written, so its four-week clock starts now.
   RegisterLifecycleMark(variable, LifecycleAccountIdentity(), ticket, true, TimeLocal());`,
    to: "   RegisterLifecycleMark(variable, LifecycleAccountIdentity(), ticket, true, TimeLocal());",
  },
  {
    id: "adoption/login-zero-guard-removed",
    breaks: "adoption runs with no login, matching every mark under the blank identity",
    from: `   if(AccountInfoInteger(ACCOUNT_LOGIN) == 0)
   {
      Print("Telegram TC: no account login yet, lifecycle mark adoption deferred to the next sweep");
      return;
   }
   LifecycleMarksAdopted = true;
`,
    to: "",
  },
  {
    id: "adoption/no-retry-after-login-zero",
    breaks: "adoption never retries, so a startup with no login strands the whole session",
    from: `      if(!LifecycleMarksAdopted)
         RehydrateLifecycleMarks();
`,
    to: "",
  },
  {
    id: "adoption/clears-owned-entries",
    breaks: "a retry wipes owned entries, stranding variables nothing can delete",
    from: "if(lifecycleMarks[index].active && !lifecycleMarks[index].owned)",
    to: "if(lifecycleMarks[index].active)",
  },
  {
    id: "name/tag-length-unchecked",
    breaks: "the account tag segment length is not validated before adoption",
    from: "if(tagEnd != prefixLength + 8)",
    to: "if(tagEnd < 0)",
  },
  {
    id: "name/hash-length-unchecked",
    breaks: "the hash segment length is not validated before adoption",
    from: "if(hashEnd != tagEnd + 17)",
    to: "if(hashEnd < 0)",
  },
  {
    id: "name/hash-not-hex-checked",
    breaks: "the hash segment is not checked for hex digits",
    from: 'if(!IsHexRun(tagText, 8) || !IsHexRun(hashText, 16) || digits == "")',
    to: 'if(!IsHexRun(tagText, 8) || digits == "")',
  },
  {
    id: "name/ticket-roundtrip-dropped",
    breaks: "a ticket that does not read back exactly is still trusted",
    from: `   if(IntegerToString((long)ticket) != digits)
      return false;
`,
    to: "",
  },
  {
    id: "name/hex-run-accepts-anything",
    breaks: "IsHexRun recognises the hex ranges but rejects nothing outside them",
    from: `      if(!digit && !upper)
         return false;`,
    to: `      if(false)
         return false;`,
  },
  {
    id: "poll/interval-unclamped",
    breaks: "a startup poll interval beyond the expiry means the sweep never runs in time",
    from: "int clamped = MathMax(1, MathMin(MAX_POLL_SECONDS, seconds));",
    to: "int clamped = MathMax(1, seconds);",
  },
];

function runEaSourceTest() {
  const result = spawnSync("bun", ["test", TEST_PATH], { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const failing = [
    ...output.matchAll(/\(fail\) MT5 Expert Advisor source > (.+?)(?: \[[\d.]+m?s\])?$/gm),
  ].map((match) => match[1]?.trim() ?? "");
  return { caught: failing.length > 0, failing: [...new Set(failing)] };
}

const filter = process.argv[2];
const selected = filter ? mutations.filter((item) => item.id.includes(filter)) : mutations;
if (!selected.length) {
  console.error(`No mutations match "${filter}"`);
  process.exit(2);
}

const pristine = readFileSync(EA_PATH, "utf8");
const survivors: Mutation[] = [];
const missing: Mutation[] = [];

try {
  for (const mutation of selected) {
    if (!pristine.includes(mutation.from)) {
      // The guard this mutation targets has moved or been rewritten. That is a finding
      // in itself: the mutation is no longer testing what it claims to.
      missing.push(mutation);
      console.log(`STALE    ${mutation.id} — target text not found in ${EA_PATH}`);
      continue;
    }
    writeFileSync(EA_PATH, pristine.replace(mutation.from, mutation.to));
    const { caught, failing } = runEaSourceTest();
    writeFileSync(EA_PATH, pristine);
    if (caught) {
      console.log(`caught   ${mutation.id} -> ${failing.join("; ")}`);
    } else {
      survivors.push(mutation);
      console.log(`SURVIVED ${mutation.id} — ${mutation.breaks}`);
    }
  }
} finally {
  // Restore unconditionally: an interrupted run must never leave the EA mutated.
  writeFileSync(EA_PATH, pristine);
}

console.log(
  `\n${selected.length - survivors.length - missing.length}/${selected.length} caught, ` +
    `${survivors.length} survived, ${missing.length} stale`,
);
if (survivors.length || missing.length) process.exit(1);
