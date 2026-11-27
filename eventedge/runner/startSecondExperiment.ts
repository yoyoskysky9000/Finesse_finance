import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertNonLiveMode } from '../config/index';
import { buildDashboard } from '../dashboard/index';
import { initializeEventEdgeLedger } from '../db/migrations';
import {
  getExperiment,
  getExperimentStatusHistory,
  transitionExperimentStatus,
} from '../experiments/registry';
import { runPaperCycle } from './paperRunner';
import { FIRST_EXPERIMENT_ID } from './registerFirstExperiment';
import {
  SECOND_EXPERIMENT_ID,
  createSecondExperimentConfig,
  registerSecondExperiment,
} from './registerSecondExperiment';

const FIRST_EXPERIMENT_VOID_REASON =
  'VOID — discovery plumbing defect (universe sweep audited 3,731/3,732 KXMVE parlay markets; targeted families never reached audit due to the 2027 administrative close_time on earnings-mention markets). Zero forecasts written, zero settlements, no data contaminated. Superseded by EE-V1-BASERATE-02 per operator decision 2026-11-27.';

const ACCEPTANCE_CHECK_EVENTS = [
  'KXEARNINGSMENTIONKR-26DEC03',
  'KXEARNINGSMENTIONCBRL-26DEC08',
  'KXEARNINGSMENTIONAZO-26DEC08',
  'KXFEDMENTION-26DEC',
  'KXFEDDECISION-26DEC',
] as const;

function formatExperimentSummary(record: NonNullable<ReturnType<typeof getExperiment>>) {
  return {
    experiment_id: record.experimentId,
    status: record.status,
    model_version: record.modelVersion,
    config_hash: record.configHash,
    supersedes: record.supersedes,
    void_reason: record.voidReason,
    registered_at: record.registeredAt,
  };
}

function formatStatusHistory(history: ReturnType<typeof getExperimentStatusHistory>) {
  return history.map((h) => ({
    from_status: h.fromStatus,
    to_status: h.toStatus,
    changed_at: h.changedAt,
    reason: h.reason,
  }));
}

interface PersistedSnapshotSummaryRow {
  market_ticker: string;
  event_ticker: string;
  series_ticker: string | null;
  discovery_source: string;
  effective_event_date_utc: string | null;
  date_source: string;
  close_time_utc: string | null;
  settlement_source_name: string | null;
}

