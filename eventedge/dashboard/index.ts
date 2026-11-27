export {
  DASHBOARD_SECTION_KEYS,
  DASHBOARD_SECTION_HEADINGS,
  DASHBOARD_MANDATORY_DISCLAIMER,
  DashboardValidationError,
  type DashboardSectionKey,
  type BuildDashboardOptions,
  type DashboardCalibrationSummary,
  type DashboardResearchQualitySection,
  type DashboardSlippageSummary,
  type DashboardExecutionRealismSection,
  type DashboardDataQualitySection,
  type DashboardRiskSection,
  type LedgerTableTriggerCheck,
  type LiveDisabledAssertionCheck,
  type DashboardIntegritySection,
  type DashboardPaperPnlSection,
  type DashboardSections,
  type EventEdgeDashboard,
} from './types';

export {
  escapeHtml,
  formatScore,
  formatProbability,
  formatSignedScore,
  formatPercent,
  formatCurrency,
  formatMilliseconds,
  formatInteger,
} from './formatters';

export { buildDashboard } from './assembler';
export { renderDashboardHtml } from './renderer';
