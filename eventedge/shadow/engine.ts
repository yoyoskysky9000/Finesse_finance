import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  EventEdgeLiveModeDisabledError,
  assertNonLiveMode,
  computeEventEdgeConfigHash,
  type EventEdgeConfig,
} from '../config/index';
import { ExperimentNotFoundError, getExperiment } from '../experiments/registry';
import {
  getForecastsForExperiment,
  type PersistedForecastRecord,
} from '../persistence/forecastRepository';
import { findArrivalBookSnapshot, findDecisionBookSnapshot } from './bookReader';
import { computeShadowFillFee } from './fees';
import {
  ShadowExecutionValidationError,
  ShadowForecastNotFoundError,
  type CapturedBookSnapshot,
  type ExecuteShadowOrderInput,
  type ShadowDecisionOutcome,
  type ShadowDecisionRecord,
  type ShadowEdgeEvaluation,
  type ShadowExecutionResult,
  type ShadowFillRecord,
  type ShadowFillStatus,
  type ShadowNoFillReason,
  type ShadowOrderRecord,
  type ShadowOrderSide,
} from './types';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}

function deterministicHashId(prefix: string, payload: unknown): string {
  const digest = crypto
    .createHash('sha256')
    .update(canonicalJson(payload))
    .digest('hex')
    .slice(0, 24);
  return `${prefix}_${digest}`;
}

/**
 * Evaluates both decision-time edges:
 *   `edge_yes = p - yes_ask`
 *   `edge_no  = yes_bid - p`
 *
 * If `max(edge_yes, edge_no) < minConservativeEdge`, returns `NO_EDGE` with `side = null`.
 * Otherwise selects the side with the larger edge (ties broken deterministically to `BUY_YES`).
 */
export function computeShadowEdges(
  modelProbability: number,
  yesBidUsd: number,
  yesAskUsd: number,
  minConservativeEdge: number
): ShadowEdgeEvaluation {
  if (!Number.isFinite(modelProbability) || modelProbability < 0 || modelProbability > 1) {
    throw new ShadowExecutionValidationError(
      `modelProbability must be in [0, 1] (received ${String(modelProbability)}).`
    );
  }

  const edgeYes = modelProbability - yesAskUsd;
  const edgeNo = yesBidUsd - modelProbability;
  const selectedEdge = Math.max(edgeYes, edgeNo);

  if (selectedEdge < minConservativeEdge - 1e-12) {
    return Object.freeze({
      edgeYes,
      edgeNo,
      selectedEdge,
      minConservativeEdge,
      outcome: 'NO_EDGE' as const,
      side: null,
    });
  }

  const side: ShadowOrderSide = edgeYes >= edgeNo ? 'BUY_YES' : 'BUY_NO';
  return Object.freeze({
    edgeYes,
    edgeNo,
    selectedEdge,
    minConservativeEdge,
    outcome: 'ORDER_CREATED' as const,
    side,
  });
}

/**
 * Resolves the persisted forecast record to use for a shadow decision:
 * prefers `p_calibrated` when one exists for the same `(marketId, experimentId)`,
 * otherwise uses the latest numeric `p_ensemble` record.
 */
