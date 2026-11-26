import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const EVENTEDGE_MODES = ['OBSERVE', 'PAPER', 'DEMO', 'LIVE'] as const;
export type EventEdgeMode = (typeof EVENTEDGE_MODES)[number];
export type EventEdgeAllowedMode = Exclude<EventEdgeMode, 'LIVE'>;

export const EVENTEDGE_ALLOWED_MODES: readonly EventEdgeAllowedMode[] = Object.freeze([
  'OBSERVE',
  'PAPER',
  'DEMO',
]);

export const EVENTEDGE_DEFAULT_MODE: EventEdgeAllowedMode = 'OBSERVE';

/**
 * Thrown whenever any caller, environment variable, config file, or UI payload
 * attempts to construct or load EventEdge with mode === 'LIVE'.
 */
export class EventEdgeLiveModeDisabledError extends Error {
  public readonly code = 'EVENTEDGE_LIVE_MODE_HARD_DISABLED' as const;

  constructor(source?: string) {
    const context = source ? ` (source: ${source})` : '';
    super(
      `EventEdge LIVE mode is hard-disabled and cannot be enabled via constructor, environment variable, config file, or UI${context}. Allowed modes: OBSERVE, PAPER, DEMO.`
    );
    this.name = 'EventEdgeLiveModeDisabledError';
  }
}

export class EventEdgeConfigValidationError extends Error {
  public readonly code = 'EVENTEDGE_CONFIG_INVALID' as const;

  constructor(message: string) {
    super(message);
    this.name = 'EventEdgeConfigValidationError';
  }
}

export interface EventEdgeRiskConfig {
  /** Minimum conservative probability edge required to trade (default 0.04). */
  readonly minConservativeEdge: number;
  /** Per-position settled-cash cap fraction (default 0.03 = 3% of settled cash). */
  readonly perPositionSettledCashCapPct: number;
  /** Per-underlying-event bankroll risk cap fraction (default 0.005 = 0.5% of bankroll). */
  readonly perEventBankrollRiskCapPct: number;
  /** Correlated event exposure cap fraction (default 0.015 = 1.5%). */
  readonly correlatedEventExposureCapPct: number;
  /** Maximum total deployed bankroll fraction (default 0.10 = 10%). */
  readonly maxDeployedBankrollPct: number;
  /** Daily realized/unrealized loss stop fraction (default 0.02 = 2%). */
  readonly dailyLossStopPct: number;
  /** Peak-to-trough drawdown stop fraction (default 0.08 = 8%). */
  readonly peakToTroughDrawdownStopPct: number;
  /** Fractional Kelly sizing multiplier (default 0.10). */
  readonly fractionalKelly: number;
}

export interface EventEdgeDiscoveryConfig {
  /** Maximum days until market close/expiry to include in scans (default 14). */
  readonly maxCloseHorizonDays: number;
  /** Minimum minutes until close to exclude already-closed or imminent-expiry markets (default 0). */
  readonly minCloseHorizonMinutes: number;
  /** Case-insensitive category blocklist excluded from discovery scans (default: ['sports', 'entertainment awards']). */
  readonly excludedCategories: readonly string[];
  /** Maximum pages fetched per public Kalshi endpoint in a single scan (default 20). */
  readonly maxPagesPerEndpoint: number;
  /** Page size for Kalshi public /events and /markets requests (default 200). */
  readonly pageLimit: number;
  /** Delay in ms between paginated public Kalshi requests (default 250). */
  readonly rateLimitDelayMs: number;
}

export interface EventEdgeEnsembleWeights {
  /** Weight applied to `p_base` in deterministic weighted linear combination. */
  readonly p_base: number;
  /** Weight applied to `p_quant` in deterministic weighted linear combination. */
  readonly p_quant: number;
}

export interface EventEdgeForecastingConfig {
  /** Version identifier for the deterministic ensemble combiner. */
  readonly ensembleVersion: string;
  /** Non-negative stage weights normalized deterministically when multiple stages are available. */
  readonly ensembleWeights: EventEdgeEnsembleWeights;
  /** Version identifier for deterministic event_family_id derivation from event ticker. */
  readonly eventFamilyDerivationVersion: string;
  /** Minimum reference-class sample count required before p_base emits a forecast (default 1). */
  readonly minBaseRateSampleCount: number;
}

