import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertNonLiveMode,
  createEventEdgeConfig,
} from '../config/index';
import { buildDashboard } from '../dashboard/index';
import { initializeEventEdgeLedger } from '../db/migrations';
import {
  getExperiment,
  getExperimentStatusHistory,
  transitionExperimentStatus,
} from '../experiments/registry';
import { runPaperCycle } from './paperRunner';
import {
  FIRST_EXPERIMENT_ID,
  registerFirstExperiment,
} from './registerFirstExperiment';

function formatRecordSummary(record: NonNullable<ReturnType<typeof getExperiment>>) {
  return {
    experiment_id: record.experimentId,
    status: record.status,
    model_version: record.modelVersion,
    config_hash: record.configHash,
    registered_at: record.registeredAt,
  };
}

export async function startFirstExperimentAndRunFirstCycle(): Promise<void> {
  // Enforce non-LIVE OBSERVE mode using default EE-00 config in app environment
  assertNonLiveMode('OBSERVE', 'startFirstExperiment');
  const config = createEventEdgeConfig({ mode: 'OBSERVE' }, process.env);

  // ---------------------------------------------------------------------------
  // Step 1: Open or create the EventEdge ledger via EE-00/EE-03 migrations
  // ---------------------------------------------------------------------------
  const { db, migrationResult } = initializeEventEdgeLedger(config.ledgerDbPath);
  try {
    console.log('=== STEP 1: LEDGER OPENED / INITIALIZED ===');
    console.log(
      JSON.stringify(
        {
          ledgerDbPath: config.ledgerDbPath,
          mode: config.mode,
          liveEnabled: config.liveEnabled,
          schemaVersion: migrationResult.currentVersion,
          appliedVersions: migrationResult.appliedVersions,
          alreadyAppliedVersions: migrationResult.alreadyAppliedVersions,
        },
        null,
        2
      )
    );

    // -------------------------------------------------------------------------
    // Step 2: Register the pre-registered first experiment (idempotent)
    // -------------------------------------------------------------------------
    const registeredRecord = registerFirstExperiment(db, { config });
    console.log('\n=== STEP 2: EXPERIMENT REGISTERED ===');
    console.log(JSON.stringify(formatRecordSummary(registeredRecord), null, 2));

    // -------------------------------------------------------------------------
    // Step 3: Transition EE-V1-BASERATE-01 from REGISTERED -> RUNNING
    // -------------------------------------------------------------------------
    const transitionNow = new Date().toISOString();
    let runningTimestamp: string | null = null;
    let afterTransitionRecord = registeredRecord;

    if (registeredRecord.status === 'REGISTERED') {
      const transitionResult = transitionExperimentStatus(db, {
        experimentId: FIRST_EXPERIMENT_ID,
        toStatus: 'RUNNING',
        reason: 'OPERATOR EE-V1-START: start pre-registered first experiment 90-day window',
        changedAt: transitionNow,
      });
      afterTransitionRecord = transitionResult.experiment;
      runningTimestamp = transitionResult.historyEntry.changedAt;
    } else {
      const history = getExperimentStatusHistory(db, FIRST_EXPERIMENT_ID);
      const runEntry = history.find((h) => h.toStatus === 'RUNNING');
      runningTimestamp = runEntry?.changedAt ?? null;
    }

    const windowEndUtc = runningTimestamp
      ? new Date(Date.parse(runningTimestamp) + 90 * 86_400_000).toISOString()
      : null;

    console.log('\n=== STEP 3: EXPERIMENT TRANSITIONED TO RUNNING ===');
    console.log(
      JSON.stringify(
        {
          ...formatRecordSummary(afterTransitionRecord),
          running_at: runningTimestamp,
          window_90d_ends_at: windowEndUtc,
        },
        null,
        2
      )
    );

    // -------------------------------------------------------------------------
    // Step 4: Run exactly ONE paper cycle in OBSERVE mode (live public discovery)
    // -------------------------------------------------------------------------
    const asOf = new Date().toISOString();
    const cycleReport = await runPaperCycle(db, {
      experimentId: FIRST_EXPERIMENT_ID,
      mode: 'OBSERVE',
      asOf,
      config,
      actor: 'operator_ee_v1_start',
    });

    const outcomeStatusBreakdown: Record<string, number> = {};
    const reasonCodeBreakdown: Record<string, number> = {};
    const riskRejectedReasonBreakdown: Record<string, number> = {};
    const marketErrors: Array<{ marketId: string; status: string; reasonCodes: readonly string[] }> =
      [];

    for (const outcome of cycleReport.marketOutcomes) {
      outcomeStatusBreakdown[outcome.status] = (outcomeStatusBreakdown[outcome.status] ?? 0) + 1;
      for (const code of outcome.reasonCodes) {
        reasonCodeBreakdown[code] = (reasonCodeBreakdown[code] ?? 0) + 1;
      }
      if (outcome.status === 'RISK_REJECTED' || outcome.status === 'RISK_SKIPPED_NO_BOOK') {
        for (const code of outcome.reasonCodes) {
          riskRejectedReasonBreakdown[code] = (riskRejectedReasonBreakdown[code] ?? 0) + 1;
        }
      }
      if (
        outcome.status === 'AUDIT_REJECTED' ||
        outcome.status === 'FORECAST_ABSTAINED' ||
        outcome.status === 'RISK_REJECTED' ||
        outcome.status === 'RISK_SKIPPED_NO_BOOK'
      ) {
        marketErrors.push({
          marketId: outcome.marketId,
          status: outcome.status,
          reasonCodes: outcome.reasonCodes,
        });
      }
    }

    console.log('\n=== STEP 4: FIRST CYCLE REPORT (OBSERVE, LIVE PUBLIC DISCOVERY) ===');
    console.log(
      JSON.stringify(
        {
          experimentId: cycleReport.experimentId,
          mode: cycleReport.mode,
          asOf: cycleReport.asOf,
          configHash: cycleReport.configHash,
          usedFixtures: cycleReport.usedFixtures,
          systemState: cycleReport.systemState,
          counts: cycleReport.counts,
          outcomeStatusBreakdown,
          reasonCodeBreakdown,
          riskRejectedReasonBreakdown,
          totalMarketOutcomes: cycleReport.marketOutcomes.length,
          nonApprovedOrRejectedCount: marketErrors.length,
        },
        null,
        2
      )
    );

    console.log('\n--- STEP 4b: PER-MARKET OUTCOMES ---');
    for (const m of cycleReport.marketOutcomes) {
      console.log(
        JSON.stringify({
          marketId: m.marketId,
          eventId: m.eventId,
          eventFamilyId: m.eventFamilyId,
          lifecycleState: m.lifecycleState,
          status: m.status,
          reasonCodes: m.reasonCodes,
          forecastId: m.forecastId,
          modelProbability: m.modelProbability,
          side: m.side,
          approvedQuantity: m.approvedQuantity,
          decisionId: m.decisionId,
        })
      );
    }

    // -------------------------------------------------------------------------
    // Step 5: Build EE-07 dashboard (read-only) and print verdict & headline
    // -------------------------------------------------------------------------
    const dashboard = buildDashboard(db, FIRST_EXPERIMENT_ID, asOf, { config });
    const rq = dashboard.sections.researchQuality;
    console.log('\n=== STEP 5: EE-07 DASHBOARD (RESEARCH QUALITY) ===');
    console.log(
      JSON.stringify(
        {
          experimentId: dashboard.experimentId,
          experimentStatus: dashboard.experimentStatus,
          asOf: dashboard.asOf,
          mode: config.mode,
          gateVerdict: rq.verdict,
          researchQuality: {
            status: rq.status,
            verdict: rq.verdict,
            verdictReasons: rq.verdictReasons,
            hasSettledScores: rq.hasSettledScores,
            settledSampleCount: rq.sampleSize,
            modelBrier: rq.modelBrier,
            marketBrier: rq.marketBrier,
            brierDiff: rq.brierDiff,
            modelLogLoss: rq.modelLogLoss,
            marketLogLoss: rq.marketLogLoss,
            coverage: rq.coverage,
            denominatorTotals: rq.denominatorTotals,
            calibrationStatus: rq.calibrationSummary.status,
            calibrationSkipReason: rq.calibrationSummary.skipReason,
          },
          integrityLiveDisabledPassed: dashboard.sections.integrity.liveDisabledAssertion.passed,
        },
        null,
        2
      )
    );

    // -------------------------------------------------------------------------
    // Step 6: Print final experiment record confirming status RUNNING
    // -------------------------------------------------------------------------
    const finalRecord = getExperiment(db, FIRST_EXPERIMENT_ID);
    const finalHistory = getExperimentStatusHistory(db, FIRST_EXPERIMENT_ID);
    console.log('\n=== STEP 6: FINAL EXPERIMENT RECORD ===');
    console.log(
      JSON.stringify(
        {
          ...(finalRecord ? formatRecordSummary(finalRecord) : { error: 'NOT_FOUND' }),
          statusHistory: finalHistory.map((h) => ({
            from_status: h.fromStatus,
            to_status: h.toStatus,
            changed_at: h.changedAt,
            reason: h.reason,
          })),
        },
        null,
        2
      )
    );
  } finally {
    db.close();
  }
}

const isMain =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  startFirstExperimentAndRunFirstCycle().catch((err) => {
    console.error('OPERATOR EE-V1-START FAILED:', err);
    process.exit(1);
  });
}
