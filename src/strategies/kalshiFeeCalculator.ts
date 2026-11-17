export type KalshiFeeMode = 'TAKER' | 'MAKER_POST_ONLY';

export interface LowBalanceKalshiEdgeParams {
  fvYes: number;
  askYes: number;
  bidYes: number;
  contracts: number;
  atr14ProbUsd: number;
  entryMode: KalshiFeeMode;
  holdToSettlementIfDeepItm: boolean;
}

export interface LowBalanceKalshiEdgeResult {
  entryPriceUsd: number;
  entryFeeUsd: number;
  expectedExitFeeUsd: number;
  stressedRoundTripDragUsd: number;
  netExpectedEdgeUsd: number;
  passesEdgeGate: boolean;
}

export const KALSHI_STRESSED_DRAG_FLOOR_USD = 0.12 as const;
export const KALSHI_MIN_GROSS_EDGE_FLOOR_USD = 0.18 as const;
export const KALSHI_GROSS_EDGE_BASE_USD = 0.12 as const;
export const KALSHI_GROSS_EDGE_ATR_MULT = 1.1 as const;

/**
 * Computes the exact Kalshi order fee in USD using whole-order cent ceiling math
 * (Section 30.3 / TASK-15):
 *   Fee = mode === 'MAKER_POST_ONLY' && makerMultiplier === 0
 *     ? 0
 *     : Math.ceil(100 * (mode === 'TAKER' ? takerMultiplier : makerMultiplier) * contracts * priceUsd * (1 - priceUsd) - 1e-9) / 100
 */
export function computeKalshiOrderFeeUsd(
  contracts: number,
  priceUsd: number,
  mode: 'TAKER' | 'MAKER_POST_ONLY',
  takerMultiplier = 0.07,
  makerMultiplier = 0.00
): number {
  if (
    !Number.isFinite(contracts) ||
    !Number.isFinite(priceUsd) ||
    contracts <= 0 ||
    priceUsd <= 0 ||
    priceUsd >= 1
  ) {
    return 0;
  }

  return mode === 'MAKER_POST_ONLY' && makerMultiplier === 0
    ? 0
    : Math.ceil(
        100 *
          (mode === 'TAKER' ? takerMultiplier : makerMultiplier) *
          contracts *
          priceUsd *
          (1 - priceUsd) -
          1e-9
      ) / 100;
}

/**
 * Evaluates low-balance Kalshi fee-adjusted edge (Section 30.3 / TASK-15),
 * enforcing the $0.12 stressed round-trip drag floor and the
 * `max(0.18, 0.12 + 1.1 * atr14ProbUsd)` gross edge gate.
 */
export function evaluateLowBalanceKalshiEdge(params: {
  fvYes: number;
  askYes: number;
  bidYes: number;
  contracts: number;
  atr14ProbUsd: number;
  entryMode: 'TAKER' | 'MAKER_POST_ONLY';
  holdToSettlementIfDeepItm: boolean;
}): LowBalanceKalshiEdgeResult {
  const safeContracts =
    Number.isFinite(params.contracts) && params.contracts > 0
      ? Math.floor(params.contracts)
      : 0;

  const rawEntryPriceUsd =
    params.entryMode === 'MAKER_POST_ONLY'
      ? Math.min(params.askYes - 0.01, params.bidYes + 0.01)
      : params.askYes;
  const entryPriceUsd = Number(
    Math.max(0.01, Math.min(0.99, rawEntryPriceUsd)).toFixed(4)
  );

  const entryFeeUsd = computeKalshiOrderFeeUsd(
    safeContracts,
    entryPriceUsd,
    params.entryMode
  );

  const expectedExitFeeUsd = params.holdToSettlementIfDeepItm
    ? 0
    : computeKalshiOrderFeeUsd(safeContracts, params.bidYes, 'TAKER');

  const perContractFeeDragUsd =
    safeContracts > 0 ? (entryFeeUsd + expectedExitFeeUsd) / safeContracts : 0;
  const spreadDragUsd = Math.max(0, params.askYes - params.bidYes);
  const stressedRoundTripDragUsd = Number(
    Math.max(
      KALSHI_STRESSED_DRAG_FLOOR_USD,
      2 * perContractFeeDragUsd + spreadDragUsd
    ).toFixed(4)
  );

  const grossEdgeUsd = Number((params.fvYes - entryPriceUsd).toFixed(4));
  const netExpectedEdgeUsd = Number(
    (grossEdgeUsd - stressedRoundTripDragUsd).toFixed(4)
  );

  const safeAtr14ProbUsd = Number.isFinite(params.atr14ProbUsd)
    ? Math.max(0, params.atr14ProbUsd)
    : 0;
  const requiredGrossEdgeUsd = Math.max(
    KALSHI_MIN_GROSS_EDGE_FLOOR_USD,
    KALSHI_GROSS_EDGE_BASE_USD + KALSHI_GROSS_EDGE_ATR_MULT * safeAtr14ProbUsd
  );

  const passesEdgeGate =
    safeContracts >= 1 &&
    grossEdgeUsd >= requiredGrossEdgeUsd - 1e-9 &&
    netExpectedEdgeUsd >= requiredGrossEdgeUsd - stressedRoundTripDragUsd - 1e-9;

  return {
    entryPriceUsd,
    entryFeeUsd,
    expectedExitFeeUsd,
    stressedRoundTripDragUsd,
    netExpectedEdgeUsd,
    passesEdgeGate,
  };
}
