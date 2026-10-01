import type { OptimisticLocalStore } from 'convex/browser';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { convexToJson, type Value } from 'convex/values';

/**
 * A stand-in for the ConvexClient's local query store: results keyed by the
 * function name plus the JSON encoding of their args, the identity Convex
 * uses. `seed` loads a server result; `get` reads what an updater left.
 */
export function fakeLocalStore() {
	const results = new Map<string, { name: string; args: Record<string, Value>; value: unknown }>();
	const key = (name: string, args: Record<string, Value>) =>
		`${name}|${JSON.stringify(convexToJson(args))}`;
	const nameOf = (query: unknown) => getFunctionName(query as FunctionReference<'query'>);

	const store = {
		getQuery(query: unknown, args: Record<string, Value> = {}) {
			return results.get(key(nameOf(query), args))?.value;
		},
		getAllQueries(query: unknown) {
			const name = nameOf(query);
			return [...results.values()]
				.filter((r) => r.name === name)
				.map(({ args, value }) => ({ args, value }));
		},
		setQuery(query: unknown, args: Record<string, Value>, value: unknown) {
			const name = nameOf(query);
			results.set(key(name, args), { name, args, value });
		},
	} as unknown as OptimisticLocalStore;

	return {
		store,
		seed(query: unknown, args: Record<string, unknown>, value: unknown) {
			(store as unknown as { setQuery: (q: unknown, a: unknown, v: unknown) => void }).setQuery(
				query,
				args,
				value
			);
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose shapes
		get(query: unknown, args: Record<string, unknown>): any {
			return results.get(key(nameOf(query), args as Record<string, Value>))?.value;
		},
	};
}
