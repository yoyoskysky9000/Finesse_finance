import type { EventEdgeAllowedMode, EventEdgeConfig } from '../config/index';
import type { EventEdgeLedgerTable } from '../db/schema';
import type {
  CalibrationMethod,
  ClusterBootstrapResult,
  DenominatorTotals,
  EvaluateExperimentOptions,
  EventFamilyDenominatorReport,
  EventFamilyScoringSummary,
  GateVerdict,
  KillGateEvaluation,
} from '../evaluation/types';
import type { ExperimentStatus } from '../experiments/registry';
import type { ContractLifecycleState } from '../lifecycle/contractLifecycle';
import type { RiskSystemState } from '../risk/types';
import type { ShadowFillStatus, ShadowNoFillReason } from '../shadow/types';

export const DASHBOARD_SECTION_KEYS = [
  'researchQuality',
  'executionRealism',
  'dataQuality',
  'risk',
  'integrity',
  'paperPnl',
] as const;

export type DashboardSectionKey = (typeof DASHBOARD_SECTION_KEYS)[number];

export const DASHBOARD_SECTION_HEADINGS: Readonly<Record<DashboardSectionKey, string>> =
  Object.freeze({
    researchQuality: 'Research Quality',
    executionRealism: 'Execution Realism',
    dataQuality: 'Data Quality',
    risk: 'Risk',
    integrity: 'Integrity',
    paperPnl: 'Paper PnL (Paper Only)',
  });

export const DASHBOARD_MANDATORY_DISCLAIMER =
  'EventEdge research dashboard — paper only. Data only, not financial advice.' as const;

export class DashboardValidationError extends Error {
  public readonly code = 'EVENTEDGE_DASHBOARD_VALIDATION_ERROR' as const;

  constructor(message: string) {
    super(message);
    this.name = 'DashboardValidationError';
  }
}

export interface BuildDashboardOptions {
  /** Experiment's configured paper bankroll in USD (default 10000). */
  readonly settledCash?: number;
  /** Optional EventEdgeConfig (defaults to PAPER mode with EE-00 defaults). */
  readonly config?: EventEdgeConfig;
  /** Optional EE-04 evaluation overrides (persistCalibratedForecasts is always forced false). */
  readonly evaluationOptions?: Omit<EvaluateExperimentOptions, 'persistCalibratedForecasts'>;
}

export interface DashboardCalibrationSummary {
  readonly status: 'COMPLETED' | 'SKIPPED_INSUFFICIENT_DATA';
  readonly skipReason: string | null;
  readonly selectedMethod: CalibrationMethod | null;
  readonly trainCount: number;
  readonly validationCount: number;
  readonly forwardTestCount: number;
  readonly forwardTestRawBrier: number | null;
  readonly forwardTestCalibratedBrier: number | null;
  readonly forwardTestMarketBrier: number | null;
}

export interface DashboardResearchQualitySection {
  readonly status: GateVerdict;
  readonly verdict: GateVerdict;
  readonly verdictReasons: readonly string[];
  readonly hasSettledScores: boolean;
  readonly sampleSize: number;
  readonly modelBrier: number | null;
  readonly marketBrier: number | null;
  readonly brierDiff: number | null;
  readonly modelLogLoss: number | null;
  readonly marketLogLoss: number | null;
  readonly logLossDiff: number | null;
  readonly coverage: number;
  readonly denominatorTotals: DenominatorTotals;
  readonly denominatorByFamily: readonly EventFamilyDenominatorReport[];
  readonly perFamilyScores: readonly EventFamilyScoringSummary[];
  readonly clusterBootstrapBrierDiff: ClusterBootstrapResult;
  readonly calibrationSummary: DashboardCalibrationSummary;
  readonly killGate: KillGateEvaluation;
}

