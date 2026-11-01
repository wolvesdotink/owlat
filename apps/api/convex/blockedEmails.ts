/**
 * Previous-release paths of `blockedEmails/blocklist.ts` and
 * `blockedEmails/events.ts`. The Suppressions page, the contact page and the
 * delivery overview in a tab opened before the deploy call `blockedEmails:*`
 * by path, and a webhook, send-response or import run the previous release
 * started mid-run writes through `blockedEmails:addFromEvent`. Each keeps its
 * old path, builder, auth floor, arguments and result shape, and runs the same
 * body as its replacement. Remove after release 0.6.17.
 */
import { internalMutation } from './lib/writeFence';
import { authedMutation, authedQuery } from './lib/authedFunctions';
import { countBlockedByReason, findBlockedByEmail } from './blockedEmails/lookup';
import {
	addBlockedEmail,
	addBlockedEmailArgs,
	bulkAddArgs,
	bulkAddBlockedEmails,
	getByEmailArgs,
	listBlockedEmails,
	listByTeamArgs,
	listProviderEvidence,
	removeBlockedEmail,
	removeBlockedEmailArgs,
} from './blockedEmails/blocklist';
import { addFromEventArgs, addProviderSuppression } from './blockedEmails/events';

/** Remove after release 0.6.17; this release calls `blockedEmails/blocklist:listByTeam`. */
// all-members: the suppression list every member may read before sending (the
// audience Suppressions page). The provider audit evidence behind a row stays
// admin-only in `listProviderProvenance`.
export const listByTeam = authedQuery({
	args: listByTeamArgs,
	handler: async (ctx, args) => await listBlockedEmails(ctx, args),
});

/** Remove after release 0.6.17; this release calls `blockedEmails/blocklist:listProviderProvenance`. */
// authz: listProviderEvidence requires organization:manage before it reads.
export const listProviderProvenance = authedQuery({
	args: {},
	handler: async (ctx, _args, session) => await listProviderEvidence(ctx, session),
});

/** Remove after release 0.6.17; this release calls `blockedEmails/blocklist:getByEmail`. */
// all-members: the suppression state the contact detail page shows every member.
export const getByEmail = authedQuery({
	args: getByEmailArgs,
	handler: async (ctx, args) => await findBlockedByEmail(ctx, args.email),
});

/** Remove after release 0.6.17; this release calls `blockedEmails/blocklist:add`. */
// authz: addBlockedEmail requires contacts:manage before it writes.
export const add = authedMutation({
	args: addBlockedEmailArgs,
	handler: async (ctx, args, session) => await addBlockedEmail(ctx, args, session),
});

/** Remove after release 0.6.17; this release calls `blockedEmails/blocklist:remove`. */
// authz: removeBlockedEmail requires contacts:manage before it reads or writes.
export const remove = authedMutation({
	args: removeBlockedEmailArgs,
	handler: async (ctx, args, session) =>
		await removeBlockedEmail(ctx, args.blockedEmailId, session),
});

/** Remove after release 0.6.17; this release calls `blockedEmails/blocklist:bulkAdd`. */
// authz: bulkAddBlockedEmails requires contacts:manage before it writes.
export const bulkAdd = authedMutation({
	args: bulkAddArgs,
	handler: async (ctx, args, session) => await bulkAddBlockedEmails(ctx, args, session),
});

/** Remove after release 0.6.17; this release calls `blockedEmails/blocklist:getCountsByReason`. */
// all-members: per-reason counts behind the member-readable suppression list.
export const getCountsByReason = authedQuery({
	args: {},
	handler: async (ctx) => await countBlockedByReason(ctx),
});

/** Remove after release 0.6.17; this release calls `blockedEmails/events:addFromEvent`. */
export const addFromEvent = internalMutation({
	args: addFromEventArgs,
	handler: async (ctx, args) => await addProviderSuppression(ctx, args),
});
