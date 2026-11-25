/**
 * Seed loader: connected (external, BYO IMAP/SMTP) mailboxes, so the pages
 * that differ for a connected mailbox — forwarding, filters, the account card
 * — have one to show.
 *
 * The mailbox is provisioned the way a connect provisions it
 * (`claimExternalAddress` + `provisionExternalMailbox`, `mail/external/connectMailbox.ts`).
 * The account row is inserted here rather than through
 * `insertExternalAccountRow`, because a real connect stores a sealed
 * credential and starts as `pending` for the mail-sync worker to pick up. The
 * seeded row is `connected` with NO credential envelope and invented hosts on
 * example domains: `dev:stack` does not start mail-sync, and a worker started by
 * hand asks for its credentials, is told `disconnected` (the answer for a row
 * without an envelope, `getCredentialsForWorker`) and halts that account
 * quietly instead of retrying it. Nothing ever dials the fixture hosts.
 *
 * DEV ONLY, like `mailboxes`: the mailbox belongs to a seeded account. Rows
 * carry no `seedTag`; `POST /dev/reset` removes them. Reseeding dedupes on the
 * address.
 */

import type { MutationCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { listMailboxesOnAddress } from '../../mail/mailbox/addressResolution';
import { claimExternalAddress, provisionExternalMailbox } from '../../mail/external/connectMailbox';
import { authUserIdByEmail, singletonOrganizationId } from './mailboxes';
import type { LoadResult, Loader } from './types';

interface ConnectedMailboxFixture {
	slug: string;
	/** Login email of the owning dummy account. */
	owner: string;
	address: string;
	imapHost: string;
	smtpHost: string;
	/** How long before seeding the account last synced. */
	lastSyncMinutesAgo: number;
}

const MINUTE_MS = 60_000;

async function load(ctx: MutationCtx, rawRecords: unknown[]): Promise<LoadResult> {
	const records = rawRecords as ConnectedMailboxFixture[];
	let inserted = 0;
	let skipped = 0;
	const ids: Record<string, Id<'mailboxes'>> = {};
	const now = Date.now();

	const organizationId = await singletonOrganizationId(ctx);
	if (!organizationId) return { inserted: 0, skipped: records.length, ids };

	for (const rec of records) {
		const address = rec.address.trim().toLowerCase();
		const ownerId = await authUserIdByEmail(ctx, rec.owner);
		if (!ownerId) {
			skipped++;
			continue;
		}

		const [existing] = await listMailboxesOnAddress(ctx, address);
		if (existing) {
			ids[rec.slug] = existing._id;
			skipped++;
			continue;
		}

		const claim = await claimExternalAddress(ctx, address);
		const mailboxId = await provisionExternalMailbox(ctx, {
			userId: ownerId,
			organizationId,
			claim,
			displayName: address,
		});
		const lastSyncAt = now - rec.lastSyncMinutesAgo * MINUTE_MS;
		const accountId = await ctx.db.insert('externalMailAccounts', {
			userId: ownerId,
			organizationId,
			mailboxId,
			imapHost: rec.imapHost,
			imapPort: 993,
			isImapSecure: true,
			smtpHost: rec.smtpHost,
			smtpPort: 465,
			isSmtpSecure: true,
			authMethod: 'password',
			imapUsername: address,
			status: 'connected',
			lastConnectedAt: lastSyncAt,
			lastSyncAt,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.patch(mailboxId, { externalAccountId: accountId, updatedAt: now });
		await ctx.db.insert('mailAuditLog', {
			mailboxId,
			event: 'external_account.connected',
			details: `${address} (imap ${rec.imapHost}:993, smtp ${rec.smtpHost}:465)`,
			occurredAt: now,
		});

		ids[rec.slug] = mailboxId;
		inserted++;
	}

	return { inserted, skipped, ids };
}

export const connectedMailboxesLoader: Loader = {
	module: 'connectedMailboxes',
	dependencies: ['accounts', 'mailboxes'],
	load,
};
