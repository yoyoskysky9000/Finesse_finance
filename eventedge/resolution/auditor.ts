import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  KalshiRawEvent,
  KalshiRawMarket,
  KalshiSettlementSource,
  NormalizedMarketSnapshot,
} from '../discovery/index';

export const RESOLUTION_AUDIT_STATUSES = ['CLEAR', 'AMBIGUOUS'] as const;
export type ResolutionAuditStatus = (typeof RESOLUTION_AUDIT_STATUSES)[number];

export const AMBIGUITY_REASON_CODES = [
  'MISSING_RULES_TEXT',
  'RULES_TOO_SHORT',
  'MISSING_SETTLEMENT_SOURCE',
  'MULTIPLE_CONFLICTING_SOURCES',
  'UNOFFICIAL_OR_UNVERIFIED_SOURCE',
  'SUBJECTIVE_OR_DISCRETIONARY_WORDING',
  'MISSING_UNAMBIGUOUS_YES_NO_CONDITION',
] as const;

export type AmbiguityReasonCode = (typeof AMBIGUITY_REASON_CODES)[number];

export interface AmbiguityReason {
  readonly code: AmbiguityReasonCode;
  readonly detail: string;
  readonly matchedPhrase?: string;
}

export interface ExtractedSettlementSource {
  readonly name: string;
  readonly url: string | null;
  readonly origin: 'MARKET_METADATA' | 'EVENT_METADATA' | 'RULES_TEXT';
}

export interface ExtractedResolutionMetadata {
  readonly rulesPrimary: string;
  readonly rulesSecondary: string | null;
  readonly combinedRulesText: string;
  readonly settlementSources: readonly ExtractedSettlementSource[];
  readonly primarySettlementSource: string;
  readonly primarySettlementSourceUrl: string | null;
  readonly ruleHash: string;
}

export interface ContractResolutionAuditResult {
  readonly marketTicker: string;
  readonly eventTicker: string;
  readonly venue: 'KALSHI';
  readonly snapshotId: string;
  readonly status: ResolutionAuditStatus;
  readonly eligibleForDownstream: boolean;
  readonly reasons: readonly AmbiguityReason[];
  readonly reasonCodes: readonly AmbiguityReasonCode[];
  readonly metadata: ExtractedResolutionMetadata;
  readonly auditedAt: string;
}

export interface PersistedRuleVersionRecord {
  readonly ruleVersionId: string;
  readonly venue: string;
  readonly eventTicker: string;
  readonly marketTicker: string;
  readonly versionNumber: number;
  readonly ruleHash: string;
  readonly rulesPrimary: string;
  readonly rulesSecondary: string | null;
  readonly settlementSource: string;
  readonly settlementSourceUrl: string | null;
  readonly auditStatus: ResolutionAuditStatus;
  readonly ambiguityReasons: readonly AmbiguityReason[];
  readonly effectiveAt: string;
  readonly auditedAt: string | null;
  readonly createdAt: string;
}

export interface AuditedMarketEntry {
  readonly snapshot: NormalizedMarketSnapshot;
  readonly audit: ContractResolutionAuditResult;
  readonly ruleVersion: PersistedRuleVersionRecord;
  readonly isNewRuleVersion: boolean;
}

export interface AmbiguityReasonCount {
  readonly code: AmbiguityReasonCode;
  readonly count: number;
}

export interface BatchResolutionAuditResult {
  /** Only CLEAR markets are included here and allowed to flow downstream. */
  readonly clearMarkets: AuditedMarketEntry[];
  /** AMBIGUOUS markets are persisted with their reasons and excluded from downstream flow. */
  readonly ambiguousMarkets: AuditedMarketEntry[];
  readonly allAudited: AuditedMarketEntry[];
  readonly newRuleVersionsCount: number;
  readonly topAmbiguityReasons: AmbiguityReasonCount[];
}

const MIN_CLEAR_RULES_LENGTH = 25;

