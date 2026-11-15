import { CHAMPION_CONFIG } from '../server/regimeLiquidityFilter';

export interface ActiveRiskPosition {
  symbol: string;
  notionalUsd: number;
  ask: number;
  atrDollar: number;
}

export interface CandidateRiskOrder {
  symbol: string;
  requestedNotionalUsd: number;
  ask: number;
  atrDollar: number;
  lotSizeUsd?: number;
  exchangeLotSizeContracts?: number;
}

export type CorrelationMatrix = Record<string, Record<string, number | undefined> | undefined>;

export interface PortfolioCorrelationGuardInput {
  settledCash: number;
  activePositions: ActiveRiskPosition[];
  candidate: CandidateRiskOrder;
  correlationMatrix: CorrelationMatrix;
  lotSizeUsd?: number;
  unknownCorrelation?: number;
}

export interface PortfolioCorrelationGuardResult {
  allowed: boolean;
  reason: string;
  approvedNotionalUsd: number;
  capCeilingUsd: number;
  approvedContracts: number;
  requestedNotionalUsd: number;
  perPositionCapUsd: number;
  maxRiskUsd: number;
  existingRiskUsd: number;
  candidateRiskUsd: number;
  adjustedRiskUsd: number;
  availableCandidateRiskUsd: number;
  candidateLossFraction: number;
  maxRho: number;
  maxPairwiseRho: number;
  stressMultiplier: number;
  correlationPenalty: number;
  positionCount: number;
  missingCorrelationPairs: string[];
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/**
 * Per-contract loss fraction incorporating stop-loss floor / ATR multiple and drag floor:
 * lossFraction = (Math.max(0.07, 0.9 * atrDollar) + 0.12) / ask
 */
export function getLossFraction(ask: number, atrDollar: number): number {
  if (!Number.isFinite(ask) || ask <= 0) {
    return 1.0;
  }
  const safeAtr = Number.isFinite(atrDollar) ? Math.max(0, atrDollar) : 0;
  return (Math.max(0.07, 0.9 * safeAtr) + 0.12) / ask;
}

function lookupPairwiseCorrelation(
  matrix: CorrelationMatrix,
  symbolA: string,
  symbolB: string
): number | undefined {
  const normA = normalizeSymbol(symbolA);
  const normB = normalizeSymbol(symbolB);

  const direct = matrix[symbolA]?.[symbolB] ?? matrix[symbolB]?.[symbolA];
  if (typeof direct === 'number' && Number.isFinite(direct)) {
    return direct;
  }

  for (const [k1, row] of Object.entries(matrix)) {
    if (!row) continue;
    const nk1 = normalizeSymbol(k1);
    if (nk1 === normA) {
      for (const [k2, val] of Object.entries(row)) {
        if (normalizeSymbol(k2) === normB && typeof val === 'number' && Number.isFinite(val)) {
          return val;
        }
      }
    } else if (nk1 === normB) {
      for (const [k2, val] of Object.entries(row)) {
        if (normalizeSymbol(k2) === normA && typeof val === 'number' && Number.isFinite(val)) {
          return val;
        }
      }
    }
  }

  return undefined;
}

function resolveExchangeLotStep(input: PortfolioCorrelationGuardInput): number {
  if (typeof input.lotSizeUsd === 'number' && Number.isFinite(input.lotSizeUsd) && input.lotSizeUsd > 0) {
    return input.lotSizeUsd;
  }
  if (
    typeof input.candidate.lotSizeUsd === 'number' &&
    Number.isFinite(input.candidate.lotSizeUsd) &&
    input.candidate.lotSizeUsd > 0
  ) {
    return input.candidate.lotSizeUsd;
  }
  if (
    typeof input.candidate.exchangeLotSizeContracts === 'number' &&
    Number.isFinite(input.candidate.exchangeLotSizeContracts) &&
    input.candidate.exchangeLotSizeContracts > 0 &&
    input.candidate.ask > 0
  ) {
    return input.candidate.exchangeLotSizeContracts * input.candidate.ask;
  }
  return 0.01;
}

/**
 * 2.6.0-PORTFOLIO-GUARD-CHAMPION
 * Evaluates multi-position correlation stress and enforces both the 3% per-position
 * settled-cash cap and the 3.5% 15m aggregate portfolio drawdown ceiling.
 */
export function evaluatePortfolioCorrelationAndCap(
  input: PortfolioCorrelationGuardInput
): PortfolioCorrelationGuardResult {
  const rules = CHAMPION_CONFIG.portfolio_correlation_rules;
  const perPositionCapPct = rules?.per_position_settled_cash_cap_pct ?? 0.03;
  const maxDrawdownPct15m = rules?.max_aggregate_drawdown_pct_15m ?? 0.035;
  const unknownCorrelation =
    typeof input.unknownCorrelation === 'number' && Number.isFinite(input.unknownCorrelation)
      ? Math.max(0, Math.min(1, input.unknownCorrelation))
      : rules?.unknown_correlation_default ?? 1.0;

  const settledCash = Number.isFinite(input.settledCash) ? Math.max(0, input.settledCash) : 0;
  const perPositionCapUsd = Number((settledCash * perPositionCapPct).toFixed(6));
  const maxRiskUsd = Number((settledCash * maxDrawdownPct15m).toFixed(6));
  const activePositions = input.activePositions || [];
  const candidate = input.candidate;
  const normCandidateSymbol = normalizeSymbol(candidate.symbol);
  const requestedNotionalUsd = Number.isFinite(candidate.requestedNotionalUsd)
    ? Math.max(0, candidate.requestedNotionalUsd)
    : 0;

  const candidateLossFraction = getLossFraction(candidate.ask, candidate.atrDollar);
  const existingRiskUsd = Number(
    activePositions
      .reduce(
        (sum, pos) =>
          sum + Math.max(0, Number.isFinite(pos.notionalUsd) ? pos.notionalUsd : 0) * getLossFraction(pos.ask, pos.atrDollar),
        0
      )
      .toFixed(6)
  );

  // Reject immediately if candidate.symbol is already open in activePositions
  if (activePositions.some((pos) => normalizeSymbol(pos.symbol) === normCandidateSymbol)) {
    const positionCount = activePositions.length;
    return {
      allowed: false,
      reason: `DUPLICATE_ACTIVE_SYMBOL: ${normCandidateSymbol} already exists in activePositions.`,
      approvedNotionalUsd: 0,
      capCeilingUsd: 0,
      approvedContracts: 0,
      requestedNotionalUsd,
      perPositionCapUsd,
      maxRiskUsd,
      existingRiskUsd,
      candidateRiskUsd: 0,
      adjustedRiskUsd: existingRiskUsd,
      availableCandidateRiskUsd: 0,
      candidateLossFraction,
      maxRho: 1.0,
      maxPairwiseRho: 1.0,
      stressMultiplier: positionCount > 1 ? positionCount : 1.0,
      correlationPenalty: positionCount > 1 ? 1 / positionCount : 1.0,
      positionCount,
      missingCorrelationPairs: [],
    };
  }

  if (settledCash <= 0 || candidate.ask <= 0 || requestedNotionalUsd <= 0) {
    return {
      allowed: false,
      reason:
        settledCash <= 0
          ? 'INSUFFICIENT_SETTLED_CASH'
          : candidate.ask <= 0
          ? 'INVALID_CANDIDATE_ASK_PRICE'
          : 'INVALID_REQUESTED_NOTIONAL',
      approvedNotionalUsd: 0,
      capCeilingUsd: 0,
      approvedContracts: 0,
      requestedNotionalUsd,
      perPositionCapUsd,
      maxRiskUsd,
      existingRiskUsd,
      candidateRiskUsd: 0,
      adjustedRiskUsd: existingRiskUsd,
      availableCandidateRiskUsd: 0,
      candidateLossFraction,
      maxRho: 0,
      maxPairwiseRho: 0,
      stressMultiplier: 1.0,
      correlationPenalty: 1.0,
      positionCount: activePositions.length + 1,
      missingCorrelationPairs: [],
    };
  }

  const allSymbols = [...activePositions.map((p) => normalizeSymbol(p.symbol)), normCandidateSymbol];
  const positionCount = allSymbols.length;
  const missingCorrelationPairs: string[] = [];

  let maxPairwiseRho = 0;
  if (positionCount >= 2) {
    for (let i = 0; i < positionCount; i += 1) {
      for (let j = i + 1; j < positionCount; j += 1) {
        const symA = allSymbols[i];
        const symB = allSymbols[j];
        const rawRho = lookupPairwiseCorrelation(input.correlationMatrix || {}, symA, symB);
        let effectiveRho: number;
        if (rawRho === undefined) {
          effectiveRho = unknownCorrelation;
          missingCorrelationPairs.push(`${symA}:${symB}`);
        } else {
          // Clamp negative correlations to 0; cap upper bound at 1.0
          effectiveRho = Math.max(0, Math.min(1, rawRho));
        }
        if (effectiveRho > maxPairwiseRho) {
          maxPairwiseRho = effectiveRho;
        }
      }
    }
  }

  const maxRho = maxPairwiseRho;
  const stressMultiplier = Number((1 + Math.max(0, maxPairwiseRho) * (positionCount - 1)).toFixed(8));
  const correlationPenalty = Number((1 / stressMultiplier).toFixed(8));
  const availableCandidateRiskUsd = Number(
    Math.max(0, maxRiskUsd / stressMultiplier - existingRiskUsd).toFixed(6)
  );

  const rawApprovedNotionalUsd = Math.min(
    requestedNotionalUsd,
    perPositionCapUsd,
    availableCandidateRiskUsd / candidateLossFraction
  );
  const capCeilingUsd = Number(Math.max(0, rawApprovedNotionalUsd).toFixed(4));

  const lotStep = resolveExchangeLotStep(input);
  const roundedDownNotionalUsd = Number(
    (Math.floor(Math.max(0, rawApprovedNotionalUsd) / lotStep + 1e-9) * lotStep).toFixed(6)
  );
  const approvedContracts =
    candidate.ask > 0 ? Math.floor((Math.max(0, roundedDownNotionalUsd) + 1e-9) / candidate.ask) : 0;
  const approvedNotionalUsd = Number((approvedContracts * candidate.ask).toFixed(4));

  const candidateRiskUsd = Number((approvedNotionalUsd * candidateLossFraction).toFixed(6));
  const adjustedRiskUsd = Number(((existingRiskUsd + candidateRiskUsd) * stressMultiplier).toFixed(6));

  if (approvedNotionalUsd <= 0 || adjustedRiskUsd > maxRiskUsd + 1e-9) {
    const reason =
      adjustedRiskUsd > maxRiskUsd + 1e-9
        ? `PORTFOLIO_ADJUSTED_RISK_EXCEEDED: adjustedRisk=$${adjustedRiskUsd.toFixed(4)} > maxRisk=$${maxRiskUsd.toFixed(4)} (stress=${stressMultiplier.toFixed(3)}, maxRho=${maxRho.toFixed(3)})`
        : `PORTFOLIO_CORRELATION_CAP_EXCEEDED: approvedNotional=$${approvedNotionalUsd.toFixed(2)} <= 0 (availableRisk=$${availableCandidateRiskUsd.toFixed(4)}, stress=${stressMultiplier.toFixed(3)}, maxRho=${maxRho.toFixed(3)})`;
    return {
      allowed: false,
      reason,
      approvedNotionalUsd: 0,
      capCeilingUsd,
      approvedContracts: 0,
      requestedNotionalUsd,
      perPositionCapUsd,
      maxRiskUsd,
      existingRiskUsd,
      candidateRiskUsd: 0,
      adjustedRiskUsd,
      availableCandidateRiskUsd,
      candidateLossFraction,
      maxRho,
      maxPairwiseRho,
      stressMultiplier,
      correlationPenalty,
      positionCount,
      missingCorrelationPairs,
    };
  }

  return {
    allowed: true,
    reason: 'PORTFOLIO_CORRELATION_APPROVED',
    approvedNotionalUsd,
    capCeilingUsd,
    approvedContracts,
    requestedNotionalUsd,
    perPositionCapUsd,
    maxRiskUsd,
    existingRiskUsd,
    candidateRiskUsd,
    adjustedRiskUsd,
    availableCandidateRiskUsd,
    candidateLossFraction,
    maxRho,
    maxPairwiseRho,
    stressMultiplier,
    correlationPenalty,
    positionCount,
    missingCorrelationPairs,
  };
}
