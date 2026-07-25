export type FlattenRetcode = "DONE" | "PLACED" | "DONE_PARTIAL" | "FAILED";

export type FlattenPosition = { ticket: string; volume: number };

export type FlattenPartialClose = {
  kind: "PERCENT" | "LOTS" | "TP_LEG";
  value: number;
  volume?: number;
  allocationPercent?: number;
  targetRemainingVolume?: number;
};

export interface FlattenBroker {
  pendingOrderTickets(): string[];
  removePendingOrder(ticket: string): { retcode: "DONE" | "FAILED" };
  positionTickets(): string[];
  position(ticket: string): FlattenPosition | undefined;
  closePosition(
    ticket: string,
    volume: number,
  ): {
    retcode: FlattenRetcode;
    filledVolume: number;
  };
}

export type FlattenResult = {
  status: "EXECUTED" | "PARTIAL" | "UNKNOWN";
  removedPendingTickets: string[];
  closeAttempts: Array<{ ticket: string; requestedVolume: number; filledVolume: number }>;
};

/**
 * Portable execution model for the MQL5 CLOSE_TRADE state machine. Keep this
 * deliberately small: the Bun regression runs the broker race and retry rules
 * without pretending that source-string checks execute inside MetaTrader.
 */
export function flattenClose(
  broker: FlattenBroker,
  idempotencyKey: string,
  executedTickets = new Set<string>(),
  // CLOSE_TRADE cancels working pending orders; CLOSE_PARTIAL must leave them
  // alone because it only reduces an already-open position.
  cancelPending = true,
  partialClose?: FlattenPartialClose,
): FlattenResult {
  const removedPendingTickets: string[] = [];
  const initialPending = cancelPending ? broker.pendingOrderTickets() : [];
  const initialPositions = broker.positionTickets();
  if (initialPending.length === 0 && initialPositions.length === 0) {
    return { status: "UNKNOWN", removedPendingTickets, closeAttempts: [] };
  }

  for (const ticket of initialPending) {
    if (broker.removePendingOrder(ticket).retcode === "DONE") removedPendingTickets.push(ticket);
  }

  const closeAttempts: FlattenResult["closeAttempts"] = [];
  let partialResult = false;
  let attempted = 0;
  let succeeded = 0;
  const partialMode = !cancelPending;
  for (const ticket of broker.positionTickets()) {
    const position = broker.position(ticket);
    if (!position) continue;
    if (executedTickets.has(`${idempotencyKey}:${ticket}`)) {
      continue;
    }
    attempted += 1;
    const requestedVolume = partialMode
      ? partialCloseVolume(position.volume, partialClose)
      : position.volume;
    if (requestedVolume <= 0) {
      partialResult = true;
      continue;
    }
    const result = broker.closePosition(ticket, requestedVolume);
    closeAttempts.push({
      ticket,
      requestedVolume,
      filledVolume: result.filledVolume,
    });
    const remaining = broker.position(ticket);
    const complete =
      result.retcode === "DONE" &&
      result.filledVolume + 0.000001 >= requestedVolume &&
      (partialMode || !remaining);
    if (complete) {
      executedTickets.add(`${idempotencyKey}:${ticket}`);
      succeeded += 1;
    } else {
      partialResult = true;
    }
  }

  if (partialMode) {
    if (attempted === 0) {
      return { status: "UNKNOWN", removedPendingTickets, closeAttempts };
    }
    return {
      status: succeeded === attempted && !partialResult ? "EXECUTED" : "PARTIAL",
      removedPendingTickets,
      closeAttempts,
    };
  }

  const remainingPending = cancelPending ? broker.pendingOrderTickets().length : 0;
  const remainingPositions = broker.positionTickets().length;
  if (remainingPending === 0 && remainingPositions === 0 && !partialResult) {
    return { status: "EXECUTED", removedPendingTickets, closeAttempts };
  }
  if (removedPendingTickets.length > 0 || closeAttempts.length > 0) {
    return { status: "PARTIAL", removedPendingTickets, closeAttempts };
  }
  return { status: "UNKNOWN", removedPendingTickets, closeAttempts };
}

function partialCloseVolume(currentVolume: number, partialClose?: FlattenPartialClose) {
  if (!partialClose) return 0;
  const requested =
    partialClose.kind === "PERCENT"
      ? partialClose.targetRemainingVolume !== undefined
        ? currentVolume - partialClose.targetRemainingVolume
        : (currentVolume * partialClose.value) / 100
      : partialClose.kind === "TP_LEG"
        ? (partialClose.volume ??
          (partialClose.allocationPercent
            ? (currentVolume * partialClose.allocationPercent) / 100
            : 0))
        : partialClose.value;
  return Math.min(currentVolume, Math.max(0, Number(requested.toFixed(8))));
}
