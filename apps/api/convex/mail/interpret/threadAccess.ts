/**
 * Who may act on a thread brief (SPEC §1): every row of the brief inherits
 * the read permission of its thread.
 *
 *   - A Postbox thread (`mail`) follows its mailbox: `requireMailboxAccess`
 *     at `member` level (the mailbox's own user, an explicit `mailboxMembers`
 *     row, or an org owner/admin).
 *   - A Team Inbox thread (`team`) follows the shared-inbox reader gate
 *     (`isSharedInboxReader`, owners and admins) with the `inbox` feature on.
 *
 * {@link requireThreadReader} throws for the caller's own writes (the viewer
 * writes in `brief.ts`, the reactions in `reactions.ts`); {@link canUserReadThread}
 * asks the same question about SOMEONE ELSE (an item's assignee must be able
 * to open the thread it is handed).
 *
 * Isolate-safe helpers, no Convex functions.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { components } from '../../_generated/api';
import { isFeatureEnabled } from '../../lib/featureFlags';
import {
	getSingletonOrganizationId,
	requirePermission,
	type MutationSessionContext,
	type OrganizationRole,
} from '../../lib/sessionOrganization';
import { isLiveOrgMember } from '../../lib/userProfiles';
import { getOrThrow, throwForbidden } from '../../_utils/errors';
import { isSharedInboxReader } from '../../inbox/access';
import { canUserReadMailbox, requireMailboxAccess } from '../permissions';
import { threadRefFromFields, type ThreadRef } from '../../lib/validators/threadRef';

/** Throw unless the session may read the thread (the writes' reader rule). */
export async function requireThreadReader(
	ctx: MutationCtx,
	ref: ThreadRef,
	session: MutationSessionContext
): Promise<void> {
	if (ref.kind === 'mail') {
		const thread = await getOrThrow(ctx, ref.id, 'Thread');
		const owned = await requireMailboxAccess(ctx, thread.mailboxId, 'member', session);
		if (!owned.ok) throwForbidden('Thread not accessible');
		return;
	}
	await getOrThrow(ctx, ref.id, 'Thread');
	requirePermission(isSharedInboxReader(session), 'Only owners and admins can use the Team Inbox');
	if (!(await isFeatureEnabled(ctx, 'inbox'))) throwForbidden('The Team Inbox is turned off');
}

/**
 * Load an item and apply its thread's reader rule. Returns the item and its
 * thread reference; throws `not_found` for a missing item and `forbidden` for
 * a caller who may not read the thread.
 */
export async function requireItemReader(
	ctx: MutationCtx,
	itemId: Id<'threadItems'>,
	session: MutationSessionContext
): Promise<{ item: Doc<'threadItems'>; ref: ThreadRef }> {
	const item = await getOrThrow(ctx, itemId, 'Item');
	const ref = threadRefFromFields(item);
	await requireThreadReader(ctx, ref, session);
	return { item, ref };
}

/** The org role of another user, or null when they are not a member. */
async function memberRoleOf(ctx: MutationCtx, userId: string): Promise<OrganizationRole | null> {
	const organizationId = await getSingletonOrganizationId(ctx);
	const member = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
		model: 'member',
		where: [
			{ field: 'organizationId', value: organizationId },
			{ field: 'userId', value: userId },
		],
	})) as { role?: string } | null;
	return (member?.role ?? null) as OrganizationRole | null;
}

/**
 * Could `userId` read the thread right now? The same rule as
 * {@link requireThreadReader}, asked about a live org member other than the
 * caller: mailbox access for a mail thread, the shared-inbox reader role for
 * a Team Inbox thread.
 */
export async function canUserReadThread(
	ctx: MutationCtx,
	ref: ThreadRef,
	userId: string
): Promise<boolean> {
	if (!(await isLiveOrgMember(ctx, userId))) return false;
	if (ref.kind === 'mail') {
		const thread = await ctx.db.get(ref.id);
		const mailbox = thread ? await ctx.db.get(thread.mailboxId) : null;
		return mailbox ? canUserReadMailbox(ctx, mailbox, userId) : false;
	}
	return isSharedInboxReader({ role: await memberRoleOf(ctx, userId) });
}
