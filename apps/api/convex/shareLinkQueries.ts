/**
 * Previous-release path of `shareLinks/queries.ts`. A `/share/{token}` request
 * the previous release is still serving when this one deploys resolves
 * `internal.shareLinkQueries.getShareLinkByToken` against this release. Remove
 * after release 0.6.17.
 */
import { v } from 'convex/values';
import { internalQuery } from './_generated/server';
import { readShareLinkByToken } from './shareLinks/queries';

/** Remove after release 0.6.17; this release calls `shareLinks/queries:getShareLinkByToken`. */
export const getShareLinkByToken = internalQuery({
	args: { token: v.string() },
	handler: async (ctx, args) => await readShareLinkByToken(ctx, args.token),
});
