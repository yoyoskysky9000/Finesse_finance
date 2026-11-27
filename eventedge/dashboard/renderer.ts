import { CONTRACT_LIFECYCLE_STATES } from '../lifecycle/contractLifecycle';
import {
  escapeHtml,
  formatCurrency,
  formatInteger,
  formatMilliseconds,
  formatPercent,
  formatScore,
  formatSignedScore,
} from './formatters';
import {
  DASHBOARD_MANDATORY_DISCLAIMER,
  DASHBOARD_SECTION_HEADINGS,
  type EventEdgeDashboard,
} from './types';

const INLINE_STYLES = `
:root {
  --bg: #f8fafc;
  --surface: #ffffff;
  --border: #e2e8f0;
  --text: #0f172a;
  --muted: #475569;
  --pass: #15803d;
  --pass-bg: #dcfce7;
  --fail: #b91c1c;
  --fail-bg: #fee2e2;
  --warn: #a16207;
  --warn-bg: #fef9c3;
  --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  --sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 24px;
  font-family: var(--sans);
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
}
main {
  max-width: 1080px;
  margin: 0 auto;
}
header.page-header {
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
}
h1 {
  margin: 0 0 12px 0;
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.verdict-banner {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 12px;
  padding: 14px 18px;
  border-radius: 8px;
  border: 1px solid var(--border);
  margin-bottom: 12px;
}
.verdict-pass { background: var(--pass-bg); color: var(--pass); border-color: #86efac; }
.verdict-fail { background: var(--fail-bg); color: var(--fail); border-color: #fca5a5; }
.verdict-insufficient { background: var(--warn-bg); color: var(--warn); border-color: #fde047; }
.verdict-label {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 600;
}
.verdict-value {
  font-family: var(--mono);
  font-size: 20px;
  font-weight: 700;
}
.meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  font-size: 13px;
  color: var(--muted);
}
.disclaimer {
  margin: 12px 0 0 0;
  font-size: 12px;
  color: var(--muted);
  font-style: italic;
}
section.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 20px;
}
h2 {
  margin: 0 0 14px 0;
  font-size: 18px;
  font-weight: 700;
  border-bottom: 1px solid var(--border);
  padding-bottom: 8px;
}
h3 {
  margin: 16px 0 8px 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(175px, 1fr));
  gap: 12px;
  margin-bottom: 12px;
}
.kpi {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px 12px;
  background: #fcfdff;
}
.kpi-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
}
.kpi-val {
  font-family: var(--mono);
  font-size: 16px;
  font-weight: 600;
  margin-top: 4px;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  margin-top: 8px;
}
th, td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}
th {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
  background: #f8fafc;
}
td.num, th.num {
  text-align: right;
  font-family: var(--mono);
}
.mono { font-family: var(--mono); }
.note {
  font-size: 13px;
  color: var(--muted);
  margin: 8px 0;
}
.status-ok { color: var(--pass); font-weight: 600; }
.status-bad { color: var(--fail); font-weight: 600; }
.reason-list {
  margin: 8px 0 0 18px;
  padding: 0;
  font-size: 13px;
  color: var(--muted);
}
footer.page-footer {
  margin-top: 24px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  font-size: 12px;
  color: var(--muted);
}
`.trim();

function verdictCssClass(verdict: EventEdgeDashboard['researchQuality']['verdict']): string {
  if (verdict === 'PASS') return 'verdict-pass';
  if (verdict === 'FAIL') return 'verdict-fail';
  return 'verdict-insufficient';
}

function renderKpi(label: string, value: string): string {
  return `<div class="kpi"><div class="kpi-label">${escapeHtml(label)}</div><div class="kpi-val">${escapeHtml(value)}</div></div>`;
}

