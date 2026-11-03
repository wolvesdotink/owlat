/**
 * What an MCP client may reach at the moment of a call.
 *
 * A token is never trusted on its own. Every call reloads the client row and
 * re-derives its reach from the live state the web app uses: the `mail.mcp`
 * flag, the owner's membership in the client's organization, and the owner's
 * own Postbox mailbox list (`loadAccessibleMailboxes`, the list the mailbox
 * switcher shows). The client sees the intersection of that list with the
 * mailboxes chosen when the token was made. Removing the member, their
 * membership of a team inbox, or the flag cuts the token off on the next call
 * without touching the row.
 *
 * The mailbox list, not `requireMailboxAccess`, is the bound on purpose: the
 * session gate also lets an org owner or admin open any mailbox by id, and a
 * token must not turn that into a standing grant over a teammate's personal
 * mail.
 *
 * Not a Convex function; the helpers `mcp/reads.ts` builds on.
 */

import { components } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { isFeatureEnabled } from '../lib/featureFlags';
import { loadAccessibleMailboxes } from '../mail/permissions';

export type McpAccess =
	| { ok: true; client: Doc<'mcpClients'>; mailboxes: Array<Doc<'mailboxes'>> }
	| { ok: false; reason: 'client_missing' | 'revoked' | 'feature_off' | 'not_member' };

/** Is `userId` still a member of `organizationId`? */
export async function isOrganizationMember(
	ctx: QueryCtx,
	organizationId: string,
	userId: string
): Promise<boolean> {
	const member = await ctx.runQuery(components.betterAuth.adapter.findOne, {
		model: 'member',
		where: [
			{ field: 'organizationId', value: organizationId },
			{ field: 'userId', value: userId },
		],
	});
	return member !== null;
}

/**
 * The mailboxes `userId` sees in their own Postbox in `organizationId`, active
 * ones only. The organization filter also covers the owned side, which
 * `loadAccessibleMailboxes` reads by user alone.
 */
export async function loadMcpEligibleMailboxes(
	ctx: QueryCtx,
	userId: string,
	organizationId: string
): Promise<Array<Doc<'mailboxes'>>> {
	const mailboxes = await loadAccessibleMailboxes(ctx, userId, organizationId);
	return mailboxes.filter(
		(mailbox) => mailbox.status === 'active' && mailbox.organizationId === organizationId
	);
}

export async function resolveMcpAccess(
	ctx: QueryCtx,
	clientId: Id<'mcpClients'>
): Promise<McpAccess> {
	const client = await ctx.db.get(clientId);
	if (!client) return { ok: false, reason: 'client_missing' };
	if (client.revokedAt !== undefined) return { ok: false, reason: 'revoked' };
	if (!(await isFeatureEnabled(ctx, 'mail.mcp'))) return { ok: false, reason: 'feature_off' };
	if (!(await isOrganizationMember(ctx, client.organizationId, client.userId))) {
		return { ok: false, reason: 'not_member' };
	}
	const chosen = new Set<Id<'mailboxes'>>(client.mailboxIds);
	const eligible = await loadMcpEligibleMailboxes(ctx, client.userId, client.organizationId);
	return { ok: true, client, mailboxes: eligible.filter((mailbox) => chosen.has(mailbox._id)) };
}
