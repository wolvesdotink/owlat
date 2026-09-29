import type { FunctionReference, FunctionArgs, FunctionReturnType } from 'convex/server';
import type { ConvexQueryResult } from './useConvexQuery';
import type { PaginatedQueryArgs, PaginatedQueryOptions } from './usePaginatedQuery';

/** Extra query args, or a factory that returns `undefined` while they are not ready. */
type ExtraArgs<Args> = Partial<Args> | (() => Partial<Args> | undefined);

/**
 * Args factory that holds a query until the session is authenticated and has an
 * active organization. The organization itself is not passed: the backend
 * reads it from the session.
 */
function useOrganizationArgs<Args>(extraArgs: ExtraArgs<Args> | undefined): () => Args | 'skip' {
	const { organizationId } = useOrganizationContext();
	const { isPending, isAuthenticated } = useAuth();

	return () => {
		if (isPending.value || !isAuthenticated.value) return 'skip';
		if (!organizationId.value) return 'skip';
		const extra = typeof extraArgs === 'function' ? extraArgs() : extraArgs;
		// A factory returning undefined means "not ready" — skip, don't subscribe
		// with {} (which would fire a doomed call when the query needs args).
		if (typeof extraArgs === 'function' && extra === undefined) return 'skip';
		return { ...extra } as Args;
	};
}

/**
 * Composable that wraps `useConvexQuery` with automatic session gating.
 * Skips the query until the user is authenticated and has an active organization.
 *
 * Usage:
 * ```ts
 * const { data } = useOrganizationQuery(api.domains.domains.listByOrganization)
 * const { data } = useOrganizationQuery(api.blockedEmails.listByTeam, { reason: 'bounce' })
 * const { data } = useOrganizationQuery(api.auth.apiKeys.listByTeam, () => ({ includeRevoked: true }))
 * ```
 */
export function useOrganizationQuery<Query extends FunctionReference<'query'>>(
	query: Query,
	extraArgs?: ExtraArgs<FunctionArgs<Query>>,
	options?: { timeout?: number; keepPreviousData?: boolean }
): ConvexQueryResult<FunctionReturnType<Query>> {
	return useConvexQuery(query, useOrganizationArgs<FunctionArgs<Query>>(extraArgs), options);
}

/**
 * `usePaginatedQuery` with the same session gating as `useOrganizationQuery`:
 * skipped until the user is authenticated and has an active organization, and
 * while an `extraArgs` factory returns `undefined`.
 *
 * ```ts
 * const { results } = useOrganizationPaginatedQuery(api.segments.list, undefined, { initialNumItems: 100 })
 * const { results } = useOrganizationPaginatedQuery(api.campaigns.list, () => ({ status: filter.value }), { initialNumItems: 20 })
 * ```
 */
export function useOrganizationPaginatedQuery<Query extends FunctionReference<'query'>>(
	query: Query,
	extraArgs: ExtraArgs<PaginatedQueryArgs<Query>> | undefined,
	options: PaginatedQueryOptions
) {
	return usePaginatedQuery(
		query,
		useOrganizationArgs<PaginatedQueryArgs<Query>>(extraArgs),
		options
	);
}
