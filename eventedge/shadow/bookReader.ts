import type { DatabaseSync } from 'node:sqlite';
import {
  DecisionBookNotFoundError,
  ShadowExecutionValidationError,
  type CapturedBookSnapshot,
  type PersistOrderbookStateInput,
} from './types';

interface RawOrderbookStateRow {
  orderbook_state_id: string;
  market_ticker: string;
  best_bid_usd: number | null;
  best_ask_usd: number | null;
  yes_bid_size_fp: number | null;
  yes_ask_size_fp: number | null;
  bids_json: string;
  asks_json: string;
  captured_at: string;
}

interface RawMarketSnapshotRow {
  snapshot_id: string;
  market_ticker: string;
  yes_bid_usd: number | null;
  yes_ask_usd: number | null;
  raw_payload_json: string;
  captured_at: string;
}

function parseTopLevelSizeFromJson(levelsJson: string): number | null {
  try {
    const parsed = JSON.parse(levelsJson) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const first = parsed[0];
    if (Array.isArray(first) && first.length >= 2) {
      const sz = Number(first[1]);
      return Number.isFinite(sz) && sz >= 0 ? sz : null;
    }
    return null;
  } catch {
    return null;
  }
}

function parseSizeFromRawPayload(rawPayloadJson: string, keys: readonly string[]): number {
  try {
    const parsed = JSON.parse(rawPayloadJson) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return 0;
    for (const k of keys) {
      const val = parsed[k];
      if (val !== undefined && val !== null && val !== '') {
        const num = Number(val);
        if (Number.isFinite(num) && num >= 0) {
          return num;
        }
      }
    }
    return 0;
  } catch {
    return 0;
  }
}

function mapOrderbookStateRow(row: RawOrderbookStateRow): CapturedBookSnapshot | null {
  const bid = row.best_bid_usd === null ? null : Number(row.best_bid_usd);
  const ask = row.best_ask_usd === null ? null : Number(row.best_ask_usd);
  if (
    bid === null ||
    ask === null ||
    !Number.isFinite(bid) ||
    !Number.isFinite(ask) ||
    bid < 0 ||
    bid > 1 ||
    ask < 0 ||
    ask > 1
  ) {
    return null;
  }

  const bidSize =
    row.yes_bid_size_fp !== null && Number.isFinite(Number(row.yes_bid_size_fp))
      ? Math.max(0, Number(row.yes_bid_size_fp))
      : (parseTopLevelSizeFromJson(row.bids_json) ?? 0);

  const askSize =
    row.yes_ask_size_fp !== null && Number.isFinite(Number(row.yes_ask_size_fp))
      ? Math.max(0, Number(row.yes_ask_size_fp))
      : (parseTopLevelSizeFromJson(row.asks_json) ?? 0);

  return Object.freeze({
    snapshotId: row.orderbook_state_id,
    sourceTable: 'orderbook_states' as const,
    marketId: row.market_ticker,
    yesBidUsd: bid,
    yesAskUsd: ask,
    yesBidSize: bidSize,
    yesAskSize: askSize,
    capturedAt: row.captured_at,
  });
}

function mapMarketSnapshotRow(row: RawMarketSnapshotRow): CapturedBookSnapshot | null {
  const bid = row.yes_bid_usd === null ? null : Number(row.yes_bid_usd);
  const ask = row.yes_ask_usd === null ? null : Number(row.yes_ask_usd);
  if (
    bid === null ||
    ask === null ||
    !Number.isFinite(bid) ||
    !Number.isFinite(ask) ||
    bid < 0 ||
    bid > 1 ||
    ask < 0 ||
    ask > 1
  ) {
    return null;
  }

  const bidSize = parseSizeFromRawPayload(row.raw_payload_json, [
    'yes_bid_size_fp',
    'yes_bid_size',
    'yesBidSizeFp',
    'yesBidSize',
  ]);
  const askSize = parseSizeFromRawPayload(row.raw_payload_json, [
    'yes_ask_size_fp',
    'yes_ask_size',
    'yesAskSizeFp',
    'yesAskSize',
  ]);

  return Object.freeze({
    snapshotId: row.snapshot_id,
    sourceTable: 'market_snapshots' as const,
    marketId: row.market_ticker,
    yesBidUsd: bid,
    yesAskUsd: ask,
    yesBidSize: bidSize,
    yesAskSize: askSize,
    capturedAt: row.captured_at,
  });
}

