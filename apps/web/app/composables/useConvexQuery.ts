import type { FunctionReference, FunctionArgs, FunctionReturnType } from 'convex/server';
import { createConvexSubscription, type ArgsOrFactory } from '~/lib/convexSubscription';
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
 * Return "skip" from the args factory function to skip the query subscription.
 * This is useful when required arguments are not yet available.
 */
export function useConvexQuery<Query extends FunctionReference<'query'>>(
	query: Query,
	args: ArgsOrFactory<FunctionArgs<Query>>,
	options?: { timeout?: number; keepPreviousData?: boolean }
): ConvexQueryResult<FunctionReturnType<Query>> {
	const client = useConvex();
	const data = ref<FunctionReturnType<Query> | undefined>(undefined) as Ref<
		FunctionReturnType<Query> | undefined
	>;

	const subscription = createConvexSubscription<FunctionArgs<Query>, FunctionReturnType<Query>>({
		query,
		name: 'useConvexQuery',
		args,
		open: client
			? (resolved, onUpdate, onError) => client.onUpdate(query, resolved, onUpdate, onError)
			: null,
		hasData: () => data.value !== undefined,
		accept: (value) => {
			data.value = value;
		},
		clear: () => {
			data.value = undefined;
		},
		keepPreviousData: options?.keepPreviousData,
		timeout: options?.timeout,
	});

	return { data, ...subscription };
}