const UNOFFICIAL_SOURCE_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(twitter|x\.com|tweet|tweets)\b/i, label: 'social media (Twitter/X)' },
  { pattern: /\b(reddit|subreddit)\b/i, label: 'Reddit' },
  { pattern: /\bwikipedia\b/i, label: 'Wikipedia' },
  { pattern: /\b(tiktok|instagram|youtube|telegram|discord|facebook)\b/i, label: 'social platform' },
  { pattern: /\bsocial media\b/i, label: 'social media' },
  { pattern: /\b(rumor|rumors|unverified|anonymous|blog|blogs|forum|forums)\b/i, label: 'unverified/informal source' },
  { pattern: /\b(crowdsourced|user[- ]submitted|community poll)\b/i, label: 'crowdsourced source' },
  { pattern: /\b(media consensus|general consensus|press reports|news reports|widely reported)\b/i, label: 'informal media consensus' },
  { pattern: /\b(sole discretion|to be determined|tbd|unknown|n\/a|none|the internet|online|public opinion)\b/i, label: 'unspecified/discretionary source' },
];

const CONFLICTING_SOURCE_RULES_PATTERNS: ReadonlyArray<RegExp> = [
  /\bor another (?:reliable |reputable )?source\b/i,
  /\bor any (?:other )?(?:reputable|credible|official) source\b/i,
  /\bwhichever (?:reports|publishes|announces) first\b/i,
  /\bconsensus of (?:news|media|reporting) outlets\b/i,
  /\bmultiple (?:independent )?sources\b/i,
  /\bconflicting (?:reports|sources)\b/i,
  /\bor similar reporting agency\b/i,
  /\b(?:source|reporting agency) of its choice\b/i,
];

const SUBJECTIVE_WORDING_PATTERNS: ReadonlyArray<{ pattern: RegExp; detail: string }> = [
  { pattern: /\bsole discretion\b/i, detail: 'Contains discretionary resolution phrase ("sole discretion").' },
  { pattern: /\bin its discretion\b/i, detail: 'Contains discretionary resolution phrase ("in its discretion").' },
  { pattern: /\breasonable discretion\b/i, detail: 'Contains discretionary resolution phrase ("reasonable discretion").' },
  { pattern: /\bgood[- ]faith determination\b/i, detail: 'Contains discretionary determination clause ("good faith determination").' },
  { pattern: /\bmay determine\b/i, detail: 'Contains discretionary resolution language ("may determine").' },
  { pattern: /\bsubjective(?:ly)?\b/i, detail: 'Contains explicitly subjective wording.' },
  { pattern: /\bspirit of the market\b/i, detail: 'References subjective "spirit of the market" resolution.' },
  { pattern: /\beditorial judgment\b/i, detail: 'Depends on editorial judgment.' },
  { pattern: /\bwidely considered\b/i, detail: 'Depends on subjective consensus ("widely considered").' },
  { pattern: /\bwidely regarded\b/i, detail: 'Depends on subjective consensus ("widely regarded").' },
  { pattern: /\bgenerally accepted\b/i, detail: 'Depends on subjective consensus ("generally accepted").' },
  { pattern: /\bbroadly viewed\b/i, detail: 'Depends on subjective consensus ("broadly viewed").' },
  { pattern: /\bmajor announcement\b/i, detail: 'Contains undefined qualitative threshold ("major announcement").' },
  { pattern: /\bmeaningful(?:ly)?\b/i, detail: 'Contains undefined qualitative threshold ("meaningful").' },
  { pattern: /\bcredible reports\b/i, detail: 'Relies on undefined "credible reports".' },
  { pattern: /\breliable reports\b/i, detail: 'Relies on undefined "reliable reports".' },
  { pattern: /\bto be determined\b|\btbd\b/i, detail: 'Contains unresolved placeholder ("TBD / to be determined").' },
  { pattern: /\bsubject to change\b/i, detail: 'Settlement criteria marked "subject to change".' },
  { pattern: /\b(?:roughly|approximately)\b/i, detail: 'Contains imprecise numeric qualifier ("roughly/approximately").' },
  {
    pattern: /\b(?:materially|substantially|significantly)\b/i,
    detail: 'Contains qualitative magnitude term without objective specification.',
  },
];