export function resolveShadowForecast(
  db: DatabaseSync,
  experimentId: string,
  marketId: string,
  options: {
    readonly explicitForecast?: PersistedForecastRecord;
    readonly preferCalibrated?: boolean;
  } = {}
): PersistedForecastRecord & { readonly forecastStage: 'p_ensemble' | 'p_calibrated'; readonly probability: number } {
  const trimmedExp = experimentId.trim();
  const trimmedMkt = marketId.trim();
  const preferCalibrated = options.preferCalibrated ?? true;

  const allExpForecasts = getForecastsForExperiment(db, trimmedExp).filter(
    (rec) => rec.marketId === trimmedMkt && rec.status === 'FORECAST' && rec.probability !== null
  );

  const calibratedCandidates = allExpForecasts.filter((r) => r.forecastStage === 'p_calibrated');
  const ensembleCandidates = allExpForecasts.filter((r) => r.forecastStage === 'p_ensemble');

  if (options.explicitForecast) {
    const exp = options.explicitForecast;
    if (exp.experimentId !== trimmedExp || exp.marketId !== trimmedMkt) {
      throw new ShadowExecutionValidationError(
        `Explicit forecast "${exp.forecastId}" does not match experimentId="${trimmedExp}" and marketId="${trimmedMkt}".`
      );
    }
    if (exp.forecastStage !== 'p_ensemble' && exp.forecastStage !== 'p_calibrated') {
      throw new ShadowExecutionValidationError(
        `Shadow execution requires forecastStage 'p_ensemble' or 'p_calibrated' (received '${exp.forecastStage}').`
      );
    }
    if (exp.status !== 'FORECAST' || exp.probability === null) {
      throw new ShadowForecastNotFoundError(
        trimmedExp,
        trimmedMkt,
        `explicit forecast "${exp.forecastId}" is abstained / non-numeric`
      );
    }

    const persisted = allExpForecasts.find((r) => r.forecastId === exp.forecastId);
    if (!persisted) {
      throw new ShadowForecastNotFoundError(
        trimmedExp,
        trimmedMkt,
        `explicit forecast "${exp.forecastId}" is not persisted in probability_forecasts`
      );
    }

    if (
      preferCalibrated &&
      persisted.forecastStage === 'p_ensemble' &&
      calibratedCandidates.length > 0
    ) {
      const latestCalibrated = calibratedCandidates[calibratedCandidates.length - 1];
      return latestCalibrated as PersistedForecastRecord & {
        readonly forecastStage: 'p_calibrated';
        readonly probability: number;
      };
    }

    return persisted as PersistedForecastRecord & {
      readonly forecastStage: 'p_ensemble' | 'p_calibrated';
      readonly probability: number;
    };
  }

  if (preferCalibrated && calibratedCandidates.length > 0) {
    const latestCalibrated = calibratedCandidates[calibratedCandidates.length - 1];
    return latestCalibrated as PersistedForecastRecord & {
      readonly forecastStage: 'p_calibrated';
      readonly probability: number;
    };
  }

  if (ensembleCandidates.length > 0) {
    const latestEnsemble = ensembleCandidates[ensembleCandidates.length - 1];
    return latestEnsemble as PersistedForecastRecord & {
      readonly forecastStage: 'p_ensemble';
      readonly probability: number;
    };
  }

  throw new ShadowForecastNotFoundError(trimmedExp, trimmedMkt);
}

interface RawShadowDecisionRow {
  decision_id: string;
  forecast_id: string;
  forecast_stage: 'p_ensemble' | 'p_calibrated';
  experiment_id: string;
  market_id: string;
  model_probability: number;
  decision_timestamp: string;
  decision_book_snapshot_id: string;
  decision_book_captured_at: string;
  decision_yes_bid_usd: number;
  decision_yes_ask_usd: number;
  edge_yes: number;
  edge_no: number;
  selected_edge: number;
  min_conservative_edge: number;
  outcome: ShadowDecisionOutcome;
  side: ShadowOrderSide | null;
  requested_quantity: number;
  config_hash: string;
  created_at: string;
}

interface RawShadowOrderRow {
  order_id: string;
  decision_id: string;
  experiment_id: string;
  forecast_id: string;
  market_id: string;
  side: ShadowOrderSide;
  requested_quantity: number;
  decision_price_usd: number;
  decision_book_snapshot_id: string;
  decision_timestamp: string;
  latency_model_version: string;
  latency_ms: number;
  arrival_timestamp: string;
  config_hash: string;
  created_at: string;
}

interface RawShadowFillRow {
  fill_id: string;
  order_id: string | null;
  decision_id: string;
  experiment_id: string;
  market_id: string;
  status: ShadowFillStatus;
  side: ShadowOrderSide | null;
  requested_quantity: number;
  filled_quantity: number;
  unfilled_quantity: number;
  fill_price_usd: number | null;
  fee_usd: number;
  fee_schedule_version: string;
  decision_book_snapshot_id: string;
  arrival_book_snapshot_id: string | null;
  arrival_book_captured_at: string | null;
  displayed_depth_at_price: number | null;
  book_age_ms: number | null;
  evaluated_at: string;
  reason_code: ShadowNoFillReason | null;
  config_hash: string;
  created_at: string;
}

