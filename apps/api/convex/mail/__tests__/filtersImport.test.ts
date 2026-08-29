/**
 * Gmail filter import (idea 50) — the write half.
 *
 * The client translates Gmail's XML; this pins what the mutation does with the
 * result: names resolve to labels and folders in ONE transaction (creating the
 * missing labels), a re-import of the same file creates nothing twice, and a
 * mailbox missing a destination folder loses that action rather than the filter.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import { modules, seedMailbox, seedFolder } from './helpers.testlib';

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

const STRIPE_FILTER = {
	name: 'from: billing@stripe.com',
	conditions: [{ field: 'from' as const, op: 'contains' as const, value: 'billing@stripe.com' }],
	actions: [
		{ type: 'addLabel' as const, labelName: 'Money/Receipts' },
		{ type: 'moveToFolder' as const, folderRole: 'archive' as const },
		{ type: 'markRead' as const },
	],
};

async function seedMailboxWithFolders(t: TestConvex<typeof schema>): Promise<Id<'mailboxes'>> {
	const mailboxId = await seedMailbox(t);
	for (const role of ['inbox', 'archive', 'trash'] as const) await seedFolder(t, mailboxId, role);
	return mailboxId;
}

async function filtersIn(t: TestConvex<typeof schema>, mailboxId: Id<'mailboxes'>) {
	return await t.run(async (ctx) =>
		ctx.db
			.query('mailFilters')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
			.collect()
	);
}

describe('importGmailFilters', () => {
	it('resolves label paths and folder roles in one transaction', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailboxWithFolders(t);

		const result = await t.mutation(api.mail.filtersImport.importGmailFilters, {
			mailboxId,
			filters: [STRIPE_FILTER],
		});

		expect(result).toEqual({ created: 1, skipped: 0, labelsCreated: 2 });
		const [filter] = await filtersIn(t, mailboxId);
		expect(filter?.actions.map((action) => action.type)).toEqual([
			'addLabel',
			'moveToFolder',
			'markRead',
		]);
		await t.run(async (ctx) => {
			const labelId = filter?.actions[0]?.labelId;
			expect(labelId).toBeDefined();
			// `Money/Receipts` is a path: the leaf is the label the filter applies.
			expect(labelId ? (await ctx.db.get(labelId))?.name : null).toBe('Receipts');
			const folderId = filter?.actions[1]?.folderId;
			expect(folderId ? (await ctx.db.get(folderId))?.role : null).toBe('archive');
		});
	});

	it('reuses a label that already exists instead of duplicating it', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailboxWithFolders(t);
		await t.mutation(api.mail.labels.create, { mailboxId, name: 'Money/Receipts' });

		const result = await t.mutation(api.mail.filtersImport.importGmailFilters, {
			mailboxId,
			filters: [STRIPE_FILTER],
		});

		expect(result.labelsCreated).toBe(0);
		const labels = await t.run(async (ctx) =>
			ctx.db
				.query('mailLabels')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
				.collect()
		);
		expect(labels).toHaveLength(2);
	});

	it('creates nothing twice when the same export is imported again', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailboxWithFolders(t);
		await t.mutation(api.mail.filtersImport.importGmailFilters, {
			mailboxId,
			filters: [STRIPE_FILTER],
		});

		const second = await t.mutation(api.mail.filtersImport.importGmailFilters, {
			mailboxId,
			filters: [STRIPE_FILTER],
		});

		expect(second).toEqual({ created: 0, skipped: 1, labelsCreated: 0 });
		expect(await filtersIn(t, mailboxId)).toHaveLength(1);
	});

	it('drops an action whose folder is missing, not the whole filter', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId, 'inbox');

		const result = await t.mutation(api.mail.filtersImport.importGmailFilters, {
			mailboxId,
			filters: [STRIPE_FILTER],
		});

		expect(result.created).toBe(1);
		const [filter] = await filtersIn(t, mailboxId);
		expect(filter?.actions.map((action) => action.type)).toEqual(['addLabel', 'markRead']);
	});

	it('skips a filter left with no usable action at all', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId, 'inbox');

		const result = await t.mutation(api.mail.filtersImport.importGmailFilters, {
			mailboxId,
			filters: [
				{
					name: 'orphan',
					conditions: [{ field: 'from', op: 'contains', value: 'a@b.io' }],
					actions: [{ type: 'moveToFolder', folderRole: 'trash' }],
				},
			],
		});

		expect(result).toEqual({ created: 0, skipped: 1, labelsCreated: 0 });
		expect(await filtersIn(t, mailboxId)).toHaveLength(0);
	});

	it('appends after the mailbox existing filters rather than reordering them', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailboxWithFolders(t);
		const labelId = await t.mutation(api.mail.labels.create, { mailboxId, name: 'Existing' });
		await t.mutation(api.mail.filters.create, {
			mailboxId,
			name: 'mine',
			conditions: [{ field: 'from', op: 'contains', value: 'me@x.io' }],
			actions: [{ type: 'addLabel', labelId }],
		});

		await t.mutation(api.mail.filtersImport.importGmailFilters, {
			mailboxId,
			filters: [STRIPE_FILTER],
		});

		const filters = await filtersIn(t, mailboxId);
		const mine = filters.find((filter) => filter.name === 'mine');
		const imported = filters.find((filter) => filter.name === STRIPE_FILTER.name);
		expect(mine && imported && imported.priority > mine.priority).toBe(true);
	});

	it('refuses a mailbox the caller does not own', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailboxWithFolders(t);
		sessionMocks.userId = 'user-B';
		sessionMocks.role = 'editor';

		await expect(
			t.mutation(api.mail.filtersImport.importGmailFilters, {
				mailboxId,
				filters: [STRIPE_FILTER],
			})
		).rejects.toThrow();
		expect(await filtersIn(t, mailboxId)).toHaveLength(0);
	});
});