export interface EventEdgeShadowConfig {
  /** Version identifier for the shadow execution latency model (default 'ee-latency-fixed-v1'). */
  readonly latencyModelVersion: string;
  /** Simulated decision-to-venue arrival latency in milliseconds (default 250). */
  readonly latencyMs: number;
  /** Maximum permissible arrival book age relative to fill evaluation time in milliseconds (default 5000). */
  readonly maxBookAgeMs: number;
  /** Version identifier for the fee schedule applied per fill (default 'kalshi-taker-v1'). */
  readonly feeScheduleVersion: string;
}

export interface EventEdgeConfig {
  readonly mode: EventEdgeAllowedMode;
  /** Hard-locked to false; LIVE execution cannot be toggled at runtime. */
  readonly liveEnabled: false;
  readonly ledgerDbPath: string;
  readonly risk: EventEdgeRiskConfig;
  readonly discovery: EventEdgeDiscoveryConfig;
  readonly forecasting: EventEdgeForecastingConfig;
  readonly shadow: EventEdgeShadowConfig;
}

export interface EventEdgeConfigInput {
  mode?: EventEdgeMode | string;
  ledgerDbPath?: string;
  risk?: Partial<EventEdgeRiskConfig>;
  discovery?: Partial<EventEdgeDiscoveryConfig>;
  forecasting?: Partial<
    Omit<EventEdgeForecastingConfig, 'ensembleWeights'> & {
      ensembleWeights?: Partial<EventEdgeEnsembleWeights>;
    }
  >;
  shadow?: Partial<EventEdgeShadowConfig>;
}

export const EVENTEDGE_DEFAULT_RISK_CONFIG: Readonly<EventEdgeRiskConfig> = Object.freeze({
  minConservativeEdge: 0.04,
  perPositionSettledCashCapPct: 0.03,
  perEventBankrollRiskCapPct: 0.005,
  correlatedEventExposureCapPct: 0.015,
  maxDeployedBankrollPct: 0.10,
  dailyLossStopPct: 0.02,
  peakToTroughDrawdownStopPct: 0.08,
  fractionalKelly: 0.10,
});

export const EVENTEDGE_DEFAULT_DISCOVERY_CONFIG: Readonly<EventEdgeDiscoveryConfig> = Object.freeze(
  {
    maxCloseHorizonDays: 14,
    minCloseHorizonMinutes: 0,
    excludedCategories: Object.freeze(['sports', 'entertainment awards']),
    maxPagesPerEndpoint: 20,
    pageLimit: 200,
    rateLimitDelayMs: 250,
  }
);

export const EVENTEDGE_DEFAULT_FORECASTING_CONFIG: Readonly<EventEdgeForecastingConfig> =
  Object.freeze({
    ensembleVersion: 'ee-ensemble-v1.0.0',
    ensembleWeights: Object.freeze({
      p_base: 0.5,
      p_quant: 0.5,
    }),
    eventFamilyDerivationVersion: 'ee-family-prefix-v1',
    minBaseRateSampleCount: 1,
  });

export const EVENTEDGE_DEFAULT_SHADOW_CONFIG: Readonly<EventEdgeShadowConfig> = Object.freeze({
  latencyModelVersion: 'ee-latency-fixed-v1',
  latencyMs: 250,
  maxBookAgeMs: 5000,
  feeScheduleVersion: 'kalshi-taker-v1',
});

export function getDefaultEventEdgeLedgerDbPath(): string {
  return path.resolve(process.cwd(), '.eventedge_ledger.sqlite');
}

function canonicalConfigStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalConfigStringify(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalConfigStringify(obj[k])}`)
    .join(',')}}`;
}

/**
 * Computes a deterministic SHA-256 hash of the EventEdge runtime configuration,
 * including `risk`, `discovery`, `forecasting`, and `shadow` settings (excluding local file path).
 */
export function computeEventEdgeConfigHash(config: EventEdgeConfig): string {
  return crypto
    .createHash('sha256')
    .update(
      canonicalConfigStringify({
        mode: config.mode,
        risk: config.risk,
        discovery: config.discovery,
        forecasting: config.forecasting,
        shadow: config.shadow,
      })
    )
    .digest('hex');
}

