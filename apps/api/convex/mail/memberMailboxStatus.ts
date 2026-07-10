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
 * mailbox), 'external' (a connected IMAP/SMTP account still sending through its
 * own server), 'external-instance' (a connected account that took the
 * post-import switch, so it READS externally but SENDS through this instance),
 * or 'none'. Shared team inboxes (scope='shared') are intentionally excluded —
 * this column answers "does this person have their own mailbox", not "which
 * shared inboxes can they reach".
 */

import { v } from 'convex/values';
import { authedQuery } from '../lib/authedFunctions';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import type { Doc } from '../_generated/dataModel';

export type MemberMailboxStatus = 'hosted' | 'external' | 'external-instance' | 'none';

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
	let externalStatus: 'external' | 'external-instance' | null = null;
	for (const mailbox of mailboxes) {
		if (mailbox.status !== 'active') continue;
		// undefined scope ⇒ personal (back-compat for pre-shared-inbox rows).
		if (mailbox.scope === 'shared') continue;
		// undefined kind ⇒ hosted (back-compat for pre-external rows).
		if (mailbox.kind === 'external') {
			// The post-import "switch your sending" flips outbound to this instance
			// while the inbox still syncs externally — surface that so the team
			// column doesn't mislabel it as a plain own-server external mailbox.
			externalStatus = mailbox.outboundPreference === 'instance' ? 'external-instance' : 'external';
			continue;
		}
		return 'hosted';
	}
	return externalStatus ?? 'none';
}

/**
 * Map each requested BetterAuth user ID to their personal-mailbox status.
 * Returns a plain record keyed by user ID; user IDs with no mailbox resolve to
 * 'none'. Any org member may read this (it is roster metadata, no contents),
 * mirroring the membership floor the team page already sits behind.
 */
// all-members: member-visible roster metadata (mailbox transport discriminator
// only, no mailbox contents); authedQuery already floors on requireOrgMember.
export const byMembers = authedQuery({
	args: { userIds: v.array(v.string()) },
	handler: async (ctx, args): Promise<Record<string, MemberMailboxStatus>> => {
		// authedQuery already enforced the org-member floor; re-read the session
		// only to scope the fetched rows to the caller's active organization so
		// this read can never reflect cross-org mailboxes (single-org today, but
		// the invariant shouldn't rest on this one query).
		const session = await getBetterAuthSessionWithRole(ctx);
		const organizationId = session?.activeOrganizationId ?? null;

		// De-duplicate and bound the batch before touching the DB.
		const uniqueUserIds = [...new Set(args.userIds)].slice(0, MAX_USER_IDS);

		// Fan the per-user index reads out concurrently rather than awaiting each
		// in series (up to MAX_USER_IDS round trips otherwise).
		const statuses = await Promise.all(
			uniqueUserIds.map(async (userId) => {
				const mailboxes = await ctx.db
					.query('mailboxes')
					.withIndex('by_user', (q) => q.eq('userId', userId))
					.collect();
				// bounded: a single user owns a handful of mailbox rows.
				const ownRows =
					organizationId === null
						? mailboxes
						: mailboxes.filter((m) => m.organizationId === organizationId);
				return [userId, deriveMemberMailboxStatus(ownRows)] as const;
			})
		);

		return Object.fromEntries(statuses);
	},
});
