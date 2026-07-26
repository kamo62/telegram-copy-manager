import { describe, expect, test } from "bun:test";
import { type ParsedSignal, parseSignalText } from "@telegram-tc/core";
import {
  type ExecutionEvidenceInput,
  type ExecutionEvidenceVerdict,
  evaluateExecutionEvidence,
  type LifecycleResolutionEvidence,
} from "./execution-evidence";
import { corpusMessages, type ProviderMessageFixture } from "./fixtures/provider-messages";

const structuredConfig = { openEvidence: "structured-id" as const };
const proseConfig = { openEvidence: "prose-complete" as const };

function parsed(text: string, providerId = "provider-test"): ParsedSignal {
  return parseSignalText(text, {
    providerId,
    accountId: "account-test",
    accountMappings: {
      "account-test": {
        accountId: "account-test",
        includeSymbols: ["XAUUSD", "EURUSD"],
        availableBrokerSymbols: ["XAUUSD", "EURUSD"],
      },
    },
  });
}

function evidence(
  signal: ParsedSignal,
  overrides: Partial<ExecutionEvidenceInput> = {},
): ExecutionEvidenceInput {
  return {
    parsedSignal: signal,
    providerConfig: structuredConfig,
    orderIdNovelty: { providerOrderIdNeverSeen: true },
    forwarded: false,
    ...overrides,
  };
}

function lifecycle(
  method: LifecycleResolutionEvidence["method"],
  status: LifecycleResolutionEvidence["status"] = "MATCHED",
  activeTradeCount = 1,
  suggestion?: string,
): LifecycleResolutionEvidence {
  return { method, status, activeTradeCount, ...(suggestion ? { suggestion } : {}) };
}

function simulatedCorpusResolution(
  message: ProviderMessageFixture,
): LifecycleResolutionEvidence | undefined {
  if (message.replyToMessageId) return lifecycle("reply-link");
  if (/^Quoted signal:/i.test(message.rawText)) return lifecycle("inline-quote");
  return undefined;
}

function realMessage(providerId: string, telegramMessageId: string): ProviderMessageFixture {
  const message = corpusMessages.find(
    (candidate) =>
      candidate.providerId === providerId && candidate.telegramMessageId === telegramMessageId,
  );
  if (!message)
    throw new Error(`Missing committed provider fixture ${providerId}/${telegramMessageId}`);
  return message;
}

function realEvidence(
  message: ProviderMessageFixture,
  overrides: Partial<ExecutionEvidenceInput> = {},
): ExecutionEvidenceInput {
  return evidence(parsed(message.rawText, message.providerId), {
    providerConfig: message.providerId === "provider_15k9j3v" ? structuredConfig : proseConfig,
    ...overrides,
  });
}