/**
 * Validates and normalizes an EventEdge mode string.
 * Hard-blocks 'LIVE' regardless of casing, whitespace, or input source.
 */
export function assertNonLiveMode(
  rawMode: unknown,
  source = 'config'
): EventEdgeAllowedMode {
  if (rawMode === undefined || rawMode === null || rawMode === '') {
    return EVENTEDGE_DEFAULT_MODE;
  }
  if (typeof rawMode !== 'string') {
    throw new EventEdgeConfigValidationError(
      `Invalid EventEdge mode type (${typeof rawMode}) from ${source}. Expected one of: OBSERVE, PAPER, DEMO.`
    );
  }
  const normalized = rawMode.trim().toUpperCase();
  if (normalized === 'LIVE') {
    throw new EventEdgeLiveModeDisabledError(source);
  }
  if (normalized === 'OBSERVE' || normalized === 'PAPER' || normalized === 'DEMO') {
    return normalized;
  }
  throw new EventEdgeConfigValidationError(
    `Unknown EventEdge mode "${rawMode}" from ${source}. Valid modes: OBSERVE, PAPER, DEMO (LIVE is hard-disabled).`
  );
}

function validateFraction(
  value: number,
  name: keyof EventEdgeRiskConfig,
  minExclusive = 0,
  maxInclusive = 1
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new EventEdgeConfigValidationError(
      `EventEdge risk.${name} must be a finite number (received ${String(value)}).`
    );
  }
  if (value <= minExclusive || value > maxInclusive) {
    throw new EventEdgeConfigValidationError(
      `EventEdge risk.${name} must be in (${minExclusive}, ${maxInclusive}] (received ${value}).`
    );
  }
  return value;
}

function parseOptionalEnvNumber(
  env: Record<string, string | undefined>,
  key: string
): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed)) {
    throw new EventEdgeConfigValidationError(
      `Environment variable ${key} must be a finite number (received "${raw}").`
    );
  }
  return parsed;
}

/**
 * Computes the per-position USD cap:
 *   min(3% of settled cash, 0.5% of bankroll risk per underlying event)
 * using the configured risk fractions.
 */
export function computePerPositionCapUsd(
  settledCashUsd: number,
  bankrollUsd: number,
  risk: EventEdgeRiskConfig = EVENTEDGE_DEFAULT_RISK_CONFIG
): number {
  if (!Number.isFinite(settledCashUsd) || settledCashUsd <= 0) return 0;
  if (!Number.isFinite(bankrollUsd) || bankrollUsd <= 0) return 0;
  const settledCashCap = settledCashUsd * risk.perPositionSettledCashCapPct;
  const eventRiskCap = bankrollUsd * risk.perEventBankrollRiskCapPct;
  return Number(Math.min(settledCashCap, eventRiskCap).toFixed(6));
}

/**
 * Constructs a validated, deeply frozen EventEdgeConfig.
 * Default mode is OBSERVE. Attempting to enable LIVE via input OR env always throws.
 */
