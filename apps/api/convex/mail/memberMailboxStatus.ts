/**
 * Per-member mailbox status for the Team settings page.
 *
 * The team roster comes from BetterAuth (member rows), but "does this teammate
 * have a mailbox, and is it hosted here or a connected external account?" lives
 * in the Convex `mailboxes` table. This module exposes a single read that maps a
 * set of BetterAuth user IDs to their personal-mailbox status so the members
 * table can show a "Mailbox" column without leaking any mailbox contents.
 *
 * Only the transport discriminator is derived: 'hosted' (an Owlat-hosted
 * mailbox), 'external' (a connected IMAP/SMTP account), or 'none'. Shared team
 * inboxes (scope='shared') are intentionally excluded — this column answers
 * "does this person have their own mailbox", not "which shared inboxes can they
 * reach".
 */

import { v } from 'convex/values';
import { authedQuery } from '../lib/authedFunctions';
import { requireOrgMember } from '../lib/sessionOrganization';
import type { Doc } from '../_generated/dataModel';

export type MemberMailboxStatus = 'hosted' | 'external' | 'none';

// Cap the batch so a caller can never fan a single query into an unbounded
// number of index reads. The team page never renders more members than this.
const MAX_USER_IDS = 200;

/**
 * Derive a single member's mailbox status from their mailbox rows. A hosted
 * mailbox always wins over an external one (it is the Owlat-native identity),
 * and a personal mailbox is required — shared team inboxes never count here.
 * Pure and total so the mapping is unit-testable in isolation.
 */
export function deriveMemberMailboxStatus(mailboxes: Doc<'mailboxes'>[]): MemberMailboxStatus {
	let hasExternal = false;
	for (const mailbox of mailboxes) {
		if (mailbox.status !== 'active') continue;
		// undefined scope ⇒ personal (back-compat for pre-shared-inbox rows).
		if (mailbox.scope === 'shared') continue;
		// undefined kind ⇒ hosted (back-compat for pre-external rows).
		if (mailbox.kind === 'external') {
			hasExternal = true;
			continue;
		}
		return 'hosted';
	}
	return hasExternal ? 'external' : 'none';
}

/**
 * Map each requested BetterAuth user ID to their personal-mailbox status.
 * Returns a plain record keyed by user ID; user IDs with no mailbox resolve to
 * 'none'. Any org member may read this (it is roster metadata, no contents),
 * mirroring the membership floor the team page already sits behind.
 */
export const byMembers = authedQuery({
	args: { userIds: v.array(v.string()) },
	handler: async (ctx, args): Promise<Record<string, MemberMailboxStatus>> => {
		await requireOrgMember(ctx);

		// De-duplicate and bound the batch before touching the DB.
		const uniqueUserIds = [...new Set(args.userIds)].slice(0, MAX_USER_IDS);

		const result: Record<string, MemberMailboxStatus> = {};
		for (const userId of uniqueUserIds) {
			const mailboxes = await ctx.db
				.query('mailboxes')
				.withIndex('by_user', (q) => q.eq('userId', userId))
				.collect();
			result[userId] = deriveMemberMailboxStatus(mailboxes);
		}
		return result;
	},
});