function renderResearchQualityHtml(dashboard: EventEdgeDashboard): string {
  const rq = dashboard.researchQuality;
  const denom = rq.denominatorTotals;

  const reasonsHtml =
    rq.verdictReasons.length > 0
      ? `<ul class="reason-list">${rq.verdictReasons
          .map((r) => `<li>${escapeHtml(r)}</li>`)
          .join('')}</ul>`
      : '';

  let scoresBlock: string;
  if (!rq.hasSettledScores) {
    scoresBlock = `
      <p class="note"><strong>Status: ${escapeHtml(rq.status)}</strong> — No settled forecasts have been scored yet. Scores are withheld rather than fabricated.</p>
      <div class="kpi-grid">
        ${renderKpi('Gate Verdict', rq.verdict)}
        ${renderKpi('Discovered Markets', formatInteger(denom.discovered))}
        ${renderKpi('Rejected by Audit', formatInteger(denom.rejectedByAudit))}
        ${renderKpi('Abstained', formatInteger(denom.abstained))}
        ${renderKpi('Forecasted', formatInteger(denom.forecasted))}
        ${renderKpi('Settled', formatInteger(denom.settled))}
        ${renderKpi('Settled Scored', formatInteger(denom.settledScored))}
        ${renderKpi('Coverage', formatPercent(rq.coverage))}
      </div>
    `;
  } else {
    const ci = rq.clusterBootstrapBrierDiff;
    const ciText =
      ci.lower !== null && ci.upper !== null
        ? `[${formatSignedScore(ci.lower)}, ${formatSignedScore(ci.upper)}]`
        : 'N/A';

    const familyRows = rq.perFamilyScores
      .map(
        (fam) => `
          <tr>
            <td class="mono">${escapeHtml(fam.eventFamilyId)}</td>
            <td class="num">${formatInteger(fam.sampleCount)}</td>
            <td class="num">${formatScore(fam.model.brierScore)}</td>
            <td class="num">${formatScore(fam.marketReference.brierScore)}</td>
            <td class="num">${formatSignedScore(fam.brierDiff)}</td>
            <td class="num">${formatScore(fam.model.logLoss)}</td>
            <td class="num">${formatScore(fam.marketReference.logLoss)}</td>
          </tr>`
      )
      .join('');

    const familyTable =
      rq.perFamilyScores.length > 0
        ? `
          <h3>Per-Family Scores</h3>
          <table>
            <thead>
              <tr>
                <th>Event Family</th>
                <th class="num">Settled N</th>
                <th class="num">Model Brier</th>
                <th class="num">Market Brier</th>
                <th class="num">Brier Diff</th>
                <th class="num">Model Log Loss</th>
                <th class="num">Market Log Loss</th>
              </tr>
            </thead>
            <tbody>${familyRows}</tbody>
          </table>`
        : '';

    const cal = rq.calibrationSummary;
    const calibrationBlock = `
      <h3>Calibration Summary</h3>
      <div class="kpi-grid">
        ${renderKpi('Calibration Status', cal.status)}
        ${renderKpi('Selected Method', cal.selectedMethod ?? 'None')}
        ${renderKpi('Splits (Train/Val/Test)', `${cal.trainCount} / ${cal.validationCount} / ${cal.forwardTestCount}`)}
        ${renderKpi('Forward Raw Brier', formatScore(cal.forwardTestRawBrier))}
        ${renderKpi('Forward Calibrated Brier', formatScore(cal.forwardTestCalibratedBrier))}
        ${renderKpi('Forward Market Brier', formatScore(cal.forwardTestMarketBrier))}
      </div>
      ${cal.skipReason ? `<p class="note">${escapeHtml(cal.skipReason)}</p>` : ''}
    `;

    scoresBlock = `
      <div class="kpi-grid">
        ${renderKpi('Gate Verdict', rq.verdict)}
        ${renderKpi('Identical Settled N', formatInteger(rq.sampleSize))}
        ${renderKpi('Model Brier', formatScore(rq.modelBrier))}
        ${renderKpi('Market Brier', formatScore(rq.marketBrier))}
        ${renderKpi('Brier Diff (Model - Mkt)', formatSignedScore(rq.brierDiff))}
        ${renderKpi('Model Log Loss', formatScore(rq.modelLogLoss))}
        ${renderKpi('Market Log Loss', formatScore(rq.marketLogLoss))}
        ${renderKpi('Clustered 95% CI', ciText)}
        ${renderKpi('Coverage', formatPercent(rq.coverage))}
      </div>
      ${familyTable}
      ${calibrationBlock}
    `;
  }

  return `
    <section class="card" id="section-research-quality">
      <h2>${escapeHtml(DASHBOARD_SECTION_HEADINGS.researchQuality)}</h2>
      ${scoresBlock}
      ${reasonsHtml}
    </section>
  `;
}