function mapDecisionRow(row: RawShadowDecisionRow): ShadowDecisionRecord {
  return Object.freeze({
    decisionId: row.decision_id,
    forecastId: row.forecast_id,
    forecastStage: row.forecast_stage,
    experimentId: row.experiment_id,
    marketId: row.market_id,
    modelProbability: Number(row.model_probability),
    decisionTimestamp: row.decision_timestamp,
    decisionBookSnapshotId: row.decision_book_snapshot_id,
    decisionBookCapturedAt: row.decision_book_captured_at,
    decisionYesBidUsd: Number(row.decision_yes_bid_usd),
    decisionYesAskUsd: Number(row.decision_yes_ask_usd),
    edgeYes: Number(row.edge_yes),
    edgeNo: Number(row.edge_no),
    selectedEdge: Number(row.selected_edge),
    minConservativeEdge: Number(row.min_conservative_edge),
    outcome: row.outcome,
    side: row.side,
    requestedQuantity: Number(row.requested_quantity),
    configHash: row.config_hash,
    createdAt: row.created_at,
  });
}

function mapOrderRow(row: RawShadowOrderRow): ShadowOrderRecord {
  return Object.freeze({
    orderId: row.order_id,
    decisionId: row.decision_id,
    experimentId: row.experiment_id,
    forecastId: row.forecast_id,
    marketId: row.market_id,
    side: row.side,
    requestedQuantity: Number(row.requested_quantity),
    decisionPriceUsd: Number(row.decision_price_usd),
    decisionBookSnapshotId: row.decision_book_snapshot_id,
    decisionTimestamp: row.decision_timestamp,
    latencyModelVersion: row.latency_model_version,
    latencyMs: Number(row.latency_ms),
    arrivalTimestamp: row.arrival_timestamp,
    configHash: row.config_hash,
    createdAt: row.created_at,
  });
}

function mapFillRow(row: RawShadowFillRow): ShadowFillRecord {
  return Object.freeze({
    fillId: row.fill_id,
    orderId: row.order_id,
    decisionId: row.decision_id,
    experimentId: row.experiment_id,
    marketId: row.market_id,
    status: row.status,
    side: row.side,
    requestedQuantity: Number(row.requested_quantity),
    filledQuantity: Number(row.filled_quantity),
    unfilledQuantity: Number(row.unfilled_quantity),
    fillPriceUsd: row.fill_price_usd === null ? null : Number(row.fill_price_usd),
    feeUsd: Number(row.fee_usd),
    feeScheduleVersion: row.fee_schedule_version,
    decisionBookSnapshotId: row.decision_book_snapshot_id,
    arrivalBookSnapshotId: row.arrival_book_snapshot_id,
    arrivalBookCapturedAt: row.arrival_book_captured_at,
    displayedDepthAtPrice:
      row.displayed_depth_at_price === null ? null : Number(row.displayed_depth_at_price),
    bookAgeMs: row.book_age_ms === null ? null : Number(row.book_age_ms),
    evaluatedAt: row.evaluated_at,
    reasonCode: row.reason_code,
    configHash: row.config_hash,
    createdAt: row.created_at,
  });
}

export function getShadowDecision(
  db: DatabaseSync,
  decisionId: string
): ShadowDecisionRecord | null {
  const row = db
    .prepare(
      `SELECT
        decision_id, forecast_id, forecast_stage, experiment_id, market_id,
        model_probability, decision_timestamp,
        decision_book_snapshot_id, decision_book_captured_at,
        decision_yes_bid_usd, decision_yes_ask_usd,
        edge_yes, edge_no, selected_edge, min_conservative_edge,
        outcome, side, requested_quantity, config_hash, created_at
      FROM shadow_decisions
      WHERE decision_id = ?
      LIMIT 1`
    )
    .get(decisionId.trim()) as unknown as RawShadowDecisionRow | undefined;

  return row ? mapDecisionRow(row) : null;
}

export function getShadowOrdersForDecision(
  db: DatabaseSync,
  decisionId: string
): ShadowOrderRecord[] {
  const rows = db
    .prepare(
      `SELECT
        order_id, decision_id, experiment_id, forecast_id, market_id,
        side, requested_quantity, decision_price_usd,
        decision_book_snapshot_id, decision_timestamp,
        latency_model_version, latency_ms, arrival_timestamp,
        config_hash, created_at
      FROM shadow_orders
      WHERE decision_id = ?
      ORDER BY rowid ASC`
    )
    .all(decisionId.trim()) as unknown as RawShadowOrderRow[];

  return rows.map(mapOrderRow);
}

