import {
  CalendarDays,
  CalendarRange,
  CheckCircle2,
  ChevronDown,
  type LucideIcon,
  PiggyBank,
  Server,
  Sun,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useColorAccents } from "../contexts/ColorAccentsContext";
import { useLocale } from "../contexts/LocaleContext";
import { CHART_PALETTE } from "../lib/chartPalette";
import { formatPercent } from "../lib/format";
import { Money } from "./Money";
import { SkeletonStat } from "./Skeleton";
import { Sparkline } from "./Sparkline";

export interface AccountHeaderData {
  accountId?: string;
  accountLabel?: string;
  accountNickname?: string | null;
  heartbeatStatus?: string;
  lastHeartbeatAt?: string | null;
  connectedPlatform: {
    platform: string;
    broker: string;
    accountType: "DEMO" | "LIVE" | "—";
    expertAdvisorVersion: string;
    eaActive: boolean;
  };
  kpis: {
    balance: number | null;
    equity: number | null;
    totalProfit: { amount: number | null; deltaPercent: number | null };
    today: { amount: number | null; deltaPercent: number | null };
    thisWeek: { amount: number | null; deltaPercent: number | null };
    thisMonth: { amount: number | null; deltaPercent: number | null };
  };
  /** Optional per-KPI history series for the sparkline strip. Each array is
   * a thin slice of recent equity / P-L values; falsy or short series skip
   * rendering so cards never show a degenerate single-point line. */
  series?: {
    balance?: number[];
    equity?: number[];
    totalProfit?: number[];
    today?: number[];
    thisWeek?: number[];
    thisMonth?: number[];
  };
  nativeCurrencyGroups?: Array<{
    currency: string;
    accountCount: number;
    balance: number | null;
    equity: number | null;
    totalProfit: number | null;
    today: number | null;
  }>;
  currency: string;
}

type Accent = "blue" | "violet" | "emerald" | "amber" | "rose" | "muted";

function formatDelta(
  deltaPercent: number | null,
  locale: string,
): { text: string; tone: "up" | "down" | "muted" } {
  if (deltaPercent === null) return { text: "—", tone: "muted" };
  const sign = deltaPercent >= 0 ? "▲" : "▼";
  const tone: "up" | "down" | "muted" =
    deltaPercent > 0 ? "up" : deltaPercent < 0 ? "down" : "muted";
  return {
    text: `${sign} ${formatPercent(Math.abs(deltaPercent), { locale, signDisplay: "never" })}`,
    tone,
  };
}

