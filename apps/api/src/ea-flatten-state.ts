export type FlattenRetcode = "DONE" | "PLACED" | "DONE_PARTIAL";

export type FlattenPosition = { ticket: string; volume: number };

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
): FlattenResult {
  const removedPendingTickets: string[] = [];
  const initialPending = broker.pendingOrderTickets();
  const initialPositions = broker.positionTickets();
  if (initialPending.length === 0 && initialPositions.length === 0) {
    return { status: "UNKNOWN", removedPendingTickets, closeAttempts: [] };
  }

  for (const ticket of initialPending) {
    if (broker.removePendingOrder(ticket).retcode === "DONE") removedPendingTickets.push(ticket);
  }

  const closeAttempts: FlattenResult["closeAttempts"] = [];
  let partialResult = false;
  for (const ticket of broker.positionTickets()) {
    const position = broker.position(ticket);
    if (!position) continue;
    if (executedTickets.has(`${idempotencyKey}:${ticket}`)) {
      partialResult = true;
      continue;
    }
    const result = broker.closePosition(ticket, position.volume);
    closeAttempts.push({
      ticket,
      requestedVolume: position.volume,
      filledVolume: result.filledVolume,
    });
    const remaining = broker.position(ticket);
    if (result.retcode === "DONE" && !remaining) {
      executedTickets.add(`${idempotencyKey}:${ticket}`);
    } else {
      partialResult = true;
    }
  }

  const remainingPending = broker.pendingOrderTickets().length;
  const remainingPositions = broker.positionTickets().length;
  if (remainingPending === 0 && remainingPositions === 0 && !partialResult) {
    return { status: "EXECUTED", removedPendingTickets, closeAttempts };
  }
  if (removedPendingTickets.length > 0 || closeAttempts.length > 0) {
    return { status: "PARTIAL", removedPendingTickets, closeAttempts };
  }
  return { status: "UNKNOWN", removedPendingTickets, closeAttempts };
}