describe("evaluateExecutionEvidence", () => {
  test("uses the real VIP Gold activation/close pair with one quoted order block", () => {
    const activation = realMessage("provider_15k9j3v", "489");
    const close = realMessage("provider_15k9j3v", "490");
    const activationBlock = activation.rawText.split("\n\nComment:\n")[0];
    const closeBlock = close.rawText.split("\n\nComment:\n")[0];

    expect(activationBlock).toBe(closeBlock);
    // Real provider activation: the quoted NEW block is context, so it must not open.
    expect(evaluateExecutionEvidence(realEvidence(activation)).verdict).toBe("DROP");
    // Real provider close: the reply-linked active trade is actionable lifecycle work.
    expect(
      evaluateExecutionEvidence(
        realEvidence(close, { lifecycleResolution: lifecycle("reply-link") }),
      ).verdict,
    ).toBe("EXECUTE");
  });

  test("covers the real provider verdicts without trusting stored classifications", () => {
    const cases: Array<{
      label: string;
      message: ProviderMessageFixture;
      expected: ExecutionEvidenceVerdict["verdict"];
      overrides?: Partial<ExecutionEvidenceInput>;
    }> = [
      // Real VIP Gold copier-new with a novel provider order id.
      {
        label: "VIP Gold new order",
        message: realMessage("provider_15k9j3v", "487"),
        expected: "EXECUTE",
      },
      // Real KAL VIP prose-complete entry with no provider order id.
      {
        label: "KAL VIP buy entry",
        message: realMessage("provider_1gfxfwd", "15226"),
        expected: "EXECUTE",
      },
      // Real KAL VIP prose-complete entry with a sell direction and four targets.
      {
        label: "KAL VIP sell entry",
        message: realMessage("provider_1gfxfwd", "15227"),
        expected: "EXECUTE",
      },
      // Real quoted TP hit; the matched reply is bookkeeping for one active trade.
      {
        label: "KAL VIP TP 2",
        message: realMessage("provider_1gfxfwd", "15343"),
        expected: "EXECUTE",
        overrides: { lifecycleResolution: lifecycle("reply-link") },
      },
      // Real quoted TP 3 on another provider signal; no invented 4488-89 variant.
      {
        label: "KAL VIP TP 3",
        message: realMessage("provider_1gfxfwd", "15514"),
        expected: "EXECUTE",
        overrides: { lifecycleResolution: lifecycle("reply-link") },
      },
      // Stored classification is noise, but the real Comment: Remove is a cancel.
      {
        label: "KAL VIP remove",
        message: realMessage("provider_1gfxfwd", "16669"),
        expected: "EXECUTE",
        overrides: { lifecycleResolution: lifecycle("reply-link") },
      },
      // Real quoted commentary is not an instruction to act.
      {
        label: "KAL VIP risk commentary",
        message: realMessage("provider_1gfxfwd", "15230"),
        expected: "DROP",
      },
      // Real quoted result commentary is also not an instruction to act.
      {
        label: "KAL VIP kept-limits commentary",
        message: realMessage("provider_1gfxfwd", "15231"),
        expected: "DROP",
      },
      // Real educational prose contains sell/close vocabulary but no executable signal.
      {
        label: "KAL VIP educational prose",
        message: realMessage("provider_1gfxfwd", "15311"),
        expected: "DROP",
      },
      // Real current false positive: incomplete geometry remains held for review.
      {
        label: "KAL VIP buy zones",
        message: realMessage("provider_1gfxfwd", "15363"),
        expected: "HOLD",
      },
      // Real current false positive: a past-tense close report has no lifecycle match here.
      {
        label: "KAL VIP closed at TP 1",
        message: realMessage("provider_1gfxfwd", "16677"),
        expected: "HOLD",
      },
      // Real current false positive: slippage commentary has no lifecycle match here.
      {
        label: "KAL VIP slippage commentary",
        message: realMessage("provider_1gfxfwd", "16997"),
        expected: "HOLD",
      },
    ];

    for (const testCase of cases) {
      const signal = parsed(testCase.message.rawText, testCase.message.providerId);
      if (testCase.label === "KAL VIP remove") {
        expect(signal.commandType).toBe("CANCEL_PENDING");
      }
      expect(
        evaluateExecutionEvidence(realEvidence(testCase.message, testCase.overrides)),
      ).toMatchObject({
        verdict: testCase.expected,
      });
    }
  });

  test("resolves real KAL inline quotes without authorizing quoted chatter", () => {
    const tpHit = realMessage("provider_1gfxfwd", "15343");
    expect(
      evaluateExecutionEvidence(
        realEvidence(tpHit, { lifecycleResolution: lifecycle("inline-quote") }),
      ),
    ).toMatchObject({ verdict: "EXECUTE", reason: "LIFECYCLE_INLINE_QUOTE" });

    const unmatched = evaluateExecutionEvidence(
      realEvidence(tpHit, {
        lifecycleResolution: lifecycle("inline-quote", "UNMATCHED", 0, "same-symbol trade trade-1"),
      }),
    );
    expect(unmatched).toMatchObject({
      verdict: "HOLD",
      reason: "INLINE_QUOTE_ORIGIN_UNMATCHED",
    });
    expect(unmatched.suggestion).toBeUndefined();

    const remove = realMessage("provider_1gfxfwd", "16669");
    expect(
      evaluateExecutionEvidence(
        realEvidence(remove, { lifecycleResolution: lifecycle("inline-quote") }),
      ),
    ).toMatchObject({ verdict: "EXECUTE", reason: "LIFECYCLE_INLINE_QUOTE" });

    for (const id of ["15230", "15231"]) {
      const chatter = realMessage("provider_1gfxfwd", id);
      expect(
        evaluateExecutionEvidence(
          realEvidence(chatter, { lifecycleResolution: lifecycle("inline-quote") }),
        ),
      ).toMatchObject({ verdict: "DROP" });
    }
  });

  test("keeps the two original synthetic incident repros", () => {
    // Synthetic: the original compact activation repro has no byte-identical corpus record.
    const activation = parsed(
      "Quoted signal: NEW ORDER - XAUUSD Buy Stop # 300424022 Entry: 4051.30 SL: 4045.30 TP: 4060.30 --- Comment: Buy Stop activated # 300424022",
    );
    expect(evaluateExecutionEvidence(evidence(activation)).verdict).toBe("DROP");

    // Synthetic: the original compact repost repro has no byte-identical corpus record.
    const repost = parsed(
      "NEW ORDER - XAUUSD Buy Stop # 300424022 Entry: 4051.30 SL: 4045.30 TP: 4060.30",
    );
    expect(evaluateExecutionEvidence(evidence(repost)).verdict).toBe("EXECUTE");
  });

  test("keeps reviewer regressions that have no real equivalent", () => {
    const cases: Array<[string, ExecutionEvidenceVerdict["verdict"]]> = [
      // Synthetic: no real corpus message says it is not closing all positions yet.
      ["We are NOT closing all positions yet, letting winners run", "HOLD"],
      // Synthetic: no real corpus message combines a daily recap with a bare CLOSED token.
      ["Daily target smashed\n{ CLOSED }", "HOLD"],
      // Synthetic: no real corpus message combines this explicit negation with a full new-order block.
      [
        "Do NOT enter this yet, wait for confirmation:\nNEW ORDER - XAUUSD Buy Stop\nEntry: 4051.30\nSL: 4045.30\nTP: 4060.30",
        "HOLD",
      ],
      // Synthetic: no real corpus message labels a full new-order block educational/example-only.
      [
        "Education only: example alert\nNEW ORDER - XAUUSD Buy Stop\nEntry: 4051.30\nSL: 4045.30\nTP: 4060.30",
        "HOLD",
      ],
      // Synthetic: no real corpus message uses this future-tense close example.
      ["For example, when we close you will see: { CLOSED }", "HOLD"],
      // Synthetic: no real corpus message uses this recap wording.
      ["Trades closed today: 5 winners", "HOLD"],
    ];

    for (const [text, expected] of cases) {
      expect(evaluateExecutionEvidence(evidence(parsed(text))).verdict).toBe(expected);
    }
  });

  test("keeps synthetic resolution and transport safety states advisory", () => {
    // Synthetic: the corpus has no same-symbol fallback state to an active trade.
    const close = parsed("CLOSED - XAUUSD Buy # 306947863");
    expect(
      evaluateExecutionEvidence(
        evidence(close, {
          lifecycleResolution: lifecycle(
            "same-symbol-fallback",
            "MATCHED",
            1,
            "same-symbol trade trade-1",
          ),
        }),
      ),
    ).toMatchObject({ verdict: "HOLD", suggestion: "same-symbol trade trade-1" });

    // Synthetic: these ambiguous/unmatched cardinalities are not represented in the corpus.
    for (const resolution of [
      lifecycle("provider-order-id", "AMBIGUOUS"),
      lifecycle("reply-link", "UNMATCHED"),
      lifecycle("reply-link", "MATCHED", 2),
      lifecycle("inline-quote", "AMBIGUOUS"),
      lifecycle("inline-quote", "MATCHED", 0),
      lifecycle("inline-quote", "MATCHED", 2),
    ]) {
      const result = evaluateExecutionEvidence(
        evidence(close, { lifecycleResolution: resolution }),
      );
      expect(result.verdict).toBe("HOLD");
      if (resolution.method === "inline-quote") {
        expect(result.reason).toBe(
          resolution.status === "AMBIGUOUS"
            ? "INLINE_QUOTE_ORIGIN_AMBIGUOUS"
            : `INLINE_QUOTE_ACTIVE_TRADE_COUNT:${resolution.activeTradeCount}`,
        );
      }
    }

    // Synthetic: no real corpus message carries this negation marker on a full copier-new block.
    const demoted = parsed(
      "Do NOT enter this yet:\nNEW ORDER - XAUUSD Buy Stop # 306947863 Entry: 4051.30 SL: 4045.30 TP: 4060.30",
    );
    expect(evaluateExecutionEvidence(evidence(demoted)).verdict).toBe("HOLD");

    // Synthetic: forwarded provenance is absent from the committed corpus snapshot.
    const forwarded = evaluateExecutionEvidence(
      evidence(parsed("Gold buy limit 4126-27\nSL 4132\nTP 4121"), {
        providerConfig: proseConfig,
        forwarded: true,
      }),
    );
    expect(forwarded.verdict).toBe("HOLD");
  });

  test("locks the 1,945-message corpus evidence budget per provider", () => {
    const noResolutionFloor = {
      provider_15k9j3v: { EXECUTE: 24, HOLD: 26, DROP: 18 },
      provider_1gfxfwd: { EXECUTE: 290, HOLD: 298, DROP: 1289 },
    } as const;
    const simulatedResolutionExpected = {
      provider_15k9j3v: { EXECUTE: 49, HOLD: 1, DROP: 18 },
      provider_1gfxfwd: { EXECUTE: 395, HOLD: 193, DROP: 1289 },
    } as const;
    const measuredFloor = {
      provider_15k9j3v: { EXECUTE: 0, HOLD: 0, DROP: 0 },
      provider_1gfxfwd: { EXECUTE: 0, HOLD: 0, DROP: 0 },
    };
    const measuredSimulation = structuredClone(measuredFloor);
    const commandTypeTallies: Record<string, number> = {};

    expect(corpusMessages).toHaveLength(1945);
    for (const message of corpusMessages) {
      const signal = parsed(message.rawText, message.providerId);
      commandTypeTallies[signal.commandType] = (commandTypeTallies[signal.commandType] ?? 0) + 1;
      const floorResult = evaluateExecutionEvidence(realEvidence(message));
      measuredFloor[message.providerId as keyof typeof measuredFloor][floorResult.verdict] += 1;
      const simulatedResult = evaluateExecutionEvidence(
        realEvidence(message, { lifecycleResolution: simulatedCorpusResolution(message) }),
      );
      measuredSimulation[message.providerId as keyof typeof measuredSimulation][
        simulatedResult.verdict
      ] += 1;
    }

    expect(measuredFloor).toEqual(noResolutionFloor);
    expect(measuredSimulation).toEqual(simulatedResolutionExpected);
    expect(commandTypeTallies).toEqual({
      NO_SIGNAL: 1411,
      OPEN_TRADE: 348,
      MARK_TP_HIT: 138,
      MOVE_SL_TO_BE: 4,
      CANCEL_PENDING: 29,
      CLOSE_TRADE: 15,
    });
  });
});