export function AccountHeader({
  data,
  loading = false,
  className,
  onRename,
  onRemoveAccount,
  onManageLink,
}: {
  data: AccountHeaderData;
  loading?: boolean;
  className?: string;
  onRename?: (nickname: string) => Promise<void> | void;
  onRemoveAccount?: () => void;
  onManageLink?: () => void;
}) {
  const {
    accountId,
    accountLabel,
    accountNickname,
    connectedPlatform,
    heartbeatStatus,
    kpis,
    lastHeartbeatAt,
    nativeCurrencyGroups,
    series,
    currency,
  } = data;
  const { locale } = useLocale();
  const { colorAccents } = useColorAccents();
  const [renaming, setRenaming] = useState(false);
  const [nickname, setNickname] = useState(accountNickname ?? "");
  const initialized = useRef(false);
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      return;
    }
    setNickname(accountNickname ?? "");
    setRenaming(false);
  }, [accountId, accountNickname]);
  const isOnline = heartbeatStatus === "online";
  const heartbeatLabel = lastHeartbeatAt
    ? new Date(lastHeartbeatAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
    : "unknown time";
  // Today / This Week / This Month are the same metric over three windows, so
  // they collapse into one card with a toggle instead of three separate cards.
  const [pnlWindow, setPnlWindow] = useState<"today" | "thisWeek" | "thisMonth">("today");

  // Each card carries its own icon + accent so the badge palette stays
  // distinct even when several values move in the same direction.
  const kpiList: Array<{
    key: keyof NonNullable<AccountHeaderData["series"]>;
    label: string;
    amount: number | null;
    delta: number | null;
    icon: LucideIcon;
    accent: Accent;
    primary?: boolean;
  }> = [
    {
      key: "balance",
      label: "Balance",
      amount: kpis.balance,
      delta: null,
      icon: Wallet,
      accent: "blue",
    },
    {
      key: "equity",
      label: "Equity",
      amount: kpis.equity,
      delta: null,
      icon: PiggyBank,
      accent: "violet",
    },
    {
      key: "totalProfit",
      label: "Trading P/L",
      amount: kpis.totalProfit.amount,
      delta: kpis.totalProfit.deltaPercent,
      icon: TrendingUp,
      accent: "emerald",
      primary: true,
    },
  ];

  const windowOptions: Array<{
    key: "today" | "thisWeek" | "thisMonth";
    short: string;
    icon: LucideIcon;
    accent: Accent;
  }> = [
    { key: "today", short: "Today", icon: Sun, accent: "amber" },
    { key: "thisWeek", short: "Week", icon: CalendarRange, accent: "blue" },
    { key: "thisMonth", short: "Month", icon: CalendarDays, accent: "violet" },
  ];
  const activeWindow =
    windowOptions.find((option) => option.key === pnlWindow) ?? windowOptions[0]!;
  const windowKpi = kpis[pnlWindow];
  const WindowIcon = activeWindow.icon;
  const windowDelta = formatDelta(windowKpi.deltaPercent, locale);
  const windowSpark = series?.[pnlWindow];
  const chartColor = (isNegative: boolean) =>
    colorAccents
      ? isNegative
        ? CHART_PALETTE.drawdownCss
        : CHART_PALETTE.growthCss
      : "var(--ink-faint)";
  const windowSparkColor = chartColor(
    windowKpi.deltaPercent !== null && windowKpi.deltaPercent < 0,
  );

  return (
    <section
      className={["account-header", className].filter(Boolean).join(" ")}
      aria-label="Account performance"
    >
      <div className="account-header-section">
        <div className="account-header-title-row">
          <div>
            <h2 className="account-header-title">{isOnline ? "Live" : "Last known"}</h2>
            {accountLabel ? (
              <span className="account-header-account-label">{accountLabel}</span>
            ) : null}
          </div>
          {accountId ? (
            <details className="resolve-menu account-header-menu">
              <summary aria-label="Account actions" className="icon-btn">
                <ChevronDown aria-hidden="true" size={15} />
              </summary>
              <div className="resolve-menu-popover">
                {renaming ? (
                  <form
                    className="account-rename-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!onRename) return;
                      const value = new FormData(event.currentTarget).get("nickname");
                      void Promise.resolve(onRename(typeof value === "string" ? value.trim() : ""))
                        .then(() => setRenaming(false))
                        .catch(() => undefined);
                    }}
                  >
                    <label htmlFor="account-nickname">Account name</label>
                    <input
                      aria-label="Account name"
                      className="settings-input"
                      id="account-nickname"
                      maxLength={80}
                      name="nickname"
                      onChange={(event) => setNickname(event.target.value)}
                      value={nickname}
                    />
                    <button className="btn btn-primary btn-small" type="submit">
                      Save name
                    </button>
                  </form>
                ) : (
                  <button onClick={() => setRenaming(true)} type="button">
                    Rename
                  </button>
                )}
                <button onClick={onRemoveAccount} type="button">
                  Remove account
                </button>
                <button onClick={onManageLink} type="button">
                  Manage link
                </button>
              </div>
            </details>
          ) : null}
        </div>
        {!isOnline && lastHeartbeatAt ? (
          <p className="account-header-stale-note">Balance as at {heartbeatLabel} - not current</p>
        ) : null}
        {nativeCurrencyGroups?.length ? (
          <p className="account-header-currency-note">
            Native currencies remain separate; no FX total is shown.
          </p>
        ) : null}
        <div className="account-platform-card">
          <div className="account-platform-card-icon" aria-hidden="true">
            <Server size={16} />
          </div>
          <div>
            <dl className="account-platform-card-grid">
              <dt>Platform</dt>
              <dd>{connectedPlatform.platform}</dd>
              <dt>Broker</dt>
              <dd>{connectedPlatform.broker}</dd>
              <dt>Type</dt>
              <dd>{connectedPlatform.accountType}</dd>
              <dt>Expert Advisor</dt>
              <dd>{connectedPlatform.expertAdvisorVersion}</dd>
            </dl>
            <div
              className={`ea-badge ${connectedPlatform.eaActive ? "ea-on" : "ea-off"}`}
              role="status"
            >
              <CheckCircle2 size={12} aria-hidden="true" />
              {connectedPlatform.eaActive ? "EA WORKING" : "EA OFFLINE"}
            </div>
          </div>
        </div>
      </div>

      <div className="account-kpis anim-stagger">
        {nativeCurrencyGroups?.map((group) => (
          <article
            aria-label={`${group.currency} account totals`}
            className="native-currency-card"
            key={group.currency}
          >
            <header>
              <strong>{group.currency}</strong>
              <span>
                {group.accountCount} account{group.accountCount === 1 ? "" : "s"} · native
              </span>
            </header>
            <dl>
              <div>
                <dt>Balance</dt>
                <dd>
                  <Money value={group.balance} currency={group.currency} locale={locale} />
                </dd>
              </div>
              <div>
                <dt>Equity</dt>
                <dd>
                  <Money value={group.equity} currency={group.currency} locale={locale} />
                </dd>
              </div>
              <div>
                <dt>Trading P/L</dt>
                <dd>
                  <Money
                    value={group.totalProfit}
                    currency={group.currency}
                    locale={locale}
                    signTone
                  />
                </dd>
              </div>
              <div>
                <dt>Today</dt>
                <dd>
                  <Money value={group.today} currency={group.currency} locale={locale} signTone />
                </dd>
              </div>
            </dl>
          </article>
        ))}
        {!nativeCurrencyGroups?.length && loading && kpis.balance === null
          ? Array.from({ length: 4 }, (_, index) => (
              <div className="kpi" key={`kpi-skeleton-${index}`}>
                <SkeletonStat />
              </div>
            ))
          : null}
        {!nativeCurrencyGroups?.length && !(loading && kpis.balance === null) ? (
          <>
            {kpiList.map((kpi) => {
              const delta = formatDelta(kpi.delta, locale);
              const Icon = kpi.icon;
              const sparkData = series?.[kpi.key];
              // Sparkline tone tracks P/L sign for the windowed cards;
              // Balance/Equity stay on their fixed accent.
              const sparkColor = chartColor(kpi.delta !== null && kpi.delta < 0);
              return (
                <div className={`kpi ${kpi.primary ? "kpi-primary" : ""}`} key={kpi.label}>
                  <div className="kpi-head">
                    <span className="kpi-label">
                      <span>{kpi.label}</span>
                      {currency ? <span className="kpi-label-currency">· {currency}</span> : null}
                    </span>
                    <span className={`kpi-badge kpi-badge-${kpi.accent}`} aria-hidden="true">
                      <Icon size={13} />
                    </span>
                  </div>
                  <div aria-hidden="true" className="kpi-window-spacer" />
                  <Money
                    value={kpi.amount}
                    currency={currency}
                    locale={locale}
                    signTone={kpi.delta !== null}
                    symbol={false}
                    className="kpi-amount"
                  />
                  <span className={`kpi-delta kpi-delta-${delta.tone}`}>{delta.text}</span>
                  {sparkData &&
                  sparkData.length >= 2 &&
                  Math.min(...sparkData) !== Math.max(...sparkData) ? (
                    <Sparkline
                      ariaLabel={`${kpi.label} trend`}
                      color={sparkColor}
                      data={sparkData}
                    />
                  ) : (
                    // Reserve the sparkline strip even when no series is
                    // available (or the series is flat) so layout doesn't
                    // shift once real data lands.
                    <div aria-hidden="true" className="kpi-spark-placeholder" />
                  )}
                </div>
              );
            })}
            <div className="kpi kpi-window">
              <div className="kpi-head">
                <span className="kpi-label">
                  <span>P/L</span>
                  {currency ? <span className="kpi-label-currency">· {currency}</span> : null}
                </span>
                <span className={`kpi-badge kpi-badge-${activeWindow.accent}`} aria-hidden="true">
                  <WindowIcon size={13} />
                </span>
              </div>
              <div
                className="segmented-control kpi-window-toggle"
                role="tablist"
                aria-label="P/L window"
              >
                {windowOptions.map((option) => (
                  <button
                    aria-selected={pnlWindow === option.key}
                    className={pnlWindow === option.key ? "active" : ""}
                    key={option.key}
                    onClick={() => setPnlWindow(option.key)}
                    role="tab"
                    type="button"
                  >
                    {option.short}
                  </button>
                ))}
              </div>
              <Money
                value={windowKpi.amount}
                currency={currency}
                locale={locale}
                signTone={windowKpi.deltaPercent !== null}
                symbol={false}
                className="kpi-amount"
              />
              <span className={`kpi-delta kpi-delta-${windowDelta.tone}`}>{windowDelta.text}</span>
              {windowSpark &&
              windowSpark.length >= 2 &&
              Math.min(...windowSpark) !== Math.max(...windowSpark) ? (
                <Sparkline
                  ariaLabel={`${activeWindow.short} P/L trend`}
                  color={windowSparkColor}
                  data={windowSpark}
                />
              ) : (
                <div aria-hidden="true" className="kpi-spark-placeholder" />
              )}
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
