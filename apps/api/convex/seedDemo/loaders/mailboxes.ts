/**
 * Seed loader: mailboxes — a hosted mailbox for every dummy account plus one
 * shared team inbox on the seeded demo domain. Without these, every seeded
 * teammate lands on the "No mailbox yet" empty state until an admin manually
 * provisions one — the Postbox should work out of the box in dev.
 *
 * Provisions through `provisionMailbox` (mail/mailbox.ts) — the exact body
 * behind the admin create path — so system folders and the implicit owner
 * membership can never drift from production provisioning. The scheduled MTA
 * cache push fail-softs in dev (MTA_API_URL unset → pushMailboxToCache logs
 * and skips).
 *
 * Like `accounts`: NOT wiped by `?reset=true` — `mailboxes` rows carry no
 * `seedTag` (they are ordinary tenant rows, wiped by `POST /dev/reset` and the
 * org-deletion walker). Reseeding dedupes on the canonical address instead.
 */

import type { MutationCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { components } from '../../_generated/api';
import { provisionMailbox } from '../../mail/mailbox';
import type { LoadResult, Loader } from './types';

interface MailboxFixture {
	slug: string;
	/** Login email of the owning dummy account (resolved to its BetterAuth id). */
	owner: string;
	address: string;
	displayName: string;
	/** undefined ⇒ 'personal'. */
	scope?: 'shared';
	/** Login emails granted explicit membership (shared inboxes only). */
	members?: string[];
}

type AdapterArgs = Parameters<MutationCtx['runQuery']>[1];

/** BetterAuth user id (`_id`) for a login email, or null when not seeded. */
async function authUserIdByEmail(ctx: MutationCtx, email: string): Promise<string | null> {
	const result = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
		model: 'user',
		where: [{ field: 'email', value: email }],
		paginationOpts: { cursor: null, numItems: 1 },
	} as unknown as AdapterArgs)) as { page?: Array<{ _id: string }> } | null;
	const user = result?.page?.[0];
	return user ? String(user._id) : null;
}

async function load(ctx: MutationCtx, rawRecords: unknown[]): Promise<LoadResult> {
	const records = rawRecords as MailboxFixture[];
	let inserted = 0;
	let skipped = 0;
	const ids: Record<string, Id<'mailboxes'>> = {};
	const now = Date.now();

	// Mailboxes are tenant rows — without the singleton org there is nothing to
	// attach them to (mirrors the accounts loader's guard).
	const orgResult = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
		model: 'organization',
		where: [],
		paginationOpts: { cursor: null, numItems: 1 },
	} as unknown as AdapterArgs)) as { page?: Array<{ id?: string; _id?: string }> } | null;
	const org = orgResult?.page?.[0];
	const organizationId = org ? String(org.id ?? org._id) : null;
	if (!organizationId) {
		return { inserted: 0, skipped: records.length, ids };
	}

	for (const rec of records) {
		const address = rec.address.trim().toLowerCase();
		const domain = address.split('@')[1];
		if (!domain) {
			skipped++;
			continue;
		}

		// Owner must exist (admin from /seed/admin, teammates from the accounts
		// loader). A missing owner means a partial bootstrap — skip, don't throw.
		const ownerId = await authUserIdByEmail(ctx, rec.owner);
		if (!ownerId) {
			skipped++;
			continue;
		}

		const existing = await ctx.db
			.query('mailboxes')
			.withIndex('by_address', (q) => q.eq('address', address))
			.first();
		if (existing) {
			ids[rec.slug] = existing._id;
			skipped++;
			continue;
		}

		const mailboxId = await provisionMailbox(ctx, {
			userId: ownerId,
			organizationId,
			address,
			domain,
			displayName: rec.displayName,
			scope: rec.scope,
		});

		// Shared inbox: explicit member rows on top of the implicit owner row
		// provisionMailbox already inserted (mirrors mailboxMembers.createShared).
		for (const memberEmail of rec.members ?? []) {
			const memberId = await authUserIdByEmail(ctx, memberEmail);
			if (!memberId || memberId === ownerId) continue;
			await ctx.db.insert('mailboxMembers', {
				mailboxId,
				authUserId: memberId,
				role: 'member',
				addedBy: ownerId,
				createdAt: now,
			});
		}

		ids[rec.slug] = mailboxId;
		inserted++;
	}

	return { inserted, skipped, ids };
}

export const mailboxesLoader: Loader = {
	module: 'mailboxes',
	dependencies: ['accounts', 'domains'],
	load,
};
