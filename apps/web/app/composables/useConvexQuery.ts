import type { FunctionReference, FunctionArgs, FunctionReturnType } from 'convex/server';
import { createConvexSubscription, type ArgsOrFactory } from '~/lib/convexSubscription';
import { shareStructure } from '~/lib/structuralSharing';
import type { Ref } from 'vue';

export type { ArgsOrFactory } from '~/lib/convexSubscription';

/** Return type of useConvexQuery, preserving the query result type */
export interface ConvexQueryResult<T> {
	data: Ref<T | undefined>;
	error: Ref<Error | null>;
	isLoading: Ref<boolean>;
	/** True while re-subscribing with `keepPreviousData` and prior data is still shown. */
	isRefetching: Ref<boolean>;
	/**
	 * Force a fresh read by re-subscribing with the current args, keeping the
	 * prior data visible in the background. Needed when the query's result derives
	 * from state Convex can't invalidate reactively (e.g. `delivery.status`, which
	 * reads deployment env — an env change won't self-invalidate the subscription).
	 * Also the handler behind a "Try again" control once `error` is set.
	 */
	refetch: () => void;
	/**
	 * Blank `data` so the next delivery is a first load, not a stale bridge. For a
	 * `keepPreviousData` query whose surface starts over (a search overlay
	 * reopening), so it never shows the previous session's result.
	 */
	reset: () => void;
}

/**
 * Composable for subscribing to a Convex query.
 * Automatically updates when the data changes.
 *
 * A transient server failure (a function timeout, an uncaught error) is retried
 * a few times with backoff before it reaches `error`; until then the query stays
 * in its loading (or background-refetching) state. Refusals the backend makes
 * on purpose (`ConvexError`) surface at once. The lifecycle lives in
 * `~/lib/convexSubscription`, shared with `usePaginatedQuery`.
 *
 * Every component reading the same query with the same args shares one
 * subscription, and a query stays subscribed for a while after its last reader
 * unmounts: coming back to it (back navigation, a tab switch) renders its value
 * in the same tick, with no loading state. A query paged by a growable limit
 * names it as `windowArg`, so "Load more" closes the window it outgrew.
 *
 * `data` is a shallow ref holding the value as delivered: treat it as read-only,
 * never mutate a row in place (copy it, or keep edits in local state). Rows that
 * did not change between two updates keep their object (see
 * `~/lib/structuralSharing`), so only the rows that did change re-render, and an
 * update that changes nothing leaves `data` untouched.
 *
 * Return "skip" from the args factory function to skip the query subscription.
 * This is useful when required arguments are not yet available.
 */
export function useConvexQuery<Query extends FunctionReference<'query'>>(
	query: Query,
	args: ArgsOrFactory<FunctionArgs<Query>>,
	options?: {
		timeout?: number;
		keepPreviousData?: boolean;
		/**
		 * The arg a "Load more" grows (a `limit`). Growing or shrinking it closes
		 * the previous window once no one else reads it, instead of keeping it
		 * warm; see `windowArg` in `~/lib/convexSubscription`.
		 */
		windowArg?: keyof FunctionArgs<Query> & string;
	}
): ConvexQueryResult<FunctionReturnType<Query>> {
	const client = useConvex();
	const data = shallowRef<FunctionReturnType<Query> | undefined>(undefined) as Ref<
		FunctionReturnType<Query> | undefined
	>;

	const subscription = createConvexSubscription<FunctionArgs<Query>, FunctionReturnType<Query>>({
		query,
		name: 'useConvexQuery',
		args,
		open: client
			? (resolved, onUpdate, onError) => client.onUpdate(query, resolved, onUpdate, onError)
			: null,
		// One `onUpdate` per query and args for the whole app, kept warm briefly
		// after the last component using it unmounts. See ~/lib/sharedConvexSubscriptions.
		share: client ? { source: client, variant: 'query' } : undefined,
		hasData: () => data.value !== undefined,
		accept: (value) => {
			data.value = shareStructure(data.value, value);
		},
		clear: () => {
			data.value = undefined;
		},
		keepPreviousData: options?.keepPreviousData,
		windowArg: options?.windowArg,
		timeout: options?.timeout,
	});

	return { data, ...subscription };
}
