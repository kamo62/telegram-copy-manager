export type FlattenRetcode = "DONE" | "PLACED" | "DONE_PARTIAL" | "FAILED";

export type FlattenPosition = { ticket: string; volume: number };

export type FlattenRunner = { enabled: boolean; lotSize: number };

export type FlattenCloseOptions = {
  runner?: FlattenRunner;
  minVolume?: number;
  volumeStep?: number;
};

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
  options: FlattenCloseOptions = {},
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
  const runnerMode = cancelPending && Boolean(options.runner?.enabled);
  const partialMode = !cancelPending || runnerMode;
  for (const ticket of broker.positionTickets()) {
    const position = broker.position(ticket);
    if (!position) continue;
    if (executedTickets.has(`${idempotencyKey}:${ticket}`)) {
      continue;
    }
    attempted += 1;
    const requestedVolume = !cancelPending
      ? partialCloseVolume(position.volume, partialClose, options.minVolume, options.volumeStep)
      : runnerMode
        ? closeVolumeForRunner(
            position.volume,
            options.runner,
            options.minVolume,
            options.volumeStep,
          )
        : position.volume;
    if (requestedVolume <= 0) {
      partialResult = true;
      continue;
    }
    const result = broker.closePosition(ticket, requestedVolume);
    const remainingPosition = broker.position(ticket);
    const observedFilledVolume = Number(
      (remainingPosition
        ? Math.max(0, position.volume - remainingPosition.volume)
        : position.volume
      ).toFixed(8),
    );
    const confirmedFilledVolume = Math.max(result.filledVolume, observedFilledVolume);
    closeAttempts.push({
      ticket,
      requestedVolume,
      filledVolume: confirmedFilledVolume,
    });
    const complete =
      result.retcode === "DONE" &&
      confirmedFilledVolume + 0.000001 >= requestedVolume &&
      (partialMode || !remainingPosition);
    if (complete) {
      executedTickets.add(`${idempotencyKey}:${ticket}`);
      succeeded += 1;
    } else {
      partialResult = true;
    }
  }

  if (partialMode) {
    if (attempted === 0) {
      return {
        status: removedPendingTickets.length > 0 ? "EXECUTED" : "UNKNOWN",
        removedPendingTickets,
        closeAttempts,
      };
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

export function closeVolumeForRunner(
  currentVolume: number,
  runner: FlattenRunner | undefined,
  minVolume = 0.01,
  volumeStep = 0.01,
) {
  if (!runner?.enabled) return currentVolume;
  if (
    !Number.isFinite(currentVolume) ||
    !Number.isFinite(runner.lotSize) ||
    runner.lotSize <= 0 ||
    currentVolume <= runner.lotSize ||
    minVolume <= 0 ||
    volumeStep <= 0
  )
    return 0;
  const candidate = currentVolume - runner.lotSize;
  const normalized = Number(
    (Math.floor((candidate + volumeStep * 0.000001) / volumeStep) * volumeStep).toFixed(8),
  );
  return normalized >= minVolume && normalized > 0 && normalized < currentVolume ? normalized : 0;
}

function partialCloseVolume(
  currentVolume: number,
  partialClose: FlattenPartialClose | undefined,
  minVolume = 0.01,
  volumeStep = 0.01,
) {
  if (!partialClose) return 0;
  const requested =
    partialClose.kind === "PERCENT"
      ? partialClose.targetRemainingVolume !== undefined && partialClose.targetRemainingVolume > 0
        ? currentVolume - partialClose.targetRemainingVolume
        : partialClose.targetRemainingVolume !== undefined
          ? 0
          : (currentVolume * partialClose.value) / 100
      : partialClose.kind === "TP_LEG"
        ? (partialClose.volume ??
          (partialClose.allocationPercent
            ? (currentVolume * partialClose.allocationPercent) / 100
            : 0))
        : partialClose.value;
  if (requested <= 0) return 0;
  const step = volumeStep > 0 ? volumeStep : 0.01;
  if (requested >= currentVolume - step * 0.000001) return currentVolume;
  const normalized = Number(
    (Math.floor((Math.min(currentVolume, requested) + step * 0.000001) / step) * step).toFixed(8),
  );
  return normalized >= minVolume && normalized > 0 ? normalized : 0;
}