export function createEventEdgeConfig(
  input: EventEdgeConfigInput = {},
  env: Record<string, string | undefined> = process.env
): EventEdgeConfig {
  // Check env mode unconditionally first so EVENTEDGE_MODE=LIVE can never be silently ignored
  const envModeRaw = env.EVENTEDGE_MODE;
  const envMode =
    envModeRaw !== undefined && envModeRaw.trim() !== ''
      ? assertNonLiveMode(envModeRaw, 'env:EVENTEDGE_MODE')
      : undefined;

  const inputMode =
    input.mode !== undefined ? assertNonLiveMode(input.mode, 'input.mode') : undefined;

  // Reject any accidental live-toggle env vars if someone tries to smuggle one in
  const forbiddenLiveFlag = env.EVENTEDGE_ENABLE_LIVE?.trim().toLowerCase();
  if (
    forbiddenLiveFlag === 'true' ||
    forbiddenLiveFlag === '1' ||
    forbiddenLiveFlag === 'yes'
  ) {
    throw new EventEdgeLiveModeDisabledError('env:EVENTEDGE_ENABLE_LIVE');
  }

  const mode: EventEdgeAllowedMode = inputMode ?? envMode ?? EVENTEDGE_DEFAULT_MODE;

  const mergedRisk: EventEdgeRiskConfig = Object.freeze({
    minConservativeEdge: validateFraction(
      input.risk?.minConservativeEdge ??
        parseOptionalEnvNumber(env, 'EVENTEDGE_MIN_CONSERVATIVE_EDGE') ??
        EVENTEDGE_DEFAULT_RISK_CONFIG.minConservativeEdge,
      'minConservativeEdge',
      0,
      0.5
    ),
    perPositionSettledCashCapPct: validateFraction(
      input.risk?.perPositionSettledCashCapPct ??
        parseOptionalEnvNumber(env, 'EVENTEDGE_PER_POSITION_SETTLED_CASH_CAP_PCT') ??
        EVENTEDGE_DEFAULT_RISK_CONFIG.perPositionSettledCashCapPct,
      'perPositionSettledCashCapPct',
      0,
      0.05
    ),
    perEventBankrollRiskCapPct: validateFraction(
      input.risk?.perEventBankrollRiskCapPct ??
        parseOptionalEnvNumber(env, 'EVENTEDGE_PER_EVENT_BANKROLL_RISK_CAP_PCT') ??
        EVENTEDGE_DEFAULT_RISK_CONFIG.perEventBankrollRiskCapPct,
      'perEventBankrollRiskCapPct',
      0,
      0.05
    ),
    correlatedEventExposureCapPct: validateFraction(
      input.risk?.correlatedEventExposureCapPct ??
        parseOptionalEnvNumber(env, 'EVENTEDGE_CORRELATED_EVENT_EXPOSURE_CAP_PCT') ??
        EVENTEDGE_DEFAULT_RISK_CONFIG.correlatedEventExposureCapPct,
      'correlatedEventExposureCapPct',
      0,
      0.25
    ),
    maxDeployedBankrollPct: validateFraction(
      input.risk?.maxDeployedBankrollPct ??
        parseOptionalEnvNumber(env, 'EVENTEDGE_MAX_DEPLOYED_BANKROLL_PCT') ??
        EVENTEDGE_DEFAULT_RISK_CONFIG.maxDeployedBankrollPct,
      'maxDeployedBankrollPct',
      0,
      1.0
    ),
    dailyLossStopPct: validateFraction(
      input.risk?.dailyLossStopPct ??
        parseOptionalEnvNumber(env, 'EVENTEDGE_DAILY_LOSS_STOP_PCT') ??
        EVENTEDGE_DEFAULT_RISK_CONFIG.dailyLossStopPct,
      'dailyLossStopPct',
      0,
      0.5
    ),
    peakToTroughDrawdownStopPct: validateFraction(
      input.risk?.peakToTroughDrawdownStopPct ??
        parseOptionalEnvNumber(env, 'EVENTEDGE_PEAK_TO_TROUGH_DRAWDOWN_STOP_PCT') ??
        EVENTEDGE_DEFAULT_RISK_CONFIG.peakToTroughDrawdownStopPct,
      'peakToTroughDrawdownStopPct',
      0,
      0.5
    ),
    fractionalKelly: validateFraction(
      input.risk?.fractionalKelly ??
        parseOptionalEnvNumber(env, 'EVENTEDGE_FRACTIONAL_KELLY') ??
        EVENTEDGE_DEFAULT_RISK_CONFIG.fractionalKelly,
      'fractionalKelly',
      0,
      1.0
    ),
  });

  const maxCloseHorizonDays = validateDiscoveryNumber(
    input.discovery?.maxCloseHorizonDays ??
      parseOptionalEnvNumber(env, 'EVENTEDGE_DISCOVERY_MAX_CLOSE_HORIZON_DAYS') ??
      EVENTEDGE_DEFAULT_DISCOVERY_CONFIG.maxCloseHorizonDays,
    'maxCloseHorizonDays',
    0,
    3650,
    true
  );

  const minCloseHorizonMinutes = validateDiscoveryNumber(
    input.discovery?.minCloseHorizonMinutes ??
      parseOptionalEnvNumber(env, 'EVENTEDGE_DISCOVERY_MIN_CLOSE_HORIZON_MINUTES') ??
      EVENTEDGE_DEFAULT_DISCOVERY_CONFIG.minCloseHorizonMinutes,
    'minCloseHorizonMinutes',
    0,
    maxCloseHorizonDays * 24 * 60,
    false
  );

  const maxPagesPerEndpoint = validateDiscoveryInteger(
    input.discovery?.maxPagesPerEndpoint ??
      parseOptionalEnvNumber(env, 'EVENTEDGE_DISCOVERY_MAX_PAGES') ??
      EVENTEDGE_DEFAULT_DISCOVERY_CONFIG.maxPagesPerEndpoint,
    'maxPagesPerEndpoint',
    1,
    500
  );

  const pageLimit = validateDiscoveryInteger(
    input.discovery?.pageLimit ??
      parseOptionalEnvNumber(env, 'EVENTEDGE_DISCOVERY_PAGE_LIMIT') ??
      EVENTEDGE_DEFAULT_DISCOVERY_CONFIG.pageLimit,
    'pageLimit',
    1,
    200
  );

  const rateLimitDelayMs = validateDiscoveryNumber(
    input.discovery?.rateLimitDelayMs ??
      parseOptionalEnvNumber(env, 'EVENTEDGE_DISCOVERY_RATE_LIMIT_DELAY_MS') ??
      EVENTEDGE_DEFAULT_DISCOVERY_CONFIG.rateLimitDelayMs,
    'rateLimitDelayMs',
    0,
    60_000,
    false
  );

  const excludedCategories = normalizeExcludedCategories(
    input.discovery?.excludedCategories ??
      parseOptionalEnvCategoryList(env, 'EVENTEDGE_DISCOVERY_EXCLUDED_CATEGORIES') ??
      EVENTEDGE_DEFAULT_DISCOVERY_CONFIG.excludedCategories
  );

  const mergedDiscovery: EventEdgeDiscoveryConfig = Object.freeze({
    maxCloseHorizonDays,
    minCloseHorizonMinutes,
    excludedCategories,
    maxPagesPerEndpoint,
    pageLimit,
    rateLimitDelayMs,
  });

  const ensembleVersion = validateNonEmptyString(
    input.forecasting?.ensembleVersion ??
      env.EVENTEDGE_ENSEMBLE_VERSION ??
      EVENTEDGE_DEFAULT_FORECASTING_CONFIG.ensembleVersion,
    'forecasting.ensembleVersion'
  );

  const eventFamilyDerivationVersion = validateNonEmptyString(
    input.forecasting?.eventFamilyDerivationVersion ??
      env.EVENTEDGE_EVENT_FAMILY_DERIVATION_VERSION ??
      EVENTEDGE_DEFAULT_FORECASTING_CONFIG.eventFamilyDerivationVersion,
    'forecasting.eventFamilyDerivationVersion'
  );

  const rawWeightBase =
    input.forecasting?.ensembleWeights?.p_base ??
    parseOptionalEnvNumber(env, 'EVENTEDGE_ENSEMBLE_WEIGHT_BASE') ??
    EVENTEDGE_DEFAULT_FORECASTING_CONFIG.ensembleWeights.p_base;

  const rawWeightQuant =
    input.forecasting?.ensembleWeights?.p_quant ??
    parseOptionalEnvNumber(env, 'EVENTEDGE_ENSEMBLE_WEIGHT_QUANT') ??
    EVENTEDGE_DEFAULT_FORECASTING_CONFIG.ensembleWeights.p_quant;

  const weightBase = validateWeight(rawWeightBase, 'forecasting.ensembleWeights.p_base');
  const weightQuant = validateWeight(rawWeightQuant, 'forecasting.ensembleWeights.p_quant');
  if (weightBase + weightQuant <= 0) {
    throw new EventEdgeConfigValidationError(
      'EventEdge forecasting.ensembleWeights must sum to a positive value (> 0).'
    );
  }

  const minBaseRateSampleCount = validateForecastingInteger(
    input.forecasting?.minBaseRateSampleCount ??
      parseOptionalEnvNumber(env, 'EVENTEDGE_MIN_BASE_RATE_SAMPLE_COUNT') ??
      EVENTEDGE_DEFAULT_FORECASTING_CONFIG.minBaseRateSampleCount,
    'forecasting.minBaseRateSampleCount',
    1,
    1_000_000
  );

  const mergedForecasting: EventEdgeForecastingConfig = Object.freeze({
    ensembleVersion,
    ensembleWeights: Object.freeze({
      p_base: weightBase,
      p_quant: weightQuant,
    }),
    eventFamilyDerivationVersion,
    minBaseRateSampleCount,
  });

  const latencyModelVersion = validateNonEmptyString(
    input.shadow?.latencyModelVersion ??
      env.EVENTEDGE_SHADOW_LATENCY_MODEL_VERSION ??
      EVENTEDGE_DEFAULT_SHADOW_CONFIG.latencyModelVersion,
    'shadow.latencyModelVersion'
  );

  const latencyMs = validateShadowNumber(
    input.shadow?.latencyMs ??
      parseOptionalEnvNumber(env, 'EVENTEDGE_SHADOW_LATENCY_MS') ??
      EVENTEDGE_DEFAULT_SHADOW_CONFIG.latencyMs,
    'latencyMs',
    0,
    3_600_000
  );

  const maxBookAgeMs = validateShadowNumber(
    input.shadow?.maxBookAgeMs ??
      parseOptionalEnvNumber(env, 'EVENTEDGE_SHADOW_MAX_BOOK_AGE_MS') ??
      EVENTEDGE_DEFAULT_SHADOW_CONFIG.maxBookAgeMs,
    'maxBookAgeMs',
    0,
    86_400_000
  );

  const feeScheduleVersion = validateNonEmptyString(
    input.shadow?.feeScheduleVersion ??
      env.EVENTEDGE_SHADOW_FEE_SCHEDULE_VERSION ??
      EVENTEDGE_DEFAULT_SHADOW_CONFIG.feeScheduleVersion,
    'shadow.feeScheduleVersion'
  );

  const mergedShadow: EventEdgeShadowConfig = Object.freeze({
    latencyModelVersion,
    latencyMs,
    maxBookAgeMs,
    feeScheduleVersion,
  });

  const rawDbPath =
    input.ledgerDbPath ?? env.EVENTEDGE_LEDGER_DB ?? getDefaultEventEdgeLedgerDbPath();
  const ledgerDbPath =
    rawDbPath === ':memory:' ? ':memory:' : path.resolve(rawDbPath);

  return Object.freeze({
    mode,
    liveEnabled: false as const,
    ledgerDbPath,
    risk: mergedRisk,
    discovery: mergedDiscovery,
    forecasting: mergedForecasting,
    shadow: mergedShadow,
  });
}

