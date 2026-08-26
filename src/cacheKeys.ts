/**
 * Canonical JSON for query args so `{ a, b }` and `{ b, a }` share a cache key.
 */
export function canonicalizeArgs(args: Record<string, unknown> = {}): string {
  return JSON.stringify(sortKeys(args));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = sortKeys(record[key]);
  }
  return sorted;
}

export function queryCacheKey(
  queryPath: string,
  args: Record<string, unknown> = {}
): string {
  return `query::${queryPath}::${canonicalizeArgs(args)}`;
}

export function legacyQueryCacheKey(
  queryPath: string,
  args: Record<string, unknown> = {}
): string {
  return `query::${queryPath}::${JSON.stringify(args)}`;
}

export function documentCacheKey(
  queryPath: string,
  args: Record<string, unknown> = {}
): string {
  return `doc::${queryPath}::${canonicalizeArgs(args)}`;
}

export function tableDocKey(table: string, id: string): string {
  return `cache_table_${table}:${id}`;
}

export function tableIdsKey(table: string): string {
  return `cache_table_${table}__ids`;
}

export function tableLegacyKey(table: string): string {
  return `cache_table_${table}`;
}
