/**
 * Trash auto-purge (idea 67).
 *
 * The dangerous properties are the ones about NOT deleting: an untouched user
 * keeps every trashed message forever, a message whose time in the bin is
 * unknown is never destroyed on a guess, and one member's personal horizon
 * never empties a shared team inbox.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api, internal } from '../../_generated/api';
import { modules, seedMailbox, seedFolder, seedMessage } from './helpers.testlib';

const sessionMocks = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'owner' as 'owner' | 'admin' | 'editor',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
		})),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
		})),
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
			activeOrganizationId: 'org-1',
		})),
	};
});

beforeEach(() => {
	sessionMocks.userId = 'user-A';
	sessionMocks.role = 'owner';
});

const DAY = 24 * 60 * 60 * 1000;

async function seedTrashedMailbox(
	t: TestConvex<typeof schema>,
	seed: { userId?: string; scope?: 'personal' | 'shared' } = {}
): Promise<Id<'mailboxes'>> {
	const mailboxId = await seedMailbox(t, {
		userId: seed.userId ?? 'user-A',
		...(seed.scope ? { scope: seed.scope } : {}),
		address: `${seed.userId ?? 'user-A'}-${seed.scope ?? 'personal'}@hinterland.camp`,
	});
	await seedFolder(t, mailboxId, 'inbox');
	await seedFolder(t, mailboxId, 'trash');
	return mailboxId;
}

/** Put a message straight into the bin with a chosen "trashed at" stamp. */
async function seedTrashed(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>,
	subject: string,
	trashedAt: number | undefined
): Promise<Id<'mailMessages'>> {
	const messageId = await seedMessage(t, mailboxId, { subject, role: 'trash' });
	if (trashedAt !== undefined) {
		await t.run(async (ctx) => {
			await ctx.db.patch(messageId, { trashedAt });
		});
	}
	return messageId;
}

async function setHorizon(
	t: TestConvex<typeof schema>,
	userId: string,
	trashAutoPurgeDays: 0 | 7 | 30 | 90
): Promise<void> {
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('mailUserSettings', {
			userId,
			autoAdvance: 'next',
			trashAutoPurgeDays,
			createdAt: now,
			updatedAt: now,
		});
	});
}

async function remainingSubjects(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>
): Promise<string[]> {
	return await t.run(async (ctx) => {
		const rows = await ctx.db
			.query('mailMessages')
			.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', mailboxId))
			.collect();
		return rows.map((row) => row.subject).sort();
	});
}

describe('trash auto-purge sweep', () => {
	it('deletes only what has been in the bin longer than the horizon', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedTrashedMailbox(t);
		await setHorizon(t, 'user-A', 30);
		await seedTrashed(t, mailboxId, 'old', Date.now() - 40 * DAY);
		await seedTrashed(t, mailboxId, 'recent', Date.now() - 3 * DAY);

		await t.mutation(internal.mail.trashRetention.sweepExpiredTrash, {});

		expect(await remainingSubjects(t, mailboxId)).toEqual(['recent']);
	});

	it('keeps mail whose time in the bin was never recorded', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedTrashedMailbox(t);
		await setHorizon(t, 'user-A', 7);
		// Trashed long before `trashedAt` existed: old by arrival, undateable by
		// the only measure that matters.
		await seedTrashed(t, mailboxId, 'unstamped', undefined);

		await t.mutation(internal.mail.trashRetention.sweepExpiredTrash, {});

		expect(await remainingSubjects(t, mailboxId)).toEqual(['unstamped']);
	});

	it('does nothing for a user who never chose a horizon', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedTrashedMailbox(t);
		await seedTrashed(t, mailboxId, 'ancient', Date.now() - 1000 * DAY);

		await t.mutation(internal.mail.trashRetention.sweepExpiredTrash, {});

		expect(await remainingSubjects(t, mailboxId)).toEqual(['ancient']);
	});

	it('treats an explicit Never the same as no setting at all', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedTrashedMailbox(t);
		await setHorizon(t, 'user-A', 0);
		await seedTrashed(t, mailboxId, 'ancient', Date.now() - 1000 * DAY);

		await t.mutation(internal.mail.trashRetention.sweepExpiredTrash, {});

		expect(await remainingSubjects(t, mailboxId)).toEqual(['ancient']);
	});

	it('never empties a shared team inbox on one member preference', async () => {
		const t = convexTest(schema, modules);
		const personal = await seedTrashedMailbox(t);
		const shared = await seedTrashedMailbox(t, { scope: 'shared' });
		await setHorizon(t, 'user-A', 7);
		await seedTrashed(t, personal, 'mine', Date.now() - 30 * DAY);
		await seedTrashed(t, shared, 'ours', Date.now() - 30 * DAY);

		await t.mutation(internal.mail.trashRetention.sweepExpiredTrash, {});

		expect(await remainingSubjects(t, personal)).toEqual([]);
		expect(await remainingSubjects(t, shared)).toEqual(['ours']);
	});

	it('frees the folder counters and the mailbox bytes it deletes', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedTrashedMailbox(t);
		await setHorizon(t, 'user-A', 7);
		await seedTrashed(t, mailboxId, 'old', Date.now() - 30 * DAY);
		await t.run(async (ctx) => {
			const trash = await ctx.db
				.query('mailFolders')
				.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mailboxId).eq('role', 'trash'))
				.first();
			if (trash) await ctx.db.patch(trash._id, { totalCount: 1, unseenCount: 1 });
			await ctx.db.patch(mailboxId, { usedBytes: 3 });
		});

		await t.mutation(internal.mail.trashRetention.sweepExpiredTrash, {});

		await t.run(async (ctx) => {
			const trash = await ctx.db
				.query('mailFolders')
				.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mailboxId).eq('role', 'trash'))
				.first();
			expect(trash?.totalCount).toBe(0);
			expect(trash?.unseenCount).toBe(0);
			expect((await ctx.db.get(mailboxId))?.usedBytes).toBe(0);
		});
	});
});

describe('trashedAt stamping', () => {
	it('records entry into the bin on trash and clears it on the way out', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedTrashedMailbox(t);
		await seedFolder(t, mailboxId, 'archive');
		const messageId = await seedMessage(t, mailboxId, { subject: 'triage me' });

		await t.mutation(api.mail.messageActions.trash, { messageIds: [messageId] });
		const trashedAt = await t.run(async (ctx) => (await ctx.db.get(messageId))?.trashedAt);
		expect(typeof trashedAt).toBe('number');

		await t.mutation(api.mail.messageActions.archive, { messageIds: [messageId] });
		// `t.run` marshals an absent field as null, so ask for the presence.
		const stillStamped = await t.run(
			async (ctx) => (await ctx.db.get(messageId))?.trashedAt !== undefined
		);
		expect(stillStamped).toBe(false);
	});
});

describe('mail settings', () => {
	it('round-trips the horizon and leaves it absent until it is set', async () => {
		const t = convexTest(schema, modules);
		expect(await t.query(api.mail.settings.get, {})).toBeNull();

		await t.mutation(api.mail.settings.update, { trashAutoPurgeDays: 30 });
		expect((await t.query(api.mail.settings.get, {}))?.trashAutoPurgeDays).toBe(30);

		// Patching another preference must not clear it.
		await t.mutation(api.mail.settings.update, { density: 'compact' });
		expect((await t.query(api.mail.settings.get, {}))?.trashAutoPurgeDays).toBe(30);
	});
});