function validateShadowNumber(
  value: number,
  name: 'latencyMs' | 'maxBookAgeMs',
  minValue: number,
  maxValue: number
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new EventEdgeConfigValidationError(
      `EventEdge shadow.${name} must be a finite number (received ${String(value)}).`
    );
  }
  if (value < minValue || value > maxValue) {
    throw new EventEdgeConfigValidationError(
      `EventEdge shadow.${name} must be in [${minValue}, ${maxValue}] (received ${value}).`
    );
  }
  return value;
}

function validateNonEmptyString(value: unknown, fieldPath: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new EventEdgeConfigValidationError(
      `EventEdge ${fieldPath} must be a non-empty string.`
    );
  }
  return value.trim();
}

function validateWeight(value: number, fieldPath: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new EventEdgeConfigValidationError(
      `EventEdge ${fieldPath} must be a finite number in [0, 1] (received ${String(value)}).`
    );
  }
  return value;
}

function validateForecastingInteger(
  value: number,
  fieldPath: string,
  minValue: number,
  maxValue: number
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minValue || value > maxValue) {
    throw new EventEdgeConfigValidationError(
      `EventEdge ${fieldPath} must be an integer in [${minValue}, ${maxValue}] (received ${String(value)}).`
    );
  }
  return value;
}

function validateDiscoveryNumber(
  value: number,
  name: keyof EventEdgeDiscoveryConfig,
  minValue: number,
  maxValue: number,
  strictMin: boolean
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new EventEdgeConfigValidationError(
      `EventEdge discovery.${name} must be a finite number (received ${String(value)}).`
    );
  }
  const failsMin = strictMin ? value <= minValue : value < minValue;
  if (failsMin || value > maxValue) {
    throw new EventEdgeConfigValidationError(
      `EventEdge discovery.${name} must be in ${strictMin ? '(' : '['}${minValue}, ${maxValue}] (received ${value}).`
    );
  }
  return value;
}

