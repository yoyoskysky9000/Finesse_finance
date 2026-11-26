export {
  SHADOW_SIDES,
  SHADOW_DECISION_OUTCOMES,
  SHADOW_FILL_STATUSES,
  SHADOW_NO_FILL_REASONS,
  SUPPORTED_SHADOW_FEE_SCHEDULES,
  ShadowExecutionValidationError,
  ShadowForecastNotFoundError,
  DecisionBookNotFoundError,
  UnsupportedFeeScheduleError,
  type ShadowOrderSide,
  type ShadowDecisionOutcome,
  type ShadowFillStatus,
  type ShadowNoFillReason,
  type SupportedShadowFeeSchedule,
  type CapturedBookSnapshot,
  type PersistOrderbookStateInput,
  type ShadowEdgeEvaluation,
  type ShadowDecisionRecord,
  type ShadowOrderRecord,
  type ShadowFillRecord,
  type ExecuteShadowOrderInput,
  type ShadowExecutionResult,
} from './types';

export {
  computeShadowFillFee,
  type ShadowFeeCalculationResult,
} from './fees';

export {
  persistOrderbookState,
  listCapturedBookSnapshotsForMarket,
  findDecisionBookSnapshot,
  findArrivalBookSnapshot,
} from './bookReader';

export {
  computeShadowEdges,
  resolveShadowForecast,
  getShadowDecision,
  getShadowOrdersForDecision,
  getShadowFillsForDecision,
  listShadowDecisionsForExperiment,
  listShadowFillsForExperiment,
  executeShadowDecision,
  createShadowExecutionEngine,
} from './engine';