export function getShadowFillsForDecision(
  db: DatabaseSync,
  decisionId: string
): ShadowFillRecord[] {
  const rows = db
    .prepare(
      `SELECT
        fill_id, order_id, decision_id, experiment_id, market_id,
        status, side, requested_quantity, filled_quantity, unfilled_quantity,
        fill_price_usd, fee_usd, fee_schedule_version,
        decision_book_snapshot_id, arrival_book_snapshot_id, arrival_book_captured_at,
        displayed_depth_at_price, book_age_ms, evaluated_at, reason_code,
        config_hash, created_at
      FROM shadow_fills
      WHERE decision_id = ?
      ORDER BY rowid ASC`
    )
    .all(decisionId.trim()) as unknown as RawShadowFillRow[];

  return rows.map(mapFillRow);
}

export function listShadowDecisionsForExperiment(
  db: DatabaseSync,
  experimentId: string
): ShadowDecisionRecord[] {
  const rows = db
    .prepare(
      `SELECT
        decision_id, forecast_id, forecast_stage, experiment_id, market_id,
        model_probability, decision_timestamp,
        decision_book_snapshot_id, decision_book_captured_at,
        decision_yes_bid_usd, decision_yes_ask_usd,
        edge_yes, edge_no, selected_edge, min_conservative_edge,
        outcome, side, requested_quantity, config_hash, created_at
      FROM shadow_decisions
      WHERE experiment_id = ?
      ORDER BY decision_timestamp ASC, rowid ASC`
    )
    .all(experimentId.trim()) as unknown as RawShadowDecisionRow[];

  return rows.map(mapDecisionRow);
}

export function listShadowFillsForExperiment(
  db: DatabaseSync,
  experimentId: string
): ShadowFillRecord[] {
  const rows = db
    .prepare(
      `SELECT
        fill_id, order_id, decision_id, experiment_id, market_id,
        status, side, requested_quantity, filled_quantity, unfilled_quantity,
        fill_price_usd, fee_usd, fee_schedule_version,
        decision_book_snapshot_id, arrival_book_snapshot_id, arrival_book_captured_at,
        displayed_depth_at_price, book_age_ms, evaluated_at, reason_code,
        config_hash, created_at
      FROM shadow_fills
      WHERE experiment_id = ?
      ORDER BY evaluated_at ASC, rowid ASC`
    )
    .all(experimentId.trim()) as unknown as RawShadowFillRow[];

  return rows.map(mapFillRow);
}

function validateConfigNonLive(config: EventEdgeConfig): void {
  if (!config || typeof config !== 'object') {
    throw new ShadowExecutionValidationError('EventEdgeConfig is required.');
  }
  assertNonLiveMode(config.mode, 'shadow.executeShadowDecision');
  if (config.liveEnabled !== false) {
    throw new EventEdgeLiveModeDisabledError('shadow.executeShadowDecision#liveEnabled');
  }
}

/**
 * Executes the binding EventEdge paper-only shadow-fill contract:
 * 1. Resolves registered experiment & persisted forecast (`p_calibrated` preferred over `p_ensemble`).
 * 2. Reads decision-time book snapshot (`captured_at <= decision_timestamp`) and computes `edge_yes`, `edge_no`.
 * 3. If max edge < `minConservativeEdge`, records `shadow_decisions` (`NO_EDGE`), creates NO order row,
 *    and records `shadow_fills` (`NO_FILL` / `NO_EDGE`).
 * 4. Otherwise creates an immutable `shadow_orders` row, advances time by `latencyMs` to `arrivalTimestamp`,
 *    reads the earliest book snapshot at or after `arrivalTimestamp`, checks `BOOK_NOT_CAPTURED` / `STALE_BOOK` /
 *    `INSUFFICIENT_DEPTH`, simulates top-of-book fill at arrival price (`yes_ask` for BUY_YES, `1 - yes_bid` for
 *    BUY_NO) capped by displayed depth, computes versioned Kalshi taker fee, and persists `shadow_fills`.
 *
 * Strictly paper-only: zero credentials, zero network calls, zero live order placement,
 * and never writes marks or settlements.
 */