function validateDiscoveryInteger(
  value: number,
  name: keyof EventEdgeDiscoveryConfig,
  minValue: number,
  maxValue: number
): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new EventEdgeConfigValidationError(
      `EventEdge discovery.${name} must be an integer (received ${String(value)}).`
    );
  }
  if (value < minValue || value > maxValue) {
    throw new EventEdgeConfigValidationError(
      `EventEdge discovery.${name} must be in [${minValue}, ${maxValue}] (received ${value}).`
    );
  }
  return value;
}

function parseOptionalEnvCategoryList(
  env: Record<string, string | undefined>,
  key: string
): string[] | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  if (raw.trim() === '') return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeExcludedCategories(rawCategories: unknown): readonly string[] {
  if (!Array.isArray(rawCategories)) {
    throw new EventEdgeConfigValidationError(
      'EventEdge discovery.excludedCategories must be an array of category strings.'
    );
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of rawCategories) {
    if (typeof item !== 'string') {
      throw new EventEdgeConfigValidationError(
        `EventEdge discovery.excludedCategories entries must be strings (received ${typeof item}).`
      );
    }
    const cleaned = item.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
    if (cleaned.length > 0 && !seen.has(cleaned)) {
      seen.add(cleaned);
      normalized.push(cleaned);
    }
  }
  return Object.freeze(normalized);
}

