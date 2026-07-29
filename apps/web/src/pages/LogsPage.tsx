import { Inbox, ListChecks, RefreshCw, Send, Terminal } from "lucide-react";
import type { DashboardSnapshot } from "../App";
import { ActivityFeed } from "../components/ActivityFeed";
import { EmptyState } from "../components/EmptyState";
import { HeldSignalsTable } from "../components/HeldSignalsTable";
import { LogRow } from "../components/LogRow";
import type { ManualSignalSeed } from "../components/ManualSignalModal";
import { Panel } from "../components/Panel";
import { ParserResult } from "../components/ParserResult";
import { QueueItem } from "../components/QueueItem";
import type { HeldQueueItem, HeldRequeueMode } from "../lib/api";

export function LogsPage({
  parserTab,
  onParserTabChange,
  providersLength,
  onParseRecent,
  parseRecentBusy,
  parseRecentResults,
  parserLoading,
  parserLoadError,
  snapshot,
  fixtureClassifications,
  onClassify,
  redactedFixtureText,
  onRedactedChange,
  onSaveFixture,
  onAiReview,
  onApprove,
  onIgnore,
  onForcePush,
  aiReviewStatus,
  parserActionStatus,
  parserActionPending,
  fixtureStatus,
  heldItems,
  onHeldRequeue,
  onHeldDismiss,
}: {
  parserTab: string;
  onParserTabChange: (tab: string) => void;
  providersLength: number;
  onParseRecent: () => void;
  parseRecentBusy: boolean;
  parseRecentResults: Array<{
    providerId: string;
    captured: number;
    inserted: number;
    parsed: number;
    error?: string;
  }>;
  parserLoading: boolean;
  parserLoadError: boolean;
  snapshot: DashboardSnapshot;
  fixtureClassifications: Record<string, "entry" | "management" | "noise" | "unknown">;
  onClassify: (
    rawMessageId: string,
    classification: "entry" | "management" | "noise" | "unknown",
  ) => void;
  redactedFixtureText: Record<string, string>;
  onRedactedChange: (rawMessageId: string, value: string) => void;
  onSaveFixture: (result: DashboardSnapshot["parserResults"][number], redactedText: string) => void;
  onAiReview: (result: DashboardSnapshot["parserResults"][number]) => void;
  onApprove: (result: DashboardSnapshot["parserResults"][number]) => void;
  onIgnore: (result: DashboardSnapshot["parserResults"][number]) => void;
  onForcePush: (seed?: ManualSignalSeed) => void;
  aiReviewStatus: Record<string, string>;
  parserActionStatus: Record<string, string>;
  parserActionPending: Record<string, boolean>;
  fixtureStatus: Record<string, string>;
  heldItems: HeldQueueItem[];
  onHeldRequeue: (
    item: HeldQueueItem,
    mode: HeldRequeueMode,
    logicalTradeId?: string,
  ) => Promise<void> | void;
  onHeldDismiss: (item: HeldQueueItem) => Promise<void> | void;
}) {
  return (
    <>
      <section className="wide-panel" id="held">
        <Panel testId="held-signals-panel" title="Held signals">
          <HeldSignalsTable
            accountLabel={(accountId) =>
              snapshot.mt5Accounts.find((account) => account.id === accountId)?.accountNumber ??
              (accountId || "Unassigned")
            }
            items={heldItems}
            onDismiss={onHeldDismiss}
            onRequeue={onHeldRequeue}
            providerLabel={(providerId) =>
              snapshot.providers.find((provider) => provider.id === providerId)?.title ??
              (providerId || "Unassigned")
            }
          />
        </Panel>
      </section>

      <Panel
        activeTab={parserTab}
        className="wide-panel"
        collapsible
        onTabChange={onParserTabChange}
        tabs={["Recent Parses", "Saved Fixtures"]}
        testId="parser-lab-panel"
        title="Parser Lab"
      >
        {parserTab === "Recent Parses" ? (
          <>
            <div className="panel-toolbar">
              <button
                disabled={providersLength === 0 || parseRecentBusy}
                onClick={onParseRecent}
                title="Parse recent provider messages"
                type="button"
              >
                <RefreshCw size={13} aria-hidden="true" />
                {parseRecentBusy ? "Parsing…" : "Parse recent"}
              </button>
            </div>
            {parseRecentResults.length ? (
              <div className="parse-recent-results">
                {parseRecentResults.map((result) => (
                  <span key={result.providerId}>
                    {result.providerId}: {result.parsed} parsed, {result.inserted} new
                    {result.error ? ` — ${result.error}` : ""}
                  </span>
                ))}
              </div>
            ) : null}
            <div className="parser-grid">
              {parserLoading ? <p className="load-state">Loading ParseLab…</p> : null}
              {!parserLoading && parserLoadError ? (
                <p className="load-state load-state-error">
                  ParseLab could not be loaded. Retry refresh.
                </p>
              ) : null}
              {!parserLoading && !parserLoadError && snapshot.parserResults.length === 0 ? (
                <EmptyState
                  body={
                    providersLength === 0
                      ? "Add a provider from Telegram Setup first, then run Parse recent."
                      : "Run Parse recent to pull the latest provider messages and review parser output."
                  }
                  glyph={<ListChecks aria-hidden="true" size={28} />}
                  title="No parser results yet"
                />
              ) : null}
              {snapshot.parserResults.map((result) => {
                const rawMessageId = result.rawMessageId ?? result.id;
                return (
                  <ParserResult
                    key={result.id}
                    fixtureClassification={fixtureClassifications[rawMessageId]}
                    onClassify={(classification) => onClassify(rawMessageId, classification)}
                    onRedactedChange={(value) => onRedactedChange(rawMessageId, value)}
                    onSaveFixture={(redactedText) => onSaveFixture(result, redactedText)}
                    onAiReview={() => onAiReview(result)}
                    onApprove={() => onApprove(result)}
                    onIgnore={() => onIgnore(result)}
                    onForcePush={onForcePush}
                    aiReview={aiReviewStatus[result.id]}
                    actionPending={parserActionPending[result.id]}
                    actionStatus={parserActionStatus[result.id]}
                    fixtureStatus={fixtureStatus[rawMessageId]}
                    redactedText={redactedFixtureText[rawMessageId] ?? ""}
                    result={result}
                  />
                );
              })}
            </div>
          </>
        ) : (
          <div className="list-stack">
            {(snapshot.parserFixtures ?? []).length === 0 ? (
              <EmptyState
                body="Approve a parsed signal and save it as a fixture from the Recent Parses tab."
                glyph={<ListChecks aria-hidden="true" size={28} />}
                title="No saved fixtures yet"
              />
            ) : (
              (snapshot.parserFixtures ?? []).map((fixture) => (
                <div className="row-item" key={fixture.id}>
                  <div>
                    <strong>{fixture.expectedCommandType}</strong>
                    <span>
                      {fixture.providerLabel} · {fixture.classification}
                    </span>
                    <code>{fixture.rawText}</code>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </Panel>

      <Panel
        actions={
          <button
            className="btn btn-ghost btn-small"
            onClick={() => onForcePush()}
            title="Compose a trade and force-push it to an account's MT5 queue"
            type="button"
          >
            <Send size={13} aria-hidden="true" />
            New manual ticket
          </button>
        }
        className="wide-panel"
        collapsible
        defaultOpen={false}
        title="Signal Queue"
      >
        <div className="queue-board">
          {snapshot.signalQueue.length === 0 ? (
            <EmptyState
              body="Approved signals will appear here while they wait for the MT5 EA to pick them up."
              glyph={<Inbox aria-hidden="true" size={28} />}
              title="Queue is empty"
            />
          ) : (
            snapshot.signalQueue.map((item) => (
              <QueueItem key={item.id} item={item} heldHref="/logs#held" />
            ))
          )}
        </div>
      </Panel>

      <Panel className="wide-panel" collapsible defaultOpen={false} title="Execution Logs">
        <div className="log-list">
          {snapshot.executionLogs.length === 0 ? (
            <EmptyState
              body="Execution reports from the MT5 Expert Advisor show up here once a signal is processed."
              glyph={<Terminal aria-hidden="true" size={28} />}
              title="No MT5 reports yet"
            />
          ) : (
            snapshot.executionLogs.map((log) => <LogRow key={log.id} log={log} />)
          )}
        </div>
      </Panel>

      <Panel className="wide-panel" collapsible defaultOpen={false} title="Activity">
        <ActivityFeed />
      </Panel>
    </>
  );
}
