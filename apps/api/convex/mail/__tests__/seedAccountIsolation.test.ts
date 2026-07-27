/**
 * A deliverability SEED mailbox is org infrastructure, not a user inbox.
 *
 * Two regressions live here, both found in review:
 *
 *   1. `listConnectableAccounts` is what the mail-sync AccountManager reconciles
 *      against. A seed leaking into it makes the worker open an IMAP IDLE
 *      connection to the operator's personal consumer mailbox and ingest its
 *      whole contents into Convex as an ordinary Postbox mailbox — flatly
 *      contradicting "its mail is never indexed", re-ingesting every shadow copy
 *      as inbound mail, and racing the prober's sweep on `\Seen`.
 *   2. Connecting a seed makes every campaign the org sends deliver a full copy
 *      into a mailbox the connecting member controls. That is an ADMIN action,
 *      exactly as connecting a shared team inbox is.
 *   3. A seed's `mailboxes` row has to name an owning `userId` (there is no
 *      other), so without the `scope='seed'` discriminator the operator's own
 *      consumer address shows up in THEIR Postbox as a mailbox that never
 *      syncs — and an admin who connects a seed before having a mailbox is read
 *      by `getActiveMailboxForUser` as already having one, silently changing
 *      the shipped fresh-start flow.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { modules } from './helpers.testlib';
import { loadAccessibleMailboxes } from '../permissions';
import { getActiveMailboxForUser } from '../mailbox';
import { SEED_ACCOUNTS_PER_ORG_LIMIT } from '@owlat/shared/seedPlacement';
import type { DatabaseWriter } from '../../_generated/server';
import { loadSeedAccounts } from '../../analytics/seedPlacement';

const sessionMock = vi.hoisted(() => ({
	userId: 'admin-user',
	role: 'admin' as 'owner' | 'admin' | 'editor' | null,
	orgId: 'org-1',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		getMutationContext: vi.fn(async () => {
			if (sessionMock.role === null) throw new Error('Not authenticated');
			return {
				userId: sessionMock.userId,
				role: sessionMock.role,
				activeOrganizationId: sessionMock.orgId,
			};
		}),
		requireAdminContext: vi.fn(async () => {
			if (sessionMock.role !== 'owner' && sessionMock.role !== 'admin') {
				throw new Error('Only owners and admins can perform this action');
			}
			return {
				userId: sessionMock.userId,
				role: sessionMock.role,
				activeOrganizationId: sessionMock.orgId,
			};
		}),
		getBetterAuthSessionWithRole: vi.fn(async () => {
			if (sessionMock.role === null) return null;
			return {
				userId: sessionMock.userId,
				role: sessionMock.role,
				activeOrganizationId: sessionMock.orgId,
			};
		}),
	};
});

function setSession(role: 'owner' | 'admin' | 'editor' | null): void {
	sessionMock.role = role;
}

const CREDS = {
	imapHost: 'imap.gmail.example',
	imapPort: 993,
	isImapSecure: true,
	smtpHost: 'smtp.gmail.example',
	smtpPort: 587,
	isSmtpSecure: false,
	imapUsername: 'seed-login',
	authMethod: 'password' as const,
	secretCiphertext: 'ct',
	secretIv: 'iv',
	secretAuthTag: 'tag',
	secretEnvelopeVersion: 1,
};

async function connectSeed(t: TestConvex<typeof schema>, emailAddress: string): Promise<void> {
	await t.mutation(internal.mail.externalAccountsSeed._connectSeedInternal, {
		...CREDS,
		emailAddress,
		seedProvider: 'gmail',
	});
}

describe('the seed connect path has an admin floor', () => {
	it('refuses an ordinary member', async () => {
		const t = convexTest(schema, modules);
		setSession('editor');
		await expect(connectSeed(t, 'owlat.seed.01@gmail.example')).rejects.toThrow(
			/owners and admins/
		);
		const rows = await t.run(async (ctx) => ctx.db.query('externalMailAccounts').collect());
		expect(rows).toEqual([]);
	});

	it('refuses an unauthenticated caller', async () => {
		const t = convexTest(schema, modules);
		setSession(null);
		await expect(connectSeed(t, 'owlat.seed.01@gmail.example')).rejects.toThrow();
	});

	it('allows an admin, and tags the row as a seed', async () => {
		const t = convexTest(schema, modules);
		setSession('admin');
		await connectSeed(t, 'owlat.seed.01@gmail.example');
		const rows = await t.run(async (ctx) => ctx.db.query('externalMailAccounts').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]?.purpose).toBe('seed');
		expect(rows[0]?.seedProvider).toBe('gmail');
	});
});

describe('a seed mailbox is never handed to the inbound sync worker', () => {
	it('is excluded from listConnectableAccounts while ordinary accounts are not', async () => {
		const t = convexTest(schema, modules);
		setSession('admin');
		await connectSeed(t, 'owlat.seed.01@gmail.example');

		// A perfectly ordinary BYO account in the same deployment, in the same
		// `pending` status a freshly-connected seed has.
		const ordinaryId = await t.run(async (ctx) => {
			const mailboxId = await ctx.db.insert('mailboxes', {
				userId: 'user-2',
				organizationId: 'org-1',
				address: 'real@user.example',
				domain: 'user.example',
				kind: 'external' as const,
				status: 'active' as const,
				usedBytes: 0,
				uidValidity: 1,
				createdAt: 1,
				updatedAt: 1,
			});
			return ctx.db.insert('externalMailAccounts', {
				userId: 'user-2',
				organizationId: 'org-1',
				mailboxId,
				imapHost: 'imap.user.example',
				imapPort: 993,
				isImapSecure: true,
				imapUsername: 'real',
				smtpHost: 'smtp.user.example',
				smtpPort: 587,
				isSmtpSecure: false,
				smtpUsername: 'real',
				authMethod: 'password' as const,
				secretCiphertext: 'ct',
				secretIv: 'iv',
				secretAuthTag: 'tag',
				secretEnvelopeVersion: 1,
				status: 'pending' as const,
				createdAt: 1,
				updatedAt: 1,
			});
		});

		const connectable = await t.query(internal.mail.externalAccounts.listConnectableAccounts, {});
		expect(connectable.map((a) => a.accountId)).toEqual([ordinaryId]);
	});
});

describe('a seed mailbox is never the connecting admin’s own inbox', () => {
	it('is absent from loadAccessibleMailboxes', async () => {
		const t = convexTest(schema, modules);
		setSession('admin');
		await connectSeed(t, 'owlat.seed.01@gmail.example');

		const visible = await t.run(async (ctx) => loadAccessibleMailboxes(ctx, 'admin-user', 'org-1'));
		expect(visible).toEqual([]);
	});

	it('does not make an admin without a mailbox look like they already have one', async () => {
		const t = convexTest(schema, modules);
		setSession('admin');
		await connectSeed(t, 'owlat.seed.01@gmail.example');

		const active = await t.run(async (ctx) => getActiveMailboxForUser(ctx, 'admin-user'));
		expect(active).toBeNull();
	});

	it('still surfaces the admin’s REAL mailbox alongside a connected seed', async () => {
		const t = convexTest(schema, modules);
		setSession('admin');
		const realMailboxId = await t.run(async (ctx) => {
			const mailboxId = await ctx.db.insert('mailboxes', {
				userId: 'admin-user',
				organizationId: 'org-1',
				address: 'admin@owlat.example',
				domain: 'owlat.example',
				kind: 'hosted' as const,
				status: 'active' as const,
				usedBytes: 0,
				uidValidity: 1,
				createdAt: 1,
				updatedAt: 1,
			});
			await ctx.db.insert('mailboxMembers', {
				mailboxId,
				authUserId: 'admin-user',
				role: 'owner' as const,
				addedBy: 'admin-user',
				createdAt: 1,
			});
			return mailboxId;
		});
		await connectSeed(t, 'owlat.seed.01@gmail.example');

		const visible = await t.run(async (ctx) => loadAccessibleMailboxes(ctx, 'admin-user', 'org-1'));
		expect(visible.map((m) => m._id)).toEqual([realMailboxId]);
		const active = await t.run(async (ctx) => getActiveMailboxForUser(ctx, 'admin-user'));
		expect(active?._id).toBe(realMailboxId);
	});

	it('tags the provisioned mailbox row with scope=seed', async () => {
		const t = convexTest(schema, modules);
		setSession('admin');
		await connectSeed(t, 'owlat.seed.01@gmail.example');
		const mailboxes = await t.run(async (ctx) => ctx.db.query('mailboxes').collect());
		expect(mailboxes).toHaveLength(1);
		expect(mailboxes[0]?.scope).toBe('seed');
	});
});

/** Insert one seed row (mailbox + account) directly, bypassing the connect guard. */
async function insertSeedRow(
	ctx: { db: DatabaseWriter },
	options: { label: string; status: 'pending' | 'disconnected'; createdAt: number }
): Promise<void> {
	const address = `owlat.seed.${options.label}@gmail.example`;
	const retired = options.status === 'disconnected';
	const mailboxId = await ctx.db.insert('mailboxes', {
		userId: 'admin-user',
		organizationId: 'org-1',
		address,
		domain: 'gmail.example',
		kind: 'external' as const,
		scope: 'seed' as const,
		// A disconnected account's mailbox is soft-deleted by `mail/mailbox.ts`.
		status: retired ? ('deleted' as const) : ('active' as const),
		usedBytes: 0,
		uidValidity: 1,
		createdAt: options.createdAt,
		updatedAt: options.createdAt,
	});
	await ctx.db.insert('externalMailAccounts', {
		userId: 'admin-user',
		organizationId: 'org-1',
		mailboxId,
		purpose: 'seed' as const,
		seedProvider: 'gmail' as const,
		...CREDS,
		status: options.status,
		createdAt: options.createdAt,
		updatedAt: options.createdAt,
	});
}