export interface DashboardSlippageSummary {
  readonly executedFillCount: number;
  readonly meanSlippageUsd: number | null;
  readonly weightedMeanSlippageUsd: number | null;
  readonly maxAdverseSlippageUsd: number | null;
  readonly minSlippageUsd: number | null;
}

export interface DashboardExecutionRealismSection {
  readonly decisionsTotal: number;
  readonly noEdgeCount: number;
  readonly ordersTotal: number;
  readonly fillsTotal: number;
  readonly fillsByStatus: Readonly<Record<ShadowFillStatus, number>>;
  readonly noFillReasons: Readonly<Record<ShadowNoFillReason, number>>;
  readonly averageBookAgeMs: number | null;
  readonly totalFeesPaidUsd: number;
  readonly slippageSummary: DashboardSlippageSummary;
}

export interface DashboardDataQualitySection {
  readonly marketsDiscovered: number;
  readonly auditsApproved: number;
  readonly auditsRejected: number;
  readonly lifecycleStateCounts: Readonly<Record<ContractLifecycleState, number>>;
  readonly snapshotsCaptured: number;
  readonly marketSnapshotsCaptured: number;
  readonly orderbookStatesCaptured: number;
  readonly forecastsTotal: number;
  readonly forecastsWithCompleteProvenance: number;
  readonly provenanceCompletenessShare: number | null;
}

export interface DashboardRiskSection {
  readonly systemState: RiskSystemState;
  readonly deployedPct: number;
  readonly maxDeployedBankrollPct: number;
  readonly exposureByEventFamily: Readonly<Record<string, number>>;
  readonly dailyPnlUsd: number;
  readonly dailyLossPct: number;
  readonly dailyLossStopPct: number;
  readonly drawdownPct: number;
  readonly peakToTroughDrawdownStopPct: number;
  readonly pendingExposureUsd: number;
}

export interface LedgerTableTriggerCheck {
  readonly tableName: EventEdgeLedgerTable;
  readonly hasBeforeUpdateAbort: boolean;
  readonly hasBeforeDeleteAbort: boolean;
  readonly passed: boolean;
}

export interface LiveDisabledAssertionCheck {
  readonly passed: boolean;
  readonly activeMode: EventEdgeAllowedMode;
  readonly detail: string;
}

export interface DashboardIntegritySection {
  readonly allTriggersPresent: boolean;
  readonly tableTriggerChecks: readonly LedgerTableTriggerCheck[];
  readonly migrationVersion: number;
  readonly appliedMigrationCount: number;
  readonly configHash: string;
  readonly liveDisabledAssertion: LiveDisabledAssertionCheck;
}

export interface DashboardPaperPnlSection {
  readonly label: 'PAPER_ONLY';
  readonly settledCashUsd: number;
  readonly realizedPnlUsd: number;
  readonly unrealizedPnlUsd: number;
  readonly totalPaperPnlUsd: number;
  readonly currentPaperEquityUsd: number;
  readonly openPositionCount: number;
}

export interface DashboardSections {
  readonly researchQuality: DashboardResearchQualitySection;
  readonly executionRealism: DashboardExecutionRealismSection;
  readonly dataQuality: DashboardDataQualitySection;
  readonly risk: DashboardRiskSection;
  readonly integrity: DashboardIntegritySection;
  readonly paperPnl: DashboardPaperPnlSection;
}

export interface EventEdgeDashboard {
  readonly experimentId: string;
  readonly experimentTitle: string;
  readonly experimentStatus: ExperimentStatus;
  readonly asOf: string;
  readonly disclaimer: typeof DASHBOARD_MANDATORY_DISCLAIMER;
  readonly sections: DashboardSections;
  readonly researchQuality: DashboardResearchQualitySection;
  readonly executionRealism: DashboardExecutionRealismSection;
  readonly dataQuality: DashboardDataQualitySection;
  readonly risk: DashboardRiskSection;
  readonly integrity: DashboardIntegritySection;
  readonly paperPnl: DashboardPaperPnlSection;
}