export async function startSecondExperimentAndRunFirstCycle(): Promise<void> {
  // Enforce non-LIVE OBSERVE mode with EE-09 targeted discovery overrides
  assertNonLiveMode('OBSERVE', 'startSecondExperiment');
  const config = createSecondExperimentConfig({ mode: 'OBSERVE', env: process.env });

  // ---------------------------------------------------------------------------
  // Step 1: Open existing EventEdge ledger and apply forward-only migrations
  // ---------------------------------------------------------------------------
  const { db, migrationResult } = initializeEventEdgeLedger(config.ledgerDbPath);
  try {
    console.log('=== STEP 1: LEDGER OPENED & MIGRATED ===');
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
    // Step 2: Void EE-V1-BASERATE-01 (RUNNING -> KILLED)
    // -------------------------------------------------------------------------
    const existingFirst = getExperiment(db, FIRST_EXPERIMENT_ID);
    if (!existingFirst) {
      throw new Error(`Expected ${FIRST_EXPERIMENT_ID} to exist in ledger before voiding.`);
    }

    let firstAfterKill = existingFirst;
    if (existingFirst.status === 'RUNNING') {
      const killResult = transitionExperimentStatus(db, {
        experimentId: FIRST_EXPERIMENT_ID,
        toStatus: 'KILLED',
        reason: FIRST_EXPERIMENT_VOID_REASON,
        changedAt: new Date().toISOString(),
      });
      firstAfterKill = killResult.experiment;
    }
    const firstHistoryAfterKill = getExperimentStatusHistory(db, FIRST_EXPERIMENT_ID);

    console.log('\n=== STEP 2: EE-V1-BASERATE-01 VOIDED (KILLED) ===');
    console.log(
      JSON.stringify(
        {
          ...formatExperimentSummary(firstAfterKill),
          status_history: formatStatusHistory(firstHistoryAfterKill),
        },
        null,
        2
      )
    );

    // -------------------------------------------------------------------------
    // Step 3: Register EE-V1-BASERATE-02 with EE-09 targeted discovery config
    // -------------------------------------------------------------------------
    const registeredSecond = registerSecondExperiment(db, { config });
    console.log('\n=== STEP 3: EE-V1-BASERATE-02 REGISTERED ===');
    console.log(
      JSON.stringify(
        {
          experiment_id: registeredSecond.experimentId,
          status: registeredSecond.status,
          model_version: registeredSecond.modelVersion,
          config_hash: registeredSecond.configHash,
          supersedes: registeredSecond.supersedes,
          registered_at: registeredSecond.registeredAt,
          discovery_config: {
            targetedOnly: config.discovery.targetedOnly,
            targetSeriesPrefixes: config.discovery.targetSeriesPrefixes,
            targetSeriesTickers: config.discovery.targetSeriesTickers,
            maxCloseHorizonDays: config.discovery.maxCloseHorizonDays,
            minCloseHorizonMinutes: config.discovery.minCloseHorizonMinutes,
          },
        },
        null,
        2
      )
    );

    // -------------------------------------------------------------------------
    // Step 4: Transition EE-V1-BASERATE-02 from REGISTERED -> RUNNING
    // -------------------------------------------------------------------------
    const transitionNow = new Date().toISOString();
    let secondAfterRun = registeredSecond;
    let runningTimestamp: string | null = null;

    if (registeredSecond.status === 'REGISTERED') {
      const runTransition = transitionExperimentStatus(db, {
        experimentId: SECOND_EXPERIMENT_ID,
        toStatus: 'RUNNING',
        reason:
          'OPERATOR EE-V1-02-START: start targeted-discovery successor experiment 90-day window',
        changedAt: transitionNow,
      });
      secondAfterRun = runTransition.experiment;
      runningTimestamp = runTransition.historyEntry.changedAt;
    } else {
      const secondHistory = getExperimentStatusHistory(db, SECOND_EXPERIMENT_ID);
      runningTimestamp = secondHistory.find((h) => h.toStatus === 'RUNNING')?.changedAt ?? null;
    }

    const windowEndUtc = runningTimestamp
      ? new Date(Date.parse(runningTimestamp) + 90 * 86_400_000).toISOString()
      : null;

    console.log('\n=== STEP 4: EE-V1-BASERATE-02 TRANSITIONED TO RUNNING ===');
    console.log(
      JSON.stringify(
        {
          ...formatExperimentSummary(secondAfterRun),
          running_at: runningTimestamp,
          window_90d_ends_at: windowEndUtc,
        },
        null,
        2
      )
    );

    // -------------------------------------------------------------------------
    // Step 5: Run exactly ONE OBSERVE cycle (live public targeted discovery)
    // -------------------------------------------------------------------------
    const asOf = new Date().toISOString();
    const cycleReport = await runPaperCycle(db, {
      experimentId: SECOND_EXPERIMENT_ID,
      mode: 'OBSERVE',
      asOf,
      config,
      actor: 'operator_ee_v1_02_start',
    });

    // Query snapshots captured during this cycle for series/event/date_source provenance
    const cycleSnapshots = db
      .prepare(
        `SELECT
          market_ticker, event_ticker, series_ticker, discovery_source,
          effective_event_date_utc, date_source, close_time_utc, settlement_source_name
         FROM market_snapshots
         WHERE captured_at = ?
         ORDER BY rowid ASC`
      )
      .all(asOf) as unknown as PersistedSnapshotSummaryRow[];

    // Deduplicate to latest snapshot per market_ticker within this cycle (enriched overwrites unenriched in map)
    const latestSnapshotByMarket = new Map<string, PersistedSnapshotSummaryRow>();
    for (const snap of cycleSnapshots) {
      latestSnapshotByMarket.set(snap.market_ticker, snap);
    }

    const resolvedSeriesWithOpenMarkets = Array.from(
      new Set(
        Array.from(latestSnapshotByMarket.values())
          .map((s) => s.series_ticker)
          .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      )
    ).sort();

    const filteredReasonBreakdown: Record<string, number> = {};
    const auditRejectedReasonBreakdown: Record<string, number> = {};
    const abstainedReasonBreakdown: Record<string, number> = {};
    const riskOutcomeStatusBreakdown: Record<string, number> = {};
    const riskReasonBreakdown: Record<string, number> = {};
    const outcomeStatusBreakdown: Record<string, number> = {};

    let enrichedSucceededCount = 0;

    for (const m of cycleReport.marketOutcomes) {
      outcomeStatusBreakdown[m.status] = (outcomeStatusBreakdown[m.status] ?? 0) + 1;
      if (m.enriched) enrichedSucceededCount += 1;

      if (m.status === 'DISCOVERY_FILTERED') {
        for (const c of m.reasonCodes) {
          filteredReasonBreakdown[c] = (filteredReasonBreakdown[c] ?? 0) + 1;
        }
      } else if (m.status === 'AUDIT_REJECTED') {
        for (const c of m.reasonCodes) {
          auditRejectedReasonBreakdown[c] = (auditRejectedReasonBreakdown[c] ?? 0) + 1;
        }
      } else if (m.status === 'FORECAST_ABSTAINED') {
        for (const c of m.reasonCodes) {
          abstainedReasonBreakdown[c] = (abstainedReasonBreakdown[c] ?? 0) + 1;
        }
      } else if (
        m.status === 'RISK_REJECTED' ||
        m.status === 'RISK_SKIPPED_NO_BOOK' ||
        m.status === 'RISK_APPROVED_OBSERVE_ONLY'
      ) {
        riskOutcomeStatusBreakdown[m.status] = (riskOutcomeStatusBreakdown[m.status] ?? 0) + 1;
        for (const c of m.reasonCodes) {
          riskReasonBreakdown[c] = (riskReasonBreakdown[c] ?? 0) + 1;
        }
      }
    }

    const enrichmentAttemptsCount = enrichedSucceededCount + cycleReport.enrichmentFailures.length;

    console.log('\n=== STEP 5: FIRST CYCLE REPORT (OBSERVE, LIVE TARGETED DISCOVERY) ===');
    console.log(
      JSON.stringify(
        {
          experimentId: cycleReport.experimentId,
          mode: cycleReport.mode,
          asOf: cycleReport.asOf,
          configHash: cycleReport.configHash,
          usedFixtures: cycleReport.usedFixtures,
          systemState: cycleReport.systemState,
          baseUrlUsed: cycleReport.observeSummary.baseUrlUsed,
          seriesWithOpenMarketsCount: resolvedSeriesWithOpenMarkets.length,
          seriesWithOpenMarkets: resolvedSeriesWithOpenMarkets,
          targetedEventsFetched: cycleReport.observeSummary.eventsFetched,
          stageCounts: {
            discoveredFetched: cycleReport.counts.discoveredFetched,
            discoveryFilteredOut: cycleReport.counts.discoveryFilteredOut,
            filteredReasonBreakdown,
            scannedPassedHorizon: cycleReport.counts.scanned,
            newlyRegisteredDiscovered: cycleReport.counts.newlyRegisteredDiscovered,
            auditedCount: cycleReport.counts.auditedCount,
            approvedCount: cycleReport.counts.approvedCount,
            rejectedCount: cycleReport.counts.rejectedCount,
            auditRejectedReasonBreakdown,
            enrichmentAttempts: enrichmentAttemptsCount,
            enrichmentSucceeded: enrichedSucceededCount,
            enrichmentFailuresCount: cycleReport.enrichmentFailures.length,
            enrichmentFailures: cycleReport.enrichmentFailures,
            forecastedCount: cycleReport.counts.forecastedCount,
            abstainedCount: cycleReport.counts.abstainedCount,
            abstainedReasonBreakdown,
            riskEvaluatedCount: cycleReport.counts.riskEvaluatedCount,
            riskApprovedCount: cycleReport.counts.riskApprovedCount,
            riskRejectedCount: cycleReport.counts.riskRejectedCount,
            riskOutcomeStatusBreakdown,
            riskReasonBreakdown,
            shadowDecisionsCreated: cycleReport.counts.shadowDecisionsCreated,
            shadowOrdersCreated: cycleReport.counts.shadowOrdersCreated,
            shadowFillsExecuted: cycleReport.counts.shadowFillsExecuted,
            advancedToSettlementPending: cycleReport.counts.advancedToSettlementPending,
            settledCount: cycleReport.counts.settledCount,
          },
          outcomeStatusBreakdown,
          totalMarketOutcomes: cycleReport.marketOutcomes.length,
        },
        null,
        2
      )
    );

    console.log('\n--- STEP 5b: PER-MARKET OUTCOMES ---');
    for (const m of cycleReport.marketOutcomes) {
      console.log(
        JSON.stringify({
          marketId: m.marketId,
          eventId: m.eventId,
          eventFamilyId: m.eventFamilyId,
          discoverySource: m.discoverySource ?? null,
          dateSource: m.dateSource ?? null,
          enriched: m.enriched ?? false,
          enrichmentError: m.enrichmentError ?? null,
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
    // Step 6: Acceptance check for the 5 specific target events
    // -------------------------------------------------------------------------
    console.log('\n=== STEP 6: ACCEPTANCE CHECK (5 TARGET EVENTS) ===');
    const acceptanceSummaries = ACCEPTANCE_CHECK_EVENTS.map((eventTicker) => {
      const eventSnapshots = Array.from(latestSnapshotByMarket.values()).filter(
        (s) => s.event_ticker === eventTicker
      );
      const eventOutcomes = cycleReport.marketOutcomes.filter((m) => m.eventId === eventTicker);

      if (eventSnapshots.length === 0 && eventOutcomes.length === 0) {
        return {
          eventTicker,
          presentInDiscovery: false,
          note: 'ABSENT FROM DISCOVERY — 0 markets discovered in this cycle',
          discoveredCount: 0,
          passedHorizonCount: 0,
          dateSources: {},
          auditedCount: 0,
          approvedCount: 0,
          rejectedCount: 0,
          rejectionReasonCodes: {},
          forecastedCount: 0,
          abstainedCount: 0,
          abstainedReasonCodes: {},
        };
      }

      const dateSources: Record<string, number> = {};
      const effectiveEventDates = new Set<string>();
      const closeTimes = new Set<string>();
      for (const snap of eventSnapshots) {
        dateSources[snap.date_source] = (dateSources[snap.date_source] ?? 0) + 1;
        if (snap.effective_event_date_utc) effectiveEventDates.add(snap.effective_event_date_utc);
        if (snap.close_time_utc) closeTimes.add(snap.close_time_utc);
      }

      const filteredOut = eventOutcomes.filter((m) => m.status === 'DISCOVERY_FILTERED');
      const passedHorizon = eventOutcomes.filter((m) => m.status !== 'DISCOVERY_FILTERED');
      const rejected = passedHorizon.filter((m) => m.status === 'AUDIT_REJECTED');
      const approved = passedHorizon.filter((m) => m.status !== 'AUDIT_REJECTED');
      const forecasted = eventOutcomes.filter((m) => m.forecastId !== null);
      const abstained = eventOutcomes.filter((m) => m.status === 'FORECAST_ABSTAINED');
      const enrichedCount = eventOutcomes.filter((m) => m.enriched === true).length;
      const enrichmentFailedCount = eventOutcomes.filter((m) => m.enrichmentError !== null).length;

      const filteredReasonCodes: Record<string, number> = {};
      for (const m of filteredOut) {
        for (const c of m.reasonCodes) {
          filteredReasonCodes[c] = (filteredReasonCodes[c] ?? 0) + 1;
        }
      }

      const rejectionReasonCodes: Record<string, number> = {};
      for (const m of rejected) {
        for (const c of m.reasonCodes) {
          rejectionReasonCodes[c] = (rejectionReasonCodes[c] ?? 0) + 1;
        }
      }

      const abstainedReasonCodes: Record<string, number> = {};
      for (const m of abstained) {
        for (const c of m.reasonCodes) {
          abstainedReasonCodes[c] = (abstainedReasonCodes[c] ?? 0) + 1;
        }
      }

      return {
        eventTicker,
        presentInDiscovery: true,
        discoveredCount: eventOutcomes.length,
        persistedUniqueMarketsCount: eventSnapshots.length,
        passedHorizonCount: passedHorizon.length,
        filteredOutCount: filteredOut.length,
        filteredReasonCodes,
        dateSources,
        effectiveEventDates: Array.from(effectiveEventDates).sort(),
        closeTimes: Array.from(closeTimes).sort(),
        enrichedCount,
        enrichmentFailedCount,
        auditedCount: passedHorizon.length,
        approvedCount: approved.length,
        rejectedCount: rejected.length,
        rejectionReasonCodes,
        forecastedCount: forecasted.length,
        abstainedCount: abstained.length,
        abstainedReasonCodes,
      };
    });

    console.log(JSON.stringify(acceptanceSummaries, null, 2));

    // -------------------------------------------------------------------------
    // Step 7: Build EE-07 dashboard for EE-V1-BASERATE-02
    // -------------------------------------------------------------------------
    const dashboard = buildDashboard(db, SECOND_EXPERIMENT_ID, asOf, { config });
    const rq = dashboard.sections.researchQuality;
    console.log('\n=== STEP 7: EE-07 DASHBOARD (EE-V1-BASERATE-02) ===');
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
          integrity: {
            liveDisabledPassed: dashboard.sections.integrity.liveDisabledAssertion.passed,
            allTriggersPresent: dashboard.sections.integrity.allTriggersPresent,
            migrationVersion: dashboard.sections.integrity.migrationVersion,
          },
        },
        null,
        2
      )
    );

    // -------------------------------------------------------------------------
    // Step 8: Final print of both experiment records (-01 KILLED, -02 RUNNING)
    // -------------------------------------------------------------------------
    const finalFirst = getExperiment(db, FIRST_EXPERIMENT_ID);
    const finalFirstHistory = getExperimentStatusHistory(db, FIRST_EXPERIMENT_ID);
    const finalSecond = getExperiment(db, SECOND_EXPERIMENT_ID);
    const finalSecondHistory = getExperimentStatusHistory(db, SECOND_EXPERIMENT_ID);

    console.log('\n=== STEP 8: FINAL EXPERIMENT RECORDS ===');
    console.log(
      JSON.stringify(
        {
          [FIRST_EXPERIMENT_ID]: finalFirst
            ? {
                ...formatExperimentSummary(finalFirst),
                status_history: formatStatusHistory(finalFirstHistory),
              }
            : { error: 'NOT_FOUND' },
          [SECOND_EXPERIMENT_ID]: finalSecond
            ? {
                ...formatExperimentSummary(finalSecond),
                status_history: formatStatusHistory(finalSecondHistory),
              }
            : { error: 'NOT_FOUND' },
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
  startSecondExperimentAndRunFirstCycle().catch((err) => {
    console.error('OPERATOR EE-V1-02-START FAILED:', err);
    process.exit(1);
  });
}
