import { describe, it, expect } from '@jest/globals';
import { canonicalizeArgs, queryCacheKey } from '../cacheKeys';
import { resolveFunctionPath } from '../functionPath';

describe('canonicalizeArgs', () => {
  it('sorts object keys so argument order does not matter', () => {
    expect(canonicalizeArgs({ listId: 'inbox', ownerId: 'u' })).toBe(
      canonicalizeArgs({ ownerId: 'u', listId: 'inbox' })
    );
    expect(queryCacheKey('tasks:list', { b: 1, a: 2 })).toBe(
      queryCacheKey('tasks:list', { a: 2, b: 1 })
    );
  });
});

describe('resolveFunctionPath', () => {
  it('returns strings unchanged', () => {
    expect(resolveFunctionPath('tasks:list')).toBe('tasks:list');
  });

  it('reads a name property that looks like a Convex path', () => {
    expect(resolveFunctionPath({ name: 'tasks:toggle' })).toBe('tasks:toggle');
  });
});
