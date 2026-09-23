import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server';
import { effectScope, type EffectScope, type Ref } from 'vue';
import type { ConvexQueryResult } from './useConvexQuery';

/**
 * One live Convex subscription per key — for reads that exist per mailbox
 * (the Postbox queries check access per mailbox, so Today and the sidebar
 * subscribe once per inbox and merge client-side instead of widening a read).
 *
 * Keys come and go reactively: a new key opens its subscription in its own
 * effect scope, a removed key's scope is stopped (closing the socket
 * subscription), and everything closes with the caller's scope.
 */
export function useConvexQueryMap<Query extends FunctionReference<'query'>, Key extends string>(
	query: Query,
	keys: Ref<readonly Key[]>,
	argsFor: (key: Key) => FunctionArgs<Query> | 'skip'
): Map<Key, ConvexQueryResult<FunctionReturnType<Query>>> {
	const results = shallowReactive(new Map<Key, ConvexQueryResult<FunctionReturnType<Query>>>());
	const scopes = new Map<Key, EffectScope>();

	watch(
		keys,
		(next) => {
			const wanted = new Set(next);
			for (const [key, scope] of scopes) {
				if (wanted.has(key)) continue;
				scope.stop();
				scopes.delete(key);
				results.delete(key);
			}
			for (const key of next) {
				if (scopes.has(key)) continue;
				const scope = effectScope();
				scopes.set(key, scope);
				const result = scope.run(() => useConvexQuery(query, () => argsFor(key)));
				if (result) results.set(key, result);
			}
		},
		{ immediate: true }
	);

	onScopeDispose(() => {
		for (const scope of scopes.values()) scope.stop();
		scopes.clear();
	});

	return results;
}
