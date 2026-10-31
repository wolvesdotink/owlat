/**
 * Previous-release paths of `shareLinks/links.ts`. The share popover in a tab
 * opened before the deploy still calls `shareLinks:*` by path, so each function
 * keeps its old path, builder, auth floor, arguments and result shape, and runs
 * the same body as its replacement. Remove after release 0.6.17.
 */
import { v } from 'convex/values';
import { authedQuery, authedMutation } from './lib/authedFunctions';
import { requirePermission, hasPermission } from './lib/sessionOrganization';
import { insertShareLink, markShareLinkRevoked, readShareLinks } from './shareLinks/links';

/** Remove after release 0.6.17; this release calls `shareLinks/links:createShareLink`. */
export const createShareLink = authedMutation({
	args: {
		emailTemplateId: v.optional(v.id('emailTemplates')),
		transactionalEmailId: v.optional(v.id('transactionalEmails')),
	},
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'shareLinks:manage'),
			'Only owners and admins can create share links'
		);
		return await insertShareLink(ctx, args, session.userId);
	},
});

/** Remove after release 0.6.17; this release calls `shareLinks/links:revokeShareLink`. */
export const revokeShareLink = authedMutation({
	args: {
		shareLinkId: v.id('shareLinks'),
	},
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'shareLinks:manage'),
			'Only owners and admins can revoke share links'
		);
		await markShareLinkRevoked(ctx, args.shareLinkId);
	},
});

/** Remove after release 0.6.17; this release calls `shareLinks/links:listShareLinks`. */
// token-safe: the same reviewed exception as shareLinks/links.ts listShareLinks,
// held to shareLinks:manage.
export const listShareLinks = authedQuery({
	args: {
		emailTemplateId: v.optional(v.id('emailTemplates')),
		transactionalEmailId: v.optional(v.id('transactionalEmails')),
	},
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'shareLinks:manage'),
			'Only owners and admins can view share links'
		);
		return await readShareLinks(ctx, args);
	},
});
