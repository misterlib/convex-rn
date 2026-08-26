export type FunctionPath = string | object;

/**
 * Resolve a Convex function path from a string (`"tasks:list"`) or a
 * `FunctionReference` (`api.tasks.list`).
 */
export function resolveFunctionPath(path: FunctionPath): string {
  if (typeof path === 'string') {
    return path;
  }

  try {
    // Lazy require so unit tests do not need a full Convex runtime.

    const convexServer = require('convex/server') as {
      getFunctionName?: (ref: unknown) => string;
    };
    if (typeof convexServer.getFunctionName === 'function') {
      return convexServer.getFunctionName(path);
    }
  } catch {
    // fall through
  }

  const maybeName = (path as { name?: unknown }).name;
  if (typeof maybeName === 'string' && maybeName.includes(':')) {
    return maybeName;
  }

  throw new Error(
    '[ConvexSyncEngine] Unable to resolve function path. Pass a string like "module:fn" or a Convex FunctionReference.'
  );
}
