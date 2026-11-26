import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { EventEdgeForecastingConfig } from '../config/index';
import type { ResearchDataSnapshot, SanitizedResearchSnapshot } from './types';

/**
 * Explicit key patterns representing market prices, orderbook state, or market-implied
 * probabilities. All matching keys are stripped structurally before any estimator runs.
 */
const MARKET_PRICE_OR_ORDERBOOK_KEY_PATTERNS: readonly RegExp[] = [
  /^yes[_-]?bid/i,
  /^yes[_-]?ask/i,
  /^no[_-]?bid/i,
  /^no[_-]?ask/i,
  /^best[_-]?bid/i,
  /^best[_-]?ask/i,
  /^last[_-]?price/i,
  /^mid[_-]?price/i,
  /^mark[_-]?price/i,
  /^market[_-]?price/i,
  /^contract[_-]?price/i,
  /^kalshi[_-]?price/i,
  /^polymarket[_-]?price/i,
  /^spot[_-]?market[_-]?price/i,
  /^implied[_-]?prob/i,
  /^market[_-]?implied/i,
  /^market[_-]?odds/i,
  /^orderbook/i,
  /^order[_-]?book/i,
  /^bids$/i,
  /^asks$/i,
  /^bid[_-]?price/i,
  /^ask[_-]?price/i,
  /^bid[_-]?size/i,
  /^ask[_-]?size/i,
  /^spread($|[_-]?usd|[_-]?cents|[_-]?bps)/i,
  /^book[_-]?seq$/i,
  /^liquidity[_-]?health/i,
  /^top[_-]?of[_-]?book/i,
  /^yesBidUsd$/i,
  /^yesAskUsd$/i,
  /^noBidUsd$/i,
  /^noAskUsd$/i,
  /^lastPriceUsd$/i,
  /^marketImpliedProb$/i,
];

/**
 * Returns true if a property key represents a market price, orderbook, or market-implied field
 * forbidden inside the price-blind probability engine.
 */
export function isMarketPriceOrOrderbookKey(key: string): boolean {
  const trimmed = key.trim();
  if (trimmed.length === 0) return false;
  return MARKET_PRICE_OR_ORDERBOOK_KEY_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function stripForbiddenKeysRecursive(
  value: unknown,
  counter: { stripped: number }
): unknown {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => stripForbiddenKeysRecursive(item, counter)));
  }

  const record = value as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};
  const sortedKeys = Object.keys(record).sort();

  for (const key of sortedKeys) {
    if (isMarketPriceOrOrderbookKey(key)) {
      counter.stripped += 1;
      continue;
    }
    cleaned[key] = stripForbiddenKeysRecursive(record[key], counter);
  }

  return Object.freeze(cleaned);
}

/**
 * Structurally strips ALL market-price, orderbook, and market-implied fields from a
 * research data snapshot (both top-level extras and nested `features`/`metadata`).
 *
 * Guarantees that two research snapshots differing ONLY in market price fields sanitize
 * to byte-for-byte identical `SanitizedResearchSnapshot` objects.
 */
export function sanitizeResearchSnapshotPriceBlind(
  snapshot: ResearchDataSnapshot
): SanitizedResearchSnapshot {
  const counter = { stripped: 0 };

  // Count any top-level price/orderbook properties smuggled onto the snapshot object
  for (const topKey of Object.keys(snapshot)) {
    if (
      topKey !== 'dataSnapshotId' &&
      topKey !== 'capturedAt' &&
      topKey !== 'features' &&
      topKey !== 'metadata' &&
      isMarketPriceOrOrderbookKey(topKey)
    ) {
      counter.stripped += 1;
    }
  }

  const rawFeatures =
    snapshot.features && typeof snapshot.features === 'object' && !Array.isArray(snapshot.features)
      ? snapshot.features
      : {};
  const rawMetadata =
    snapshot.metadata && typeof snapshot.metadata === 'object' && !Array.isArray(snapshot.metadata)
      ? snapshot.metadata
      : {};

  const sanitizedFeatures = stripForbiddenKeysRecursive(rawFeatures, counter) as Readonly<
    Record<string, unknown>
  >;
  const sanitizedMetadata = stripForbiddenKeysRecursive(rawMetadata, counter) as Readonly<
    Record<string, unknown>
  >;

  return Object.freeze({
    dataSnapshotId: String(snapshot.dataSnapshotId).trim(),
    capturedAt: String(snapshot.capturedAt).trim(),
    features: sanitizedFeatures,
    metadata: sanitizedMetadata,
    strippedPriceKeysCount: counter.stripped,
  });
}

