import type { QueryCtx } from '../_generated/server';

// Only the key lives in module state. Auth data belongs to the invocation's ctx.
const queryCache = Symbol('sessionQueryCache');
type CacheKey = 'session' | 'sessionWithRole' | 'singletonOrganization';
type CachedCtx = { [queryCache]?: Partial<Record<CacheKey, Promise<unknown>>> };

/**
 * Called once at a query builder's entry, before its auth floor. A query reads
 * one immutable snapshot, so concurrent/repeated auth reads can share promises.
 * Never initialize this for mutations or actions: their later reads can see
 * changes, including membership removal. A fresh cache also covers ctx reuse.
 */
export function initializeSessionQueryCache(ctx: QueryCtx): void {
	Object.defineProperty(ctx, queryCache, { value: {}, configurable: true });
}

export function memoizeSessionQuery<T>(
	ctx: object,
	key: CacheKey,
	load: () => Promise<T>
): Promise<T> {
	const cache = (ctx as CachedCtx)[queryCache];
	if (!cache) return load();
	// Retain rejected promises too: auth failures must not trigger duplicate I/O.
	return (cache[key] ??= load()) as Promise<T>;
}

/** A query handler that starts its invocation with a fresh session cache. */
export function withSessionQueryCache(handler: unknown) {
	return (ctx: QueryCtx, args: unknown) => {
		initializeSessionQueryCache(ctx);
		return (handler as (ctx: QueryCtx, args: unknown) => unknown)(ctx, args);
	};
}

/** A function config whose handler starts with a fresh session cache. */
export function withQueryCacheConfig<T extends { handler: unknown }>(fn: T): T {
	return { ...fn, handler: withSessionQueryCache(fn.handler) };
}