const UNAMBIGUOUS_YES_NO_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:market\s+)?(?:will\s+)?resolve[sd]?\s+(?:to\s+)?["']?yes["']?\b/i,
  /\b(?:market\s+)?(?:will\s+)?settle[sd]?\s+(?:to\s+)?["']?yes["']?\b/i,
  /\boutcome\s+(?:is|will\s+be)\s+["']?yes["']?\b/i,
  /\bpayout\s+criterion\b/i,
  /\b(?:yes|no)\s+if\s+(?:and\s+only\s+if\s+)?/i,
  /\botherwise[,\s]+(?:the\s+market\s+)?(?:will\s+)?(?:resolve|settle)s?\s+(?:to\s+)?["']?no["']?\b/i,
];

const RULES_TEXT_SOURCE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bsettlement source\s*:\s*([^.;\n]+)/i,
  /\b(?:as\s+)?reported\s+by\s+(?:the\s+)?([A-Z][A-Za-z0-9&.,'’\-\s]{2,80}?)(?=[.,;\n]|\s+(?:is|are|was|were|will|for|in|on|at|to|that)\b)/,
  /\b(?:as\s+)?published\s+by\s+(?:the\s+)?([A-Z][A-Za-z0-9&.,'’\-\s]{2,80}?)(?=[.,;\n]|\s+(?:is|are|was|were|will|for|in|on|at|to|that)\b)/,
  /\baccording\s+to\s+(?:the\s+)?([A-Z][A-Za-z0-9&.,'’\-\s]{2,80}?)(?=[.,;\n]|\s+(?:is|are|was|were|will|for|in|on|at|to|that)\b)/,
];

function trimNonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Computes a deterministic SHA-256 hash over canonicalized settlement rules text.
 * Any material change to `rules_primary` or `rules_secondary` produces a new hash,
 * triggering an append-only new row in `settlement_rule_versions`.
 */
export function computeRuleTextHash(
  rulesPrimary: string,
  rulesSecondary: string | null
): string {
  const normPrimary = rulesPrimary.replace(/\r\n/g, '\n').trim();
  const normSecondary = (rulesSecondary ?? '').replace(/\r\n/g, '\n').trim();
  return crypto
    .createHash('sha256')
    .update(`${normPrimary}\n---\n${normSecondary}`)
    .digest('hex');
}

function collectSourcesFromList(
  list: unknown,
  origin: 'MARKET_METADATA' | 'EVENT_METADATA',
  target: ExtractedSettlementSource[],
  seenKeys: Set<string>
): void {
  if (!Array.isArray(list)) return;
  for (const raw of list as KalshiSettlementSource[]) {
    if (!raw || typeof raw !== 'object') continue;
    const name = trimNonEmpty(raw.name);
    if (!name) continue;
    const key = name.toLowerCase().replace(/\s+/g, ' ');
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    target.push({
      name,
      url: trimNonEmpty(raw.url),
      origin,
    });
  }
}

/**
 * Extracts settlement rules text and authoritative settlement source metadata from
 * a Kalshi market + optional parent event payload.
 */
export function extractResolutionMetadata(
  market: KalshiRawMarket,
  event: KalshiRawEvent | null = null
): ExtractedResolutionMetadata {
  const rulesPrimary = trimNonEmpty(market.rules_primary) ?? '';
  const rulesSecondary = trimNonEmpty(market.rules_secondary);
  const combinedRulesText = [rulesPrimary, rulesSecondary].filter(Boolean).join('\n\n');

  const sources: ExtractedSettlementSource[] = [];
  const seenKeys = new Set<string>();

  collectSourcesFromList(market.settlement_sources, 'MARKET_METADATA', sources, seenKeys);
  if (sources.length === 0 && event) {
    collectSourcesFromList(event.settlement_sources, 'EVENT_METADATA', sources, seenKeys);
  }

  if (sources.length === 0) {
    const fallbackName = trimNonEmpty(market.settlement_source_name);
    if (fallbackName) {
      const key = fallbackName.toLowerCase().replace(/\s+/g, ' ');
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        sources.push({ name: fallbackName, url: null, origin: 'MARKET_METADATA' });
      }
    } else if (market.settlement_source) {
      if (typeof market.settlement_source === 'string') {
        const sName = trimNonEmpty(market.settlement_source);
        if (sName) {
          seenKeys.add(sName.toLowerCase());
          sources.push({ name: sName, url: null, origin: 'MARKET_METADATA' });
        }
      } else if (typeof market.settlement_source === 'object') {
        const sName = trimNonEmpty(market.settlement_source.name);
        if (sName) {
          seenKeys.add(sName.toLowerCase());
          sources.push({
            name: sName,
            url: trimNonEmpty(market.settlement_source.url),
            origin: 'MARKET_METADATA',
          });
        }
      }
    }
  }

  // Fallback extraction from explicit rules text citations if structured metadata lacked sources
  if (sources.length === 0 && combinedRulesText.length > 0) {
    for (const pattern of RULES_TEXT_SOURCE_PATTERNS) {
      const match = combinedRulesText.match(pattern);
      if (match && match[1]) {
        const candidate = match[1].trim().replace(/[.,;:\s]+$/, '');
        if (candidate.length >= 3) {
          const key = candidate.toLowerCase().replace(/\s+/g, ' ');
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            sources.push({
              name: candidate,
              url: null,
              origin: 'RULES_TEXT',
            });
          }
        }
      }
    }
  }

  const primarySettlementSource = sources.map((s) => s.name).join('; ');
  const primarySettlementSourceUrl = sources.length === 1 ? sources[0].url : null;
  const ruleHash = computeRuleTextHash(rulesPrimary, rulesSecondary);

  return Object.freeze({
    rulesPrimary,
    rulesSecondary,
    combinedRulesText,
    settlementSources: Object.freeze(sources),
    primarySettlementSource,
    primarySettlementSourceUrl,
    ruleHash,
  });
}

function parseSnapshotRawPayload(snapshot: NormalizedMarketSnapshot): {
  market: KalshiRawMarket;
  event: KalshiRawEvent | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot.rawPayloadJson);
  } catch {
    return {
      market: {
        ticker: snapshot.marketTicker,
        event_ticker: snapshot.eventTicker,
        settlement_source_name: snapshot.settlementSourceName,
      },
      event: null,
    };
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (obj.market && typeof obj.market === 'object' && !Array.isArray(obj.market)) {
      return {
        market: obj.market as KalshiRawMarket,
        event:
          obj.event && typeof obj.event === 'object' && !Array.isArray(obj.event)
            ? (obj.event as KalshiRawEvent)
            : null,
      };
    }
    return { market: obj as KalshiRawMarket, event: null };
  }

  return {
    market: { ticker: snapshot.marketTicker, event_ticker: snapshot.eventTicker },
    event: null,
  };
}

/**
 * Classifies a discovered market as `CLEAR` or `AMBIGUOUS` with machine-readable reasons.
 *
 * CLEAR requires ALL of:
 * 1. Non-empty, substantive settlement rules text.
 * 2. Exactly one named authoritative settlement source (no missing, conflicting, or unofficial sources).
 * 3. No subjective/discretionary resolution wording.
 * 4. An explicit, unambiguous YES/NO resolution condition.
 */
export function auditContractResolution(
  snapshot: NormalizedMarketSnapshot,
  auditedAtIso: string = new Date().toISOString()
): ContractResolutionAuditResult {
  const { market, event } = parseSnapshotRawPayload(snapshot);
  const metadata = extractResolutionMetadata(market, event);
  const reasons: AmbiguityReason[] = [];
  const addedCodes = new Set<AmbiguityReasonCode>();

  const addReason = (code: AmbiguityReasonCode, detail: string, matchedPhrase?: string) => {
    if (addedCodes.has(code)) return;
    addedCodes.add(code);
    reasons.push(
      matchedPhrase !== undefined
        ? Object.freeze({ code, detail, matchedPhrase })
        : Object.freeze({ code, detail })
    );
  };

  // 1. Rules text presence & minimum clarity check
  if (metadata.rulesPrimary.length === 0) {
    addReason(
      'MISSING_RULES_TEXT',
      'Market payload does not include settlement rules_primary text.'
    );
  } else if (metadata.combinedRulesText.length < MIN_CLEAR_RULES_LENGTH) {
    addReason(
      'RULES_TOO_SHORT',
      `Settlement rules text is too short (${metadata.combinedRulesText.length} chars < ${MIN_CLEAR_RULES_LENGTH}) to define an unambiguous condition.`
    );
  }

  // 2. Authoritative settlement source checks
  if (metadata.settlementSources.length === 0) {
    addReason(
      'MISSING_SETTLEMENT_SOURCE',
      'No named authoritative settlement source found in market/event payload or rules text.'
    );
  } else {
    if (metadata.settlementSources.length > 1) {
      addReason(
        'MULTIPLE_CONFLICTING_SOURCES',
        `Market specifies ${metadata.settlementSources.length} distinct settlement sources (${metadata.settlementSources
          .map((s) => s.name)
          .join(', ')}) instead of a single authoritative source.`
      );
    }

    for (const src of metadata.settlementSources) {
      const combinedSourceStr = `${src.name} ${src.url ?? ''}`.trim();
      for (const unofficial of UNOFFICIAL_SOURCE_PATTERNS) {
        const match = combinedSourceStr.match(unofficial.pattern);
        if (match) {
          addReason(
            'UNOFFICIAL_OR_UNVERIFIED_SOURCE',
            `Settlement source "${src.name}" references an unofficial or unverified source (${unofficial.label}).`,
            match[0]
          );
          break;
        }
      }
      if (src.name.trim().length < 3) {
        addReason(
          'UNOFFICIAL_OR_UNVERIFIED_SOURCE',
          `Settlement source name "${src.name}" is not a clear named authority.`
        );
      }
    }
  }

  // Check rules text for conflicting multi-source or unofficial source clauses
  if (metadata.combinedRulesText.length > 0) {
    for (const pattern of CONFLICTING_SOURCE_RULES_PATTERNS) {
      const match = metadata.combinedRulesText.match(pattern);
      if (match) {
        addReason(
          'MULTIPLE_CONFLICTING_SOURCES',
          `Settlement rules allow conflicting or interchangeable reporting sources ("${match[0]}").`,
          match[0]
        );
        break;
      }
    }

    for (const unofficial of UNOFFICIAL_SOURCE_PATTERNS) {
      const match = metadata.combinedRulesText.match(unofficial.pattern);
      if (match) {
        addReason(
          'UNOFFICIAL_OR_UNVERIFIED_SOURCE',
          `Settlement rules rely on an unofficial or unverified source (${unofficial.label}: "${match[0]}").`,
          match[0]
        );
        break;
      }
    }

    // 3. Subjective / discretionary wording check
    for (const subj of SUBJECTIVE_WORDING_PATTERNS) {
      const match = metadata.combinedRulesText.match(subj.pattern);
      if (match) {
        addReason('SUBJECTIVE_OR_DISCRETIONARY_WORDING', subj.detail, match[0]);
        break;
      }
    }

    // 4. Explicit binary YES/NO resolution condition check
    const hasExplicitYesNo = UNAMBIGUOUS_YES_NO_PATTERNS.some((p) =>
      p.test(metadata.combinedRulesText)
    );
    if (!hasExplicitYesNo) {
      addReason(
        'MISSING_UNAMBIGUOUS_YES_NO_CONDITION',
        'Settlement rules do not state an explicit YES/NO resolution condition.'
      );
    }
  }

  const status: ResolutionAuditStatus = reasons.length === 0 ? 'CLEAR' : 'AMBIGUOUS';

  return Object.freeze({
    marketTicker: snapshot.marketTicker,
    eventTicker: snapshot.eventTicker,
    venue: snapshot.venue,
    snapshotId: snapshot.snapshotId,
    status,
    eligibleForDownstream: status === 'CLEAR',
    reasons: Object.freeze(reasons),
    reasonCodes: Object.freeze(reasons.map((r) => r.code)),
    metadata,
    auditedAt: auditedAtIso,
  });
}

interface RawRuleVersionRow {
  rule_version_id: string;
  venue: string;
  event_ticker: string;
  market_ticker: string;
  version_number: number;
  rule_hash: string;
  rules_primary: string;
  rules_secondary: string | null;
  settlement_source: string;
  settlement_source_url: string | null;
  audit_status: ResolutionAuditStatus;
  ambiguity_reasons_json: string;
  effective_at: string;
  audited_at: string | null;
  created_at: string;
}

function mapRawRuleVersionRow(row: RawRuleVersionRow): PersistedRuleVersionRecord {
  let parsedReasons: AmbiguityReason[] = [];
  try {
    const raw = JSON.parse(row.ambiguity_reasons_json);
    if (Array.isArray(raw)) parsedReasons = raw as AmbiguityReason[];
  } catch {
    parsedReasons = [];
  }

  return Object.freeze({
    ruleVersionId: row.rule_version_id,
    venue: row.venue,
    eventTicker: row.event_ticker,
    marketTicker: row.market_ticker,
    versionNumber: Number(row.version_number),
    ruleHash: row.rule_hash,
    rulesPrimary: row.rules_primary,
    rulesSecondary: row.rules_secondary,
    settlementSource: row.settlement_source,
    settlementSourceUrl: row.settlement_source_url,
    auditStatus: row.audit_status,
    ambiguityReasons: Object.freeze(parsedReasons),
    effectiveAt: row.effective_at,
    auditedAt: row.audited_at,
    createdAt: row.created_at,
  });
}

/**
 * Append-only persistence into `settlement_rule_versions`.
 *
 * - If `(market_ticker, rule_hash)` already exists, returns the existing immutable row untouched.
 * - If `rule_hash` is new (first time seen OR rules text changed), inserts a NEW row with
 *   incremented `version_number` and NEVER updates or deletes prior versions.
 */
export function persistSettlementRuleVersion(
  db: DatabaseSync,
  audit: ContractResolutionAuditResult
): { record: PersistedRuleVersionRecord; isNewVersion: boolean } {
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db
      .prepare(
        `SELECT
          rule_version_id, venue, event_ticker, market_ticker, version_number,
          rule_hash, rules_primary, rules_secondary, settlement_source,
          settlement_source_url, audit_status, ambiguity_reasons_json,
          effective_at, audited_at, created_at
        FROM settlement_rule_versions
        WHERE market_ticker = ? AND rule_hash = ?
        LIMIT 1`
      )
      .get(audit.marketTicker, audit.metadata.ruleHash) as unknown as RawRuleVersionRow | undefined;

    if (existing) {
      db.exec('COMMIT');
      return {
        record: mapRawRuleVersionRow(existing),
        isNewVersion: false,
      };
    }

    const versionRow = db
      .prepare(
        `SELECT COALESCE(MAX(version_number), 0) AS max_ver
         FROM settlement_rule_versions
         WHERE market_ticker = ?`
      )
      .get(audit.marketTicker) as { max_ver: number };

    const nextVersion = Number(versionRow.max_ver) + 1;
    const ruleVersionId = `rule_${crypto.randomUUID()}`;
    const reasonsJson = JSON.stringify(audit.reasons);

    db.prepare(
      `INSERT INTO settlement_rule_versions (
        rule_version_id, venue, event_ticker, market_ticker, rule_hash,
        rules_primary, rules_secondary, settlement_source, effective_at,
        version_number, audit_status, ambiguity_reasons_json,
        settlement_source_url, audited_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      ruleVersionId,
      audit.venue,
      audit.eventTicker,
      audit.marketTicker,
      audit.metadata.ruleHash,
      audit.metadata.rulesPrimary,
      audit.metadata.rulesSecondary,
      audit.metadata.primarySettlementSource,
      audit.auditedAt,
      nextVersion,
      audit.status,
      reasonsJson,
      audit.metadata.primarySettlementSourceUrl,
      audit.auditedAt
    );

    const inserted = db
      .prepare(
        `SELECT
          rule_version_id, venue, event_ticker, market_ticker, version_number,
          rule_hash, rules_primary, rules_secondary, settlement_source,
          settlement_source_url, audit_status, ambiguity_reasons_json,
          effective_at, audited_at, created_at
        FROM settlement_rule_versions
        WHERE rule_version_id = ?`
      )
      .get(ruleVersionId) as unknown as RawRuleVersionRow;

    db.exec('COMMIT');
    return {
      record: mapRawRuleVersionRow(inserted),
      isNewVersion: true,
    };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ignore rollback failure
    }
    throw err;
  }
}

/**
 * Lists all immutable rule versions persisted for a market in ascending version order.
 */
export function listSettlementRuleVersionsForMarket(
  db: DatabaseSync,
  marketTicker: string
): PersistedRuleVersionRecord[] {
  const rows = db
    .prepare(
      `SELECT
        rule_version_id, venue, event_ticker, market_ticker, version_number,
        rule_hash, rules_primary, rules_secondary, settlement_source,
        settlement_source_url, audit_status, ambiguity_reasons_json,
        effective_at, audited_at, created_at
      FROM settlement_rule_versions
      WHERE market_ticker = ?
      ORDER BY version_number ASC, created_at ASC`
    )
    .all(marketTicker) as unknown as RawRuleVersionRow[];

  return rows.map(mapRawRuleVersionRow);
}

/**
 * Audits all discovered/filtered markets, persists every rule version to
 * `settlement_rule_versions`, and separates CLEAR markets (allowed downstream)
 * from AMBIGUOUS markets (persisted with reasons and excluded).
 */
export function auditDiscoveredMarkets(
  db: DatabaseSync,
  snapshots: readonly NormalizedMarketSnapshot[],
  auditedAtIso: string = new Date().toISOString()
): BatchResolutionAuditResult {
  const clearMarkets: AuditedMarketEntry[] = [];
  const ambiguousMarkets: AuditedMarketEntry[] = [];
  const allAudited: AuditedMarketEntry[] = [];
  const reasonFrequency = new Map<AmbiguityReasonCode, number>();
  let newRuleVersionsCount = 0;

  for (const snapshot of snapshots) {
    const audit = auditContractResolution(snapshot, auditedAtIso);
    const { record, isNewVersion } = persistSettlementRuleVersion(db, audit);
    if (isNewVersion) {
      newRuleVersionsCount += 1;
    }

    const entry: AuditedMarketEntry = Object.freeze({
      snapshot,
      audit,
      ruleVersion: record,
      isNewRuleVersion: isNewVersion,
    });
    allAudited.push(entry);

    if (audit.status === 'CLEAR') {
      clearMarkets.push(entry);
    } else {
      ambiguousMarkets.push(entry);
      for (const reason of audit.reasons) {
        reasonFrequency.set(reason.code, (reasonFrequency.get(reason.code) ?? 0) + 1);
      }
    }
  }

  const topAmbiguityReasons: AmbiguityReasonCount[] = Array.from(reasonFrequency.entries())
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

  return {
    clearMarkets,
    ambiguousMarkets,
    allAudited,
    newRuleVersionsCount,
    topAmbiguityReasons,
  };
}
