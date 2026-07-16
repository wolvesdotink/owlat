/**
 * External account connected AS A SHARED TEAM INBOX (issue #234) — the
 * external-transport twin of `mailboxMembers.createShared`.
 *
 * Split out of `externalAccounts.ts` (kept under the ~500 LOC cap): the personal
 * BYO-mailbox lifecycle there is per-user 1:1, whereas this path provisions a
 * `kind='external', scope='shared'` mailbox governed by `mailboxMembers`. It
 * reuses that file's `connectFieldsValidator` (the encrypted-envelope shape the
 * connect action hands over) and the shared provisioning helpers, so the two
 * connect paths never drift on address normalization or credential storage.
 *
 * Ownership / credential model (see the `scope` field on `externalMailAccounts`):
 *   - The connecting admin becomes the mailbox's canonical owner
 *     (`provisionMailbox` inserts the owner `mailboxMembers` row); initial
 *     `memberUserIds` are seeded as members. Access is transport-agnostic —
 *     `requireMailboxAccess` never inspects `kind`.
 *   - The credentials live on ONE `externalMailAccounts` row (encrypted at rest,
 *     decrypted only by the mail-sync worker) 1:1 with the mailbox, carrying
 *     `scope='shared'`. That discriminator excludes the account from the per-user
 *     "one live personal external account" limit and from the personal-external
 *     surfaces (getForCurrentUser / disconnect / purge / the move flow). `userId`
 *     records the connecting admin (credential custodian + audit); the org owns it.
 *
 *   Internal: _connectSharedInternal (called by
 *             externalAccountsActions.connectShared after encryption).
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { getBetterAuthSessionWithRole, requireAdminContext } from '../lib/sessionOrganization';
import { provisionMailbox, canonicalAddress, resolveDeliverableMailbox } from './mailbox';
import { connectFieldsValidator } from './externalAccounts';
import { assertOrgMemberUser } from './mailboxMembers';
import { throwForbidden, throwInvalidInput, throwAlreadyExists } from '../_utils/errors';

/**
 * Provision a shared external mailbox + its credential account + initial roster
 * in one motion. Admin-gated (a team inbox is org infrastructure, mirroring
 * `mailboxMembers.createShared`). Re-resolves the session propagated from the
 * calling action; the action has already encrypted the credentials.
 *
 * Unlike the personal `_connectInternal` there is NO one-live-per-user guard (a
 * user may own many shared inboxes) and NO `mailboxReady` onboarding stamp (a
 * team inbox is not the admin's personal mailbox).
 */
export const _connectSharedInternal = internalMutation({
	args: {
		...connectFieldsValidator,
		displayName: v.optional(v.string()),
		memberUserIds: v.array(v.string()),
	},
	handler: async (ctx, args) => {
		await requireAdminContext(ctx);
		const s = await getBetterAuthSessionWithRole(ctx);
		if (!s || !s.activeOrganizationId || !s.role) throwForbidden('Not authenticated');
		const address = canonicalAddress(args.emailAddress);
		const [, domain] = address.split('@');
		if (!domain) throwInvalidInput('Invalid email address');

		// Validate every initial member (deduped, creator excluded) up front, so a
		// bogus id fails the whole connect rather than seeding a dangling row.
		const memberIds = [...new Set(args.memberUserIds)].filter((id) => id !== s.userId);
		for (const memberUserId of memberIds) {
			await assertOrgMemberUser(ctx, memberUserId);
		}

		// The address must not collide with any existing active mailbox (hosted or
		// external) — resolve deterministically rather than trusting the oldest row.
		const existingMailbox = await resolveDeliverableMailbox(ctx, address);
		if (existingMailbox) {
			throwAlreadyExists(`A mailbox for ${address} already exists.`);
		}

		const now = Date.now();
		const mailboxId = await provisionMailbox(ctx, {
			userId: s.userId,
			organizationId: s.activeOrganizationId,
			address,
			domain,
			displayName: args.displayName ?? args.emailAddress,
			kind: 'external',
			scope: 'shared',
		});
		const accountId = await ctx.db.insert('externalMailAccounts', {
			userId: s.userId,
			organizationId: s.activeOrganizationId,
			mailboxId,
			scope: 'shared',
			imapHost: args.imapHost,
			imapPort: args.imapPort,
			isImapSecure: args.isImapSecure,
			smtpHost: args.smtpHost,
			smtpPort: args.smtpPort,
			isSmtpSecure: args.isSmtpSecure,
			authMethod: args.authMethod,
			imapUsername: args.imapUsername,
			smtpUsername: args.smtpUsername,
			secretCiphertext: args.secretCiphertext,
			secretIv: args.secretIv,
			secretAuthTag: args.secretAuthTag,
			secretEnvelopeVersion: args.secretEnvelopeVersion,
			status: 'pending',
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.patch(mailboxId, { externalAccountId: accountId, updatedAt: now });
		// Seed the initial roster (the owner membership was inserted by provisionMailbox).
		for (const memberUserId of memberIds) {
			await ctx.db.insert('mailboxMembers', {
				mailboxId,
				authUserId: memberUserId,
				role: 'member',
				addedBy: s.userId,
				createdAt: now,
			});
		}
		await ctx.db.insert('mailAuditLog', {
			mailboxId,
			event: 'external_account.connected',
			details: `shared ${address} (imap ${args.imapHost}:${args.imapPort}, smtp ${args.smtpHost}:${args.smtpPort})`,
			occurredAt: now,
		});
		return { mailboxId, externalAccountId: accountId };
	},
});