describe('the seed set is bounded at connect time, never silently truncated', () => {
	it('refuses the seed past the per-organization limit', async () => {
		const t = convexTest(schema, modules);
		setSession('admin');
		// Fill the ledger straight to the cap; the cap itself lives in
		// @owlat/shared so the connect guard and the read page cannot disagree.
		await t.run(async (ctx) => {
			for (let i = 0; i < SEED_ACCOUNTS_PER_ORG_LIMIT; i += 1) {
				await insertSeedRow(ctx, { label: `filler.${i}`, status: 'pending', createdAt: 1 });
			}
		});

		await expect(connectSeed(t, 'owlat.seed.overflow@gmail.example')).rejects.toThrow(/maximum/);
	});

	// REGRESSION (review round 4). Disconnecting is a SOFT status change — the
	// row stays. When the guard and the roll-up took a bounded page and filtered
	// `status !== 'disconnected'` AFTERWARDS, retired rows ate slots: the cap
	// read short and stopped refusing forever, and live seeds fell off the read
	// page. Both now select the live statuses THROUGH the index.
	it('counts and reads every LIVE seed even when the org has retired seeds', async () => {
		const t = convexTest(schema, modules);
		setSession('admin');
		await t.run(async (ctx) => {
			// The retired rows sort FIRST, so a bounded page would hand them out.
			await insertSeedRow(ctx, { label: 'retired.0', status: 'disconnected', createdAt: 1 });
			await insertSeedRow(ctx, { label: 'retired.1', status: 'disconnected', createdAt: 2 });
			for (let i = 0; i < SEED_ACCOUNTS_PER_ORG_LIMIT; i += 1) {
				await insertSeedRow(ctx, { label: `live.${i}`, status: 'pending', createdAt: 10 + i });
			}
		});

		// The cap still holds: 50 LIVE seeds is the maximum, disconnected or not.
		await expect(connectSeed(t, 'owlat.seed.overflow@gmail.example')).rejects.toThrow(/maximum/);

		// And every live seed is still measured — none is displaced by a retired row.
		const measured = await t.run(async (ctx) =>
			loadSeedAccounts(ctx.db, 'org-1', Date.parse('2026-01-01T00:00:00Z'))
		);
		expect(measured).toHaveLength(SEED_ACCOUNTS_PER_ORG_LIMIT);
		expect(new Set(measured.map((view) => view.address)).size).toBe(SEED_ACCOUNTS_PER_ORG_LIMIT);
		expect(measured.every((view) => view.address.includes('live.'))).toBe(true);
	});
});
