/**
 * Holds a Convex query open in the shared-subscription registry without a
 * component reading it: the read-ahead keeps the next and previous rows'
 * thread and body queries live, so the reader that opens one of them later
 * joins a loaded subscription and renders in the same tick.
 *
 * The key is built exactly as `useConvexQuery` builds it (same client, the
 * plain `'query'` variant, the args' value identity), so a later
 * `useConvexQuery` of the same query and args shares this subscription rather
 * than opening a second one. Releasing the hold hands the subscription to the
 * registry's linger like any other owner leaving.
 */
import type { ConvexClient } from 'convex/browser';
import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server';
import { argsIdentity } from '~/lib/convexSubscription';
import { lingerClassOf, openShared, sharedSubscriptionKey } from '~/lib/sharedConvexSubscriptions';

export type HoldClient = Pick<ConvexClient, 'onUpdate'>;

/** The registry variant `useConvexQuery` shares plain queries under. */
const PLAIN_QUERY_VARIANT = 'query';

export function holdConvexQuery<Query extends FunctionReference<'query'>>(
	client: HoldClient,
	query: Query,
	args: FunctionArgs<Query>,
	onValue?: (value: FunctionReturnType<Query>) => void
): () => void {
	const key = sharedSubscriptionKey(
		{ source: client, variant: PLAIN_QUERY_VARIANT },
		query,
		argsIdentity(args)
	);
	return openShared<FunctionArgs<Query>, FunctionReturnType<Query>>(
		key,
		args,
		(resolved, onUpdate, onError) => client.onUpdate(query, resolved, onUpdate, onError),
		{
			update: (value) => onValue?.(value as FunctionReturnType<Query>),
			// A failed warm-up is harmless: the registry drops the failed entry, and
			// the reader that opens the message runs its own authoritative query.
			fail: () => {},
		},
		false,
		lingerClassOf(query)
	);
}