export function executeShadowDecision(
  db: DatabaseSync,
  input: ExecuteShadowOrderInput
): ShadowExecutionResult {
  validateConfigNonLive(input.config);

  const experimentId = input.experimentId.trim();
  const marketId = input.marketId.trim();
  if (!experimentId || !marketId) {
    throw new ShadowExecutionValidationError('experimentId and marketId must be non-empty strings.');
  }

  if (!Number.isInteger(input.requestedQuantity) || input.requestedQuantity <= 0) {
    throw new ShadowExecutionValidationError(
      `requestedQuantity must be a positive integer (received ${String(input.requestedQuantity)}).`
    );
  }

  // Validate fee schedule upfront (fail fast before any DB writes)
  computeShadowFillFee(0, 0.5, input.config.shadow.feeScheduleVersion);

  const experiment = getExperiment(db, experimentId);
  if (!experiment) {
    throw new ExperimentNotFoundError(experimentId);
  }

  const forecast = resolveShadowForecast(db, experimentId, marketId, {
    explicitForecast: input.forecast,
    preferCalibrated: input.preferCalibrated ?? true,
  });

  const decisionTimestamp = input.decisionTimestamp?.trim() || forecast.forecastTimestamp;
  const decisionEpochMs = Date.parse(decisionTimestamp);
  if (!Number.isFinite(decisionEpochMs)) {
    throw new ShadowExecutionValidationError(
      `Invalid decisionTimestamp "${decisionTimestamp}". Expected ISO-8601 UTC timestamp.`
    );
  }

  const configHash = computeEventEdgeConfigHash(input.config);

  // 1. Decision-time book snapshot (<= decisionTimestamp)
  const decisionBook: CapturedBookSnapshot = findDecisionBookSnapshot(
    db,
    marketId,
    decisionTimestamp,
    input.decisionBookSnapshotId
  );

  // 2. Edge gate
  const edgeEval = computeShadowEdges(
    forecast.probability,
    decisionBook.yesBidUsd,
    decisionBook.yesAskUsd,
    input.config.risk.minConservativeEdge
  );

  // Deterministic decision_id hash of inputs
  const decisionId = deterministicHashId('sdec', {
    experimentId,
    forecastId: forecast.forecastId,
    forecastStage: forecast.forecastStage,
    marketId,
    modelProbability: forecast.probability,
    decisionTimestamp,
    decisionBookSnapshotId: decisionBook.snapshotId,
    decisionBookCapturedAt: decisionBook.capturedAt,
    requestedQuantity: input.requestedQuantity,
    configHash,
  });

  // Deterministic idempotent replay check if this exact decision_id is already persisted
  const existingDecision = getShadowDecision(db, decisionId);
  if (existingDecision) {
    const existingOrders = getShadowOrdersForDecision(db, decisionId);
    const existingFills = getShadowFillsForDecision(db, decisionId);
    const existingOrder = existingOrders[0] ?? null;
    const existingFill = existingFills[0];
    if (existingFill) {
      const arrivalBook =
        existingOrder && existingFill.arrivalBookSnapshotId
          ? findArrivalBookSnapshot(db, marketId, existingOrder.arrivalTimestamp)
          : null;
      return Object.freeze({
        decision: existingDecision,
        order: existingOrder,
        fill: existingFill,
        decisionBook,
        arrivalBook,
        replayed: true,
      });
    }
  }

  // 3. Latency model + arrival book + fill simulation
  let orderPayload: {
    orderId: string;
    side: ShadowOrderSide;
    decisionPriceUsd: number;
    arrivalTimestamp: string;
  } | null = null;
  let arrivalBook: CapturedBookSnapshot | null = null;

  let fillStatus: ShadowFillStatus;
  let filledQuantity = 0;
  let unfilledQuantity = input.requestedQuantity;
  let fillPriceUsd: number | null = null;
  let feeUsd = 0;
  let displayedDepthAtPrice: number | null = null;
  let bookAgeMs: number | null = null;
  let evaluatedAt: string;
  let reasonCode: ShadowNoFillReason | null = null;

  if (edgeEval.outcome === 'NO_EDGE' || edgeEval.side === null) {
    fillStatus = 'NO_FILL';
    reasonCode = 'NO_EDGE';
    evaluatedAt = input.evaluatedAt?.trim() || decisionTimestamp;
    if (!Number.isFinite(Date.parse(evaluatedAt))) {
      throw new ShadowExecutionValidationError(`Invalid evaluatedAt "${evaluatedAt}".`);
    }
  } else {
    const side = edgeEval.side;
    const decisionPriceUsd =
      side === 'BUY_YES'
        ? decisionBook.yesAskUsd
        : Number((1 - decisionBook.yesBidUsd).toFixed(6));

    const arrivalEpochMs = decisionEpochMs + input.config.shadow.latencyMs;
    const arrivalTimestamp = new Date(arrivalEpochMs).toISOString();

    const orderId = deterministicHashId('sord', {
      decisionId,
      side,
      requestedQuantity: input.requestedQuantity,
      decisionPriceUsd,
      decisionBookSnapshotId: decisionBook.snapshotId,
      decisionTimestamp,
      latencyModelVersion: input.config.shadow.latencyModelVersion,
      latencyMs: input.config.shadow.latencyMs,
      arrivalTimestamp,
      configHash,
    });

    orderPayload = {
      orderId,
      side,
      decisionPriceUsd,
      arrivalTimestamp,
    };

    arrivalBook = findArrivalBookSnapshot(db, marketId, arrivalTimestamp);

    if (!arrivalBook) {
      fillStatus = 'NO_FILL';
      reasonCode = 'BOOK_NOT_CAPTURED';
      evaluatedAt = input.evaluatedAt?.trim() || arrivalTimestamp;
      if (!Number.isFinite(Date.parse(evaluatedAt))) {
        throw new ShadowExecutionValidationError(`Invalid evaluatedAt "${evaluatedAt}".`);
      }
    } else {
      evaluatedAt = input.evaluatedAt?.trim() || arrivalBook.capturedAt;
      const evaluatedEpochMs = Date.parse(evaluatedAt);
      const arrivalBookEpochMs = Date.parse(arrivalBook.capturedAt);
      if (!Number.isFinite(evaluatedEpochMs)) {
        throw new ShadowExecutionValidationError(`Invalid evaluatedAt "${evaluatedAt}".`);
      }
      if (evaluatedEpochMs < arrivalBookEpochMs) {
        throw new ShadowExecutionValidationError(
          `evaluatedAt ("${evaluatedAt}") cannot precede arrival book captured_at ("${arrivalBook.capturedAt}").`
        );
      }

      bookAgeMs = evaluatedEpochMs - arrivalBookEpochMs;
      const rawDisplayedDepth =
        side === 'BUY_YES' ? arrivalBook.yesAskSize : arrivalBook.yesBidSize;
      displayedDepthAtPrice = rawDisplayedDepth;

      if (bookAgeMs > input.config.shadow.maxBookAgeMs) {
        fillStatus = 'NO_FILL';
        reasonCode = 'STALE_BOOK';
      } else {
        const fillableContracts = Math.max(0, Math.floor(rawDisplayedDepth));
        if (fillableContracts <= 0) {
          fillStatus = 'NO_FILL';
          reasonCode = 'INSUFFICIENT_DEPTH';
        } else {
          fillPriceUsd =
            side === 'BUY_YES'
              ? arrivalBook.yesAskUsd
              : Number((1 - arrivalBook.yesBidUsd).toFixed(6));

          filledQuantity = Math.min(input.requestedQuantity, fillableContracts);
          unfilledQuantity = input.requestedQuantity - filledQuantity;
          fillStatus = unfilledQuantity === 0 ? 'FILLED' : 'PARTIAL';
          reasonCode = null;

          const feeCalc = computeShadowFillFee(
            filledQuantity,
            fillPriceUsd,
            input.config.shadow.feeScheduleVersion
          );
          feeUsd = feeCalc.feeUsd;
        }
      }
    }
  }

  const fillId = deterministicHashId('sfil', {
    decisionId,
    orderId: orderPayload?.orderId ?? null,
    status: fillStatus,
    side: edgeEval.side,
    requestedQuantity: input.requestedQuantity,
    filledQuantity,
    unfilledQuantity,
    fillPriceUsd,
    feeUsd,
    feeScheduleVersion: input.config.shadow.feeScheduleVersion,
    decisionBookSnapshotId: decisionBook.snapshotId,
    arrivalBookSnapshotId: arrivalBook?.snapshotId ?? null,
    arrivalBookCapturedAt: arrivalBook?.capturedAt ?? null,
    bookAgeMs,
    evaluatedAt,
    reasonCode,
    configHash,
  });

  // 4. Persist atomically into shadow_decisions, (optional) shadow_orders, and shadow_fills
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO shadow_decisions (
        decision_id, forecast_id, forecast_stage, experiment_id, market_id,
        model_probability, decision_timestamp,
        decision_book_snapshot_id, decision_book_captured_at,
        decision_yes_bid_usd, decision_yes_ask_usd,
        edge_yes, edge_no, selected_edge, min_conservative_edge,
        outcome, side, requested_quantity, config_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      decisionId,
      forecast.forecastId,
      forecast.forecastStage,
      experimentId,
      marketId,
      forecast.probability,
      decisionTimestamp,
      decisionBook.snapshotId,
      decisionBook.capturedAt,
      decisionBook.yesBidUsd,
      decisionBook.yesAskUsd,
      edgeEval.edgeYes,
      edgeEval.edgeNo,
      edgeEval.selectedEdge,
      edgeEval.minConservativeEdge,
      edgeEval.outcome,
      edgeEval.side,
      input.requestedQuantity,
      configHash
    );

    if (orderPayload) {
      db.prepare(
        `INSERT INTO shadow_orders (
          order_id, decision_id, experiment_id, forecast_id, market_id,
          side, requested_quantity, decision_price_usd,
          decision_book_snapshot_id, decision_timestamp,
          latency_model_version, latency_ms, arrival_timestamp, config_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        orderPayload.orderId,
        decisionId,
        experimentId,
        forecast.forecastId,
        marketId,
        orderPayload.side,
        input.requestedQuantity,
        orderPayload.decisionPriceUsd,
        decisionBook.snapshotId,
        decisionTimestamp,
        input.config.shadow.latencyModelVersion,
        input.config.shadow.latencyMs,
        orderPayload.arrivalTimestamp,
        configHash
      );
    }

    db.prepare(
      `INSERT INTO shadow_fills (
        fill_id, order_id, decision_id, experiment_id, market_id,
        status, side, requested_quantity, filled_quantity, unfilled_quantity,
        fill_price_usd, fee_usd, fee_schedule_version,
        decision_book_snapshot_id, arrival_book_snapshot_id, arrival_book_captured_at,
        displayed_depth_at_price, book_age_ms, evaluated_at, reason_code, config_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      fillId,
      orderPayload?.orderId ?? null,
      decisionId,
      experimentId,
      marketId,
      fillStatus,
      edgeEval.side,
      input.requestedQuantity,
      filledQuantity,
      unfilledQuantity,
      fillPriceUsd,
      feeUsd,
      input.config.shadow.feeScheduleVersion,
      decisionBook.snapshotId,
      arrivalBook?.snapshotId ?? null,
      arrivalBook?.capturedAt ?? null,
      displayedDepthAtPrice,
      bookAgeMs,
      evaluatedAt,
      reasonCode,
      configHash
    );

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ignore rollback error
    }
    throw err;
  }

  const savedDecision = getShadowDecision(db, decisionId)!;
  const savedOrder = orderPayload ? (getShadowOrdersForDecision(db, decisionId)[0] ?? null) : null;
  const savedFill = getShadowFillsForDecision(db, decisionId)[0]!;

  return Object.freeze({
    decision: savedDecision,
    order: savedOrder,
    fill: savedFill,
    decisionBook,
    arrivalBook,
    replayed: false,
  });
}