function renderExecutionRealismHtml(dashboard: EventEdgeDashboard): string {
  const ex = dashboard.executionRealism;
  const slip = ex.slippageSummary;

  return `
    <section class="card" id="section-execution-realism">
      <h2>${escapeHtml(DASHBOARD_SECTION_HEADINGS.executionRealism)}</h2>
      <div class="kpi-grid">
        ${renderKpi('Shadow Decisions', formatInteger(ex.decisionsTotal))}
        ${renderKpi('NO_EDGE Decisions', formatInteger(ex.noEdgeCount))}
        ${renderKpi('Shadow Orders', formatInteger(ex.ordersTotal))}
        ${renderKpi('Filled', formatInteger(ex.fillsByStatus.FILLED))}
        ${renderKpi('Partial Fills', formatInteger(ex.fillsByStatus.PARTIAL))}
        ${renderKpi('No Fill', formatInteger(ex.fillsByStatus.NO_FILL))}
        ${renderKpi('Avg Book Age', formatMilliseconds(ex.averageBookAgeMs))}
        ${renderKpi('Shadow Fees Paid', formatCurrency(ex.totalFeesPaidUsd))}
      </div>
      <h3>NO_FILL Reason Breakdown</h3>
      <table>
        <thead>
          <tr>
            <th>Reason Code</th>
            <th class="num">Count</th>
          </tr>
        </thead>
        <tbody>
          <tr><td class="mono">NO_EDGE</td><td class="num">${formatInteger(ex.noFillReasons.NO_EDGE)}</td></tr>
          <tr><td class="mono">BOOK_NOT_CAPTURED</td><td class="num">${formatInteger(ex.noFillReasons.BOOK_NOT_CAPTURED)}</td></tr>
          <tr><td class="mono">STALE_BOOK</td><td class="num">${formatInteger(ex.noFillReasons.STALE_BOOK)}</td></tr>
          <tr><td class="mono">INSUFFICIENT_DEPTH</td><td class="num">${formatInteger(ex.noFillReasons.INSUFFICIENT_DEPTH)}</td></tr>
        </tbody>
      </table>
      <h3>Fill-Price vs Decision-Price Slippage</h3>
      <div class="kpi-grid">
        ${renderKpi('Executed Fills', formatInteger(slip.executedFillCount))}
        ${renderKpi('Mean Slippage', formatSignedScore(slip.meanSlippageUsd))}
        ${renderKpi('Qty-Weighted Slippage', formatSignedScore(slip.weightedMeanSlippageUsd))}
        ${renderKpi('Max Adverse Slippage', formatSignedScore(slip.maxAdverseSlippageUsd))}
      </div>
    </section>
  `;
}

function renderDataQualityHtml(dashboard: EventEdgeDashboard): string {
  const dq = dashboard.dataQuality;
  const lifecycleRows = CONTRACT_LIFECYCLE_STATES.map(
    (st) => `<tr><td class="mono">${escapeHtml(st)}</td><td class="num">${formatInteger(dq.lifecycleStateCounts[st])}</td></tr>`
  ).join('');

  return `
    <section class="card" id="section-data-quality">
      <h2>${escapeHtml(DASHBOARD_SECTION_HEADINGS.dataQuality)}</h2>
      <div class="kpi-grid">
        ${renderKpi('Markets Discovered', formatInteger(dq.marketsDiscovered))}
        ${renderKpi('Audits Approved', formatInteger(dq.auditsApproved))}
        ${renderKpi('Audits Rejected', formatInteger(dq.auditsRejected))}
        ${renderKpi('Snapshots Captured', formatInteger(dq.snapshotsCaptured))}
        ${renderKpi('Forecasts Recorded', formatInteger(dq.forecastsTotal))}
        ${renderKpi('Complete Provenance Share', formatPercent(dq.provenanceCompletenessShare))}
      </div>
      <h3>Contract Lifecycle State Counts</h3>
      <table>
        <thead>
          <tr>
            <th>Lifecycle State</th>
            <th class="num">Markets</th>
          </tr>
        </thead>
        <tbody>${lifecycleRows}</tbody>
      </table>
    </section>
  `;
}