/**
 * Loads an EventEdge JSON config file and constructs a validated config.
 * Enforces optional baseDir confinement and rejects mode === 'LIVE'.
 */
export function loadEventEdgeConfigFromFile(
  filePath: string,
  options: {
    baseDir?: string;
    env?: Record<string, string | undefined>;
  } = {}
): EventEdgeConfig {
  const resolvedPath = path.resolve(filePath);
  if (options.baseDir) {
    const resolvedBase = path.resolve(options.baseDir);
    const prefix = resolvedBase.endsWith(path.sep)
      ? resolvedBase
      : `${resolvedBase}${path.sep}`;
    if (!resolvedPath.startsWith(prefix)) {
      throw new EventEdgeConfigValidationError(
        `Config path "${filePath}" escapes allowed base directory.`
      );
    }
  }

  const raw = fs.readFileSync(resolvedPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new EventEdgeConfigValidationError(
      `Failed to parse EventEdge config JSON at ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EventEdgeConfigValidationError(
      `EventEdge config file ${resolvedPath} must contain a JSON object.`
    );
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.mode !== undefined) {
    assertNonLiveMode(obj.mode, `file:${resolvedPath}`);
  }
  if (obj.liveEnabled === true) {
    throw new EventEdgeLiveModeDisabledError(`file:${resolvedPath}#liveEnabled`);
  }

  return createEventEdgeConfig(
    {
      mode: obj.mode as EventEdgeMode | undefined,
      ledgerDbPath:
        typeof obj.ledgerDbPath === 'string' ? obj.ledgerDbPath : undefined,
      risk:
        obj.risk && typeof obj.risk === 'object' && !Array.isArray(obj.risk)
          ? (obj.risk as Partial<EventEdgeRiskConfig>)
          : undefined,
      discovery:
        obj.discovery && typeof obj.discovery === 'object' && !Array.isArray(obj.discovery)
          ? (obj.discovery as Partial<EventEdgeDiscoveryConfig>)
          : undefined,
      forecasting:
        obj.forecasting && typeof obj.forecasting === 'object' && !Array.isArray(obj.forecasting)
          ? (obj.forecasting as EventEdgeConfigInput['forecasting'])
          : undefined,
      shadow:
        obj.shadow && typeof obj.shadow === 'object' && !Array.isArray(obj.shadow)
          ? (obj.shadow as Partial<EventEdgeShadowConfig>)
          : undefined,
    },
    options.env ?? process.env
  );
}