/**
 * Append-only parameterized helper for inserting captured book snapshots into EE-00's
 * immutable `orderbook_states` ledger table.
 */
export function persistOrderbookState(
  db: DatabaseSync,
  input: PersistOrderbookStateInput
): CapturedBookSnapshot {
  const id = input.orderbookStateId.trim();
  const marketTicker = input.marketTicker.trim();
  const venue = (input.venue ?? 'KALSHI').trim() || 'KALSHI';
  const capturedAt = input.capturedAt.trim();

  if (!id || !marketTicker || !capturedAt || !Number.isFinite(Date.parse(capturedAt))) {
    throw new ShadowExecutionValidationError(
      'orderbookStateId, marketTicker, and a valid ISO-8601 capturedAt are required.'
    );
  }
  if (
    !Number.isFinite(input.bestBidUsd) ||
    !Number.isFinite(input.bestAskUsd) ||
    input.bestBidUsd < 0 ||
    input.bestBidUsd > 1 ||
    input.bestAskUsd < 0 ||
    input.bestAskUsd > 1
  ) {
    throw new ShadowExecutionValidationError(
      'bestBidUsd and bestAskUsd must be finite probabilities in [0, 1].'
    );
  }
  if (
    !Number.isFinite(input.yesBidSizeFp) ||
    !Number.isFinite(input.yesAskSizeFp) ||
    input.yesBidSizeFp < 0 ||
    input.yesAskSizeFp < 0
  ) {
    throw new ShadowExecutionValidationError(
      'yesBidSizeFp and yesAskSizeFp must be non-negative finite numbers.'
    );
  }

  const spreadUsd = Number(Math.max(0, input.bestAskUsd - input.bestBidUsd).toFixed(6));
  const bidsJson = JSON.stringify(
    input.bids ?? [[input.bestBidUsd, input.yesBidSizeFp]]
  );
  const asksJson = JSON.stringify(
    input.asks ?? [[input.bestAskUsd, input.yesAskSizeFp]]
  );

  db.prepare(
    `INSERT INTO orderbook_states (
      orderbook_state_id, venue, market_ticker,
      best_bid_usd, best_ask_usd, spread_usd,
      yes_bid_size_fp, yes_ask_size_fp, lhs,
      bids_json, asks_json, book_seq, captured_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    venue,
    marketTicker,
    input.bestBidUsd,
    input.bestAskUsd,
    spreadUsd,
    input.yesBidSizeFp,
    input.yesAskSizeFp,
    input.lhs ?? null,
    bidsJson,
    asksJson,
    input.bookSeq ?? null,
    capturedAt
  );

  return Object.freeze({
    snapshotId: id,
    sourceTable: 'orderbook_states' as const,
    marketId: marketTicker,
    yesBidUsd: input.bestBidUsd,
    yesAskUsd: input.bestAskUsd,
    yesBidSize: input.yesBidSizeFp,
    yesAskSize: input.yesAskSizeFp,
    capturedAt,
  });
}

/**
 * Loads all captured book snapshots for a market ordered chronologically by `captured_at ASC`.
 * Reads `orderbook_states` first (primary EE-00 book table with displayed top-of-book depth),
 * falling back to `market_snapshots` only when the market has no `orderbook_states` rows.
 */
export function listCapturedBookSnapshotsForMarket(
  db: DatabaseSync,
  marketId: string
): readonly CapturedBookSnapshot[] {
  const trimmedMarket = marketId.trim();

  const obRows = db
    .prepare(
      `SELECT
        orderbook_state_id, market_ticker, best_bid_usd, best_ask_usd,
        yes_bid_size_fp, yes_ask_size_fp, bids_json, asks_json, captured_at
      FROM orderbook_states
      WHERE market_ticker = ?
      ORDER BY captured_at ASC, rowid ASC`
    )
    .all(trimmedMarket) as unknown as RawOrderbookStateRow[];

  if (obRows.length > 0) {
    const mapped = obRows
      .map(mapOrderbookStateRow)
      .filter((row): row is CapturedBookSnapshot => row !== null);
    mapped.sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
    return Object.freeze(mapped);
  }

  const msRows = db
    .prepare(
      `SELECT
        snapshot_id, market_ticker, yes_bid_usd, yes_ask_usd,
        raw_payload_json, captured_at
      FROM market_snapshots
      WHERE market_ticker = ?
      ORDER BY captured_at ASC, rowid ASC`
    )
    .all(trimmedMarket) as unknown as RawMarketSnapshotRow[];

  const mapped = msRows
    .map(mapMarketSnapshotRow)
    .filter((row): row is CapturedBookSnapshot => row !== null);
  mapped.sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  return Object.freeze(mapped);
}

/**
 * Finds the decision-time book snapshot for `marketId`:
 * - If `explicitSnapshotId` is provided, locates that exact snapshot and verifies
 *   `captured_at <= decisionTimestamp`.
 * - Otherwise selects the latest captured snapshot with `captured_at <= decisionTimestamp`.
 */
export function findDecisionBookSnapshot(
  db: DatabaseSync,
  marketId: string,
  decisionTimestamp: string,
  explicitSnapshotId?: string
): CapturedBookSnapshot {
  const decisionEpochMs = Date.parse(decisionTimestamp);
  if (!Number.isFinite(decisionEpochMs)) {
    throw new ShadowExecutionValidationError(
      `Invalid decisionTimestamp "${decisionTimestamp}". Expected ISO-8601 timestamp.`
    );
  }

  const snapshots = listCapturedBookSnapshotsForMarket(db, marketId);

  if (explicitSnapshotId && explicitSnapshotId.trim().length > 0) {
    const targetId = explicitSnapshotId.trim();
    const matched = snapshots.find((s) => s.snapshotId === targetId);
    if (!matched) {
      throw new DecisionBookNotFoundError(
        marketId,
        decisionTimestamp,
        `explicit snapshot "${targetId}" not found`
      );
    }
    if (Date.parse(matched.capturedAt) > decisionEpochMs) {
      throw new DecisionBookNotFoundError(
        marketId,
        decisionTimestamp,
        `explicit snapshot "${targetId}" captured at "${matched.capturedAt}" is after decisionTimestamp`
      );
    }
    return matched;
  }

  let best: CapturedBookSnapshot | null = null;
  let bestEpochMs = Number.NEGATIVE_INFINITY;
  for (const snap of snapshots) {
    const snapEpochMs = Date.parse(snap.capturedAt);
    if (snapEpochMs <= decisionEpochMs && snapEpochMs >= bestEpochMs) {
      best = snap;
      bestEpochMs = snapEpochMs;
    }
  }

  if (!best) {
    throw new DecisionBookNotFoundError(marketId, decisionTimestamp);
  }
  return best;
}

/**
 * Finds the earliest captured book snapshot for `marketId` with `captured_at >= arrivalTimestamp`,
 * or `null` if no snapshot was captured at or after arrival time (`BOOK_NOT_CAPTURED`).
 */
export function findArrivalBookSnapshot(
  db: DatabaseSync,
  marketId: string,
  arrivalTimestamp: string
): CapturedBookSnapshot | null {
  const arrivalEpochMs = Date.parse(arrivalTimestamp);
  if (!Number.isFinite(arrivalEpochMs)) {
    throw new ShadowExecutionValidationError(
      `Invalid arrivalTimestamp "${arrivalTimestamp}". Expected ISO-8601 timestamp.`
    );
  }

  const snapshots = listCapturedBookSnapshotsForMarket(db, marketId);
  for (const snap of snapshots) {
    const snapEpochMs = Date.parse(snap.capturedAt);
    if (snapEpochMs >= arrivalEpochMs) {
      return snap;
    }
  }
  return null;
}
