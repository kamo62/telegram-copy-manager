# MT5 Demo Terminal Verification

Use this checklist on a machine with MetaTrader 5 and a demo account. Local Bun tests and
`bun run mt5:smoke` verify the backend contract, but only this flow proves real MQL5 compilation,
WebRequest behavior, broker retcodes, symbol constraints, and hedging/netting behavior.

## Prerequisites

- Build and run the API locally or from a reachable host.
- Confirm `GET /api/health` returns `status: ok`.
- Copy `mt5/TelegramTC_EA.mq5` into the terminal's `MQL5/Experts/` folder.
- In MT5, add the backend base URL, for example `http://127.0.0.1:8787/api`, under:
  `Tools -> Options -> Expert Advisors -> Allow WebRequest for listed URL`.
- Use a demo account first. Do not run this on a live account.

## Compile

1. Open `TelegramTC_EA.mq5` in MetaEditor.
2. Compile with zero errors.
3. Record any warnings. Warnings are acceptable only if they do not affect request/result fields,
   order actions, position selection, WebRequest calls, or volume/price handling.

## Register, Heartbeat, Snapshot

1. Attach the EA to a chart.
2. Set `BackendBaseUrl` to the reachable API base URL.
3. Confirm the backend shows the MT5 account as online.
4. Confirm `/api/mt5/accounts` includes account number, server, company, currency, balance, equity,
   margin mode, heartbeat timestamp, and available symbols.
5. Confirm snapshot audit/log output shows positions and orders without JSON parse errors.

## Open Signal

1. Queue a demo open signal from the app or `bun run mt5:smoke` equivalent data.
2. Confirm `/api/mt5/poll-line` returns `status=WORK`.
3. Confirm the EA places the trade or pending order.
4. Confirm `/api/execution-logs` includes `retcode`, `retcodeExternal`, broker comment, order ticket,
   deal ticket, requested price, filled price, volume, and error text.

## Lifecycle Commands

Run at least one command from each group:

- `MOVE_SL_TO_BE`
- `MODIFY_SL`
- `MODIFY_TP`
- `CLOSE_PARTIAL`
- `CLOSE_TRADE`
- `CANCEL_PENDING`
- `TRAILING_STOP`

For each command, verify the EA matches by logical trade comment, not only symbol, and reports the
actual broker result.

## TP Modes

For `VIRTUAL_TP`:

- Open one position with TP1-TP4 in the backend payload.
- Let price reach TP1 in demo conditions or manually use a close-to-market test symbol.
- Confirm the EA closes the configured partial volume and reports the result.

For `SPLIT_ORDER`:

- Approve an open signal with split-order mode.
- Confirm the EA creates one child request per TP leg.
- Verify behavior separately on hedging and netting demo accounts.

## Pass Criteria

- EA compiles with zero errors.
- Account registration, heartbeat, and snapshots reach the backend.
- Open, management, split-order, virtual-TP, and trailing-stop flows produce broker retcodes.
- Execution logs are sufficient to diagnose broker rejection without terminal-side guessing.
- Hedging and netting behavior is documented for partial closes and split-order mode.