function renderRiskHtml(dashboard: EventEdgeDashboard): string {
  const rk = dashboard.risk;
  const families = Object.keys(rk.exposureByEventFamily).sort();

  const familyExposureTable =
    families.length > 0
      ? `
        <h3>Exposure by Event Family</h3>
        <table>
          <thead>
            <tr>
              <th>Event Family</th>
              <th class="num">Worst-Case Exposure</th>
            </tr>
          </thead>
          <tbody>
            ${families
              .map(
                (fam) =>
                  `<tr><td class="mono">${escapeHtml(fam)}</td><td class="num">${formatCurrency(rk.exposureByEventFamily[fam])}</td></tr>`
              )
              .join('')}
          </tbody>
        </table>`
      : '<p class="note">No open event-family exposure recorded as of this timestamp.</p>';

  return `
    <section class="card" id="section-risk">
      <h2>${escapeHtml(DASHBOARD_SECTION_HEADINGS.risk)}</h2>
      <div class="kpi-grid">
        ${renderKpi('System State', rk.systemState)}
        ${renderKpi('Deployed vs Cap', `${formatPercent(rk.deployedPct)} / ${formatPercent(rk.maxDeployedBankrollPct)}`)}
        ${renderKpi('Daily Loss vs Stop', `${formatPercent(rk.dailyLossPct)} / ${formatPercent(rk.dailyLossStopPct)}`)}
        ${renderKpi('Drawdown vs Stop', `${formatPercent(rk.drawdownPct)} / ${formatPercent(rk.peakToTroughDrawdownStopPct)}`)}
        ${renderKpi('Pending Exposure', formatCurrency(rk.pendingExposureUsd))}
      </div>
      ${familyExposureTable}
    </section>
  `;
}

function renderIntegrityHtml(dashboard: EventEdgeDashboard): string {
  const ig = dashboard.integrity;
  const triggerRows = ig.tableTriggerChecks
    .map(
      (chk) => `
        <tr>
          <td class="mono">${escapeHtml(chk.tableName)}</td>
          <td class="${chk.hasBeforeUpdateAbort ? 'status-ok' : 'status-bad'}">${chk.hasBeforeUpdateAbort ? 'PASS' : 'FAIL'}</td>
          <td class="${chk.hasBeforeDeleteAbort ? 'status-ok' : 'status-bad'}">${chk.hasBeforeDeleteAbort ? 'PASS' : 'FAIL'}</td>
          <td class="${chk.passed ? 'status-ok' : 'status-bad'}">${chk.passed ? 'IMMUTABLE' : 'MISSING'}</td>
        </tr>`
    )
    .join('');

  return `
    <section class="card" id="section-integrity">
      <h2>${escapeHtml(DASHBOARD_SECTION_HEADINGS.integrity)}</h2>
      <div class="kpi-grid">
        ${renderKpi('LIVE Mode Lock', ig.liveDisabledAssertion.passed ? 'PASS (DISABLED)' : 'FAIL')}
        ${renderKpi('Active Mode', ig.liveDisabledAssertion.activeMode)}
        ${renderKpi('Ledger Migration Version', `v${ig.migrationVersion} (${ig.appliedMigrationCount} applied)`)}
        ${renderKpi('All Triggers Present', ig.allTriggersPresent ? 'PASS' : 'FAIL')}
      </div>
      <p class="note"><strong>Config Hash:</strong> <span class="mono">${escapeHtml(ig.configHash)}</span></p>
      <p class="note">${escapeHtml(ig.liveDisabledAssertion.detail)}</p>
      <h3>Append-Only Ledger Trigger Checks</h3>
      <table>
        <thead>
          <tr>
            <th>Ledger Table</th>
            <th>BEFORE UPDATE</th>
            <th>BEFORE DELETE</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${triggerRows}</tbody>
      </table>
    </section>
  `;
}

