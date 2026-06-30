import type { FunctionReference, FunctionArgs, FunctionReturnType } from 'convex/server';
import type { ConvexQueryResult } from './useConvexQuery';

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
	extraArgs?: Partial<FunctionArgs<Query>> | (() => Partial<FunctionArgs<Query>> | undefined)
): ConvexQueryResult<FunctionReturnType<Query>> {
	const { organizationId } = useOrganizationContext();
	const { isPending, isAuthenticated } = useAuth();

	return useConvexQuery(query, () => {
		if (isPending.value || !isAuthenticated.value) return 'skip';
		if (!organizationId.value) return 'skip';
		const extra = typeof extraArgs === 'function' ? extraArgs() : extraArgs;
		// A factory returning undefined means "not ready" — skip, don't subscribe
		// with {} (which would fire a doomed call when the query needs args).
		if (typeof extraArgs === 'function' && extra === undefined) return 'skip';
		return { ...extra } as FunctionArgs<Query>;
	});
}
