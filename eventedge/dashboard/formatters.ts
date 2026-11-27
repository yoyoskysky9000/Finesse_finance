/**
 * Pure formatting and HTML-escaping helpers for the EventEdge research dashboard.
 *
 * Conventions:
 * - Probabilities and proper scores (Brier, log loss, diffs, CIs): 4 decimal places (`0.1234`)
 * - Currency values: cents (`$12.34`, `-$0.34`, or `+$1.89` when `signed: true`)
 * - Fractions / percentages: 2 decimal places (`12.34%`)
 * - Null / non-finite values: `'N/A'` (never fabricated as zeros)
 */

export function escapeHtml(raw: string): string {
  return String(raw)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatScore(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 'N/A';
  }
  const normalized = Math.abs(value) < 1e-12 ? 0 : value;
  return normalized.toFixed(4);
}

export function formatProbability(value: number | null | undefined): string {
  return formatScore(value);
}

export function formatSignedScore(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 'N/A';
  }
  const normalized = Math.abs(value) < 1e-12 ? 0 : value;
  const prefix = normalized > 0 ? '+' : '';
  return `${prefix}${normalized.toFixed(4)}`;
}

export function formatPercent(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) {
    return 'N/A';
  }
  const normalized = Math.abs(fraction) < 1e-12 ? 0 : fraction;
  return `${(normalized * 100).toFixed(2)}%`;
}

export function formatCurrency(
  amountUsd: number | null | undefined,
  options: { readonly signed?: boolean } = {}
): string {
  if (amountUsd === null || amountUsd === undefined || !Number.isFinite(amountUsd)) {
    return 'N/A';
  }
  const normalized = Math.abs(amountUsd) < 1e-12 ? 0 : amountUsd;
  const absFormatted = Math.abs(normalized).toFixed(2);
  if (normalized < 0) {
    return `-$${absFormatted}`;
  }
  if (options.signed && normalized > 0) {
    return `+$${absFormatted}`;
  }
  return `$${absFormatted}`;
}

export function formatMilliseconds(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) {
    return 'N/A';
  }
  const normalized = Math.abs(ms) < 1e-12 ? 0 : ms;
  return `${normalized.toFixed(1)} ms`;
}

export function formatInteger(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 'N/A';
  }
  return Math.trunc(value).toLocaleString('en-US');
}