/**
 * Deterministically derives `event_family_id` from an event ticker when no external
 * event-family model is provided.
 *
 * Rule (`ee-family-prefix-v1`):
 *   Take the leading uppercase series/family segment prior to the first `-` delimiter
 *   (e.g., `KXCPI-26NOV` -> `KXCPI`, `KXFED-26DEC` -> `KXFED`, `KXBTC15M-26NOV26` -> `KXBTC15M`),
 *   normalizing whitespace and casing.
 */
export function deriveEventFamilyId(
  eventTicker: string,
  derivationVersion: string = 'ee-family-prefix-v1'
): { readonly eventFamilyId: string; readonly eventFamilyDerivationVersion: string } {
  const normalized = eventTicker.trim().toUpperCase();
  if (normalized.length === 0) {
    return Object.freeze({
      eventFamilyId: 'UNKNOWN_FAMILY',
      eventFamilyDerivationVersion: derivationVersion,
    });
  }
  const firstSegment = normalized.split('-')[0]?.trim() || normalized;
  const cleaned = firstSegment.replace(/[^A-Z0-9_]/g, '');
  return Object.freeze({
    eventFamilyId: cleaned.length > 0 ? cleaned : normalized,
    eventFamilyDerivationVersion: derivationVersion,
  });
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`)
    .join(',')}}`;
}

/**
 * Computes a deterministic SHA-256 hash of the EventEdge forecasting configuration.
 */
export function computeForecastConfigHash(
  forecastingConfig: EventEdgeForecastingConfig
): string {
  return crypto
    .createHash('sha256')
    .update(canonicalStringify(forecastingConfig))
    .digest('hex');
}

function isFullGitSha(candidate: string): boolean {
  return /^[0-9a-f]{40}$/i.test(candidate.trim());
}

function resolveGitDir(startDir: string): string | null {
  let current = path.resolve(startDir);
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = path.join(current, '.git');
    if (fs.existsSync(candidate)) {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) {
        return candidate;
      }
      if (stat.isFile()) {
        const content = fs.readFileSync(candidate, 'utf-8').trim();
        const match = content.match(/^gitdir:\s*(.+)$/i);
        if (match && match[1]) {
          const resolvedGitDir = path.resolve(current, match[1].trim());
          if (fs.existsSync(resolvedGitDir) && fs.statSync(resolvedGitDir).isDirectory()) {
            return resolvedGitDir;
          }
        }
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Resolves the current git HEAD commit hash directly from `.git/HEAD` without spawning
 * any shell or child process. Returns the literal string `'unknown'` if no git metadata
 * is available.
 */
export function resolveCodeCommitHash(startDir: string = process.cwd()): string {
  try {
    const gitDir = resolveGitDir(startDir);
    if (!gitDir) return 'unknown';

    const headPath = path.join(gitDir, 'HEAD');
    if (!fs.existsSync(headPath)) return 'unknown';

    const headContent = fs.readFileSync(headPath, 'utf-8').trim();
    if (isFullGitSha(headContent)) {
      return headContent.toLowerCase();
    }

    const refMatch = headContent.match(/^ref:\s*(.+)$/);
    if (!refMatch || !refMatch[1]) {
      return 'unknown';
    }
    const refRelPath = refMatch[1].trim();
    if (refRelPath.includes('..') || path.isAbsolute(refRelPath)) {
      return 'unknown';
    }

    const resolvedRefPath = path.resolve(gitDir, refRelPath);
    const gitPrefix = gitDir.endsWith(path.sep) ? gitDir : `${gitDir}${path.sep}`;
    if (!resolvedRefPath.startsWith(gitPrefix)) {
      return 'unknown';
    }

    if (fs.existsSync(resolvedRefPath) && fs.statSync(resolvedRefPath).isFile()) {
      const refSha = fs.readFileSync(resolvedRefPath, 'utf-8').trim();
      if (isFullGitSha(refSha)) {
        return refSha.toLowerCase();
      }
    }

    // Fallback to `.git/packed-refs`
    const packedRefsPath = path.join(gitDir, 'packed-refs');
    if (fs.existsSync(packedRefsPath) && fs.statSync(packedRefsPath).isFile()) {
      const lines = fs.readFileSync(packedRefsPath, 'utf-8').split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('^')) continue;
        const [sha, refName] = trimmed.split(/\s+/);
        if (refName === refRelPath && sha && isFullGitSha(sha)) {
          return sha.toLowerCase();
        }
      }
    }

    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export { canonicalStringify };
