/**
 * Previous-release paths of `search/global.ts`. The command palette in a tab
 * opened before the deploy still searches through `globalSearch:search` by
 * path, and a previous release's assistant run still in progress when this one
 * deploys calls `globalSearch:searchInternal` from its `searchEverything` tool.
 * Each function keeps its old path, builder, auth floor, arguments and result
 * shape, and runs the same body as its replacement. Remove after release
 * 0.6.17.
 */

import { v } from 'convex/values';
import { internalQuery } from './_generated/server';
import { authedQuery } from './lib/authedFunctions';
import { loadAccessibleMailboxes } from './mail/permissions';
import { activeMailboxIds, runGlobalSearch, type GlobalSearchResults } from './search/global';

/** Remove after release 0.6.17; this release calls `search/global:search`. */
export const search = authedQuery({
	args: {
		query: v.string(),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args, session): Promise<GlobalSearchResults> =>
		runGlobalSearch(
			ctx,
			args.query,
			args.limit,
			activeMailboxIds(
				await loadAccessibleMailboxes(ctx, session.userId, session.activeOrganizationId)
			)
		),
});

/** Remove after release 0.6.17; this release calls `search/global:searchInternal`. */
export const searchInternal = internalQuery({
	args: {
		query: v.string(),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<GlobalSearchResults> =>
		runGlobalSearch(ctx, args.query, args.limit),
});