/**
 * Convenience factory binding a SQLite ledger handle to expose paper-only shadow execution operations.
 */
export function createShadowExecutionEngine(db: DatabaseSync): {
  readonly executeShadowDecision: (input: ExecuteShadowOrderInput) => ShadowExecutionResult;
  readonly getShadowDecision: (decisionId: string) => ShadowDecisionRecord | null;
  readonly getShadowOrdersForDecision: (decisionId: string) => ShadowOrderRecord[];
  readonly getShadowFillsForDecision: (decisionId: string) => ShadowFillRecord[];
  readonly listShadowDecisionsForExperiment: (experimentId: string) => ShadowDecisionRecord[];
  readonly listShadowFillsForExperiment: (experimentId: string) => ShadowFillRecord[];
} {
  return Object.freeze({
    executeShadowDecision: (input: ExecuteShadowOrderInput) => executeShadowDecision(db, input),
    getShadowDecision: (decisionId: string) => getShadowDecision(db, decisionId),
    getShadowOrdersForDecision: (decisionId: string) => getShadowOrdersForDecision(db, decisionId),
    getShadowFillsForDecision: (decisionId: string) => getShadowFillsForDecision(db, decisionId),
    listShadowDecisionsForExperiment: (experimentId: string) =>
      listShadowDecisionsForExperiment(db, experimentId),
    listShadowFillsForExperiment: (experimentId: string) =>
      listShadowFillsForExperiment(db, experimentId),
  });
}