function renderPaperPnlHtml(dashboard: EventEdgeDashboard): string {
  const pnl = dashboard.paperPnl;
  return `
    <section class="card" id="section-paper-pnl">
      <h2>${escapeHtml(DASHBOARD_SECTION_HEADINGS.paperPnl)}</h2>
      <p class="note">Strictly simulated paper ledger accounting (${escapeHtml(pnl.label)}). No live capital or brokerage fills.</p>
      <div class="kpi-grid">
        ${renderKpi('Realized Paper PnL', formatCurrency(pnl.realizedPnlUsd, { signed: true }))}
        ${renderKpi('Unrealized Paper PnL', formatCurrency(pnl.unrealizedPnlUsd, { signed: true }))}
        ${renderKpi('Total Paper PnL', formatCurrency(pnl.totalPaperPnlUsd, { signed: true }))}
        ${renderKpi('Paper Bankroll (Settled Cash)', formatCurrency(pnl.settledCashUsd))}
        ${renderKpi('Paper Equity', formatCurrency(pnl.currentPaperEquityUsd))}
        ${renderKpi('Open Paper Positions', formatInteger(pnl.openPositionCount))}
      </div>
    </section>
  `;
}

/**
 * Pure, self-contained HTML renderer for an `EventEdgeDashboard`.
 *
 * Constraints enforced:
 * - Single self-contained HTML string with inline CSS only (no external assets, no scripts).
 * - Gate verdict is the first visible element immediately after the page title.
 * - Sections appear in the exact mandated order:
 *   1. Research Quality
 *   2. Execution Realism
 *   3. Data Quality
 *   4. Risk
 *   5. Integrity
 *   6. Paper PnL (Paper Only)
 * - Paper PnL appears ONLY in the final section.
 * - Mandatory disclaimer is always present on the page.
 */
export function renderDashboardHtml(dashboard: EventEdgeDashboard): string {
  const verdict = dashboard.researchQuality.verdict;
  const pageTitle = `EventEdge Research Dashboard — ${dashboard.experimentId}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(pageTitle)}</title>
  <style>${INLINE_STYLES}</style>
</head>
<body>
  <main>
    <header class="page-header">
      <h1>${escapeHtml(pageTitle)}</h1>
      <div class="verdict-banner ${verdictCssClass(verdict)}" data-verdict="${escapeHtml(verdict)}">
        <span class="verdict-label">Gate Verdict</span>
        <span class="verdict-value">${escapeHtml(verdict)}</span>
      </div>
      <div class="meta-row">
        <span><strong>Experiment:</strong> ${escapeHtml(dashboard.experimentTitle)} (<span class="mono">${escapeHtml(dashboard.experimentId)}</span>)</span>
        <span><strong>Status:</strong> <span class="mono">${escapeHtml(dashboard.experimentStatus)}</span></span>
        <span><strong>As Of (UTC):</strong> <span class="mono">${escapeHtml(dashboard.asOf)}</span></span>
      </div>
      <p class="disclaimer">${escapeHtml(DASHBOARD_MANDATORY_DISCLAIMER)}</p>
    </header>
    ${renderResearchQualityHtml(dashboard)}
    ${renderExecutionRealismHtml(dashboard)}
    ${renderDataQualityHtml(dashboard)}
    ${renderRiskHtml(dashboard)}
    ${renderIntegrityHtml(dashboard)}
    ${renderPaperPnlHtml(dashboard)}
    <footer class="page-footer">
      <p>${escapeHtml(DASHBOARD_MANDATORY_DISCLAIMER)}</p>
    </footer>
  </main>
</body>
</html>`;
}
