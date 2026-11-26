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

export interface EventEdgeConfig {
  readonly mode: EventEdgeAllowedMode;
  /** Hard-locked to false; LIVE execution cannot be toggled at runtime. */
  readonly liveEnabled: false;
  readonly ledgerDbPath: string;
  readonly risk: EventEdgeRiskConfig;
}

export interface EventEdgeConfigInput {
  mode?: EventEdgeMode | string;
  ledgerDbPath?: string;
  risk?: Partial<EventEdgeRiskConfig>;
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

export function getDefaultEventEdgeLedgerDbPath(): string {
  return path.resolve(process.cwd(), '.eventedge_ledger.sqlite');
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

  const rawDbPath =
    input.ledgerDbPath ?? env.EVENTEDGE_LEDGER_DB ?? getDefaultEventEdgeLedgerDbPath();
  const ledgerDbPath =
    rawDbPath === ':memory:' ? ':memory:' : path.resolve(rawDbPath);

  return Object.freeze({
    mode,
    liveEnabled: false as const,
    ledgerDbPath,
    risk: mergedRisk,
  });
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
    },
    options.env ?? process.env
  );
}
