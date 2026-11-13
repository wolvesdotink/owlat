/**
 * Nested labels (idea 38) — path creation, reparenting, ordering, pinning, the
 * unread tally and what happens to a branch when its middle is deleted.
 *
 * The properties worth pinning are the ones a flat wall of labels cannot
 * have: two branches may hold the same leaf name, a reparent may
 * never close a cycle, and deleting a branch promotes its children instead of
 * quietly destroying them. The last block pins how a label toggle re-derives
 * the thread's label, and that every label write keeps the label rows exact.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import { modules, seedMailbox, seedFolder, seedMessage } from './helpers.testlib';
import type { MutationCtx } from '../../_generated/server';
import { toggleOnMessage } from '../labels';
import { tableCountingDb, type QueriedDocuments } from '../../__tests__/indexRecorder.testlib';
import { labelRowsOf, readyLabelRows } from '../../__tests__/labelRows.testlib';

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

async function byName(t: TestConvex<typeof schema>, mailboxId: Id<'mailboxes'>) {
	const list = await t.query(api.mail.labels.list, { mailboxId });
	return new Map(list.map((row) => [row.name, row]));
}

describe('mail.labels.create with a path', () => {
	it('creates every missing ancestor and returns the leaf', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);

		const acme = await t.mutation(api.mail.labels.create, {
			mailboxId,
			name: 'Work/Clients/Acme',
			color: '#ff8800',
		});

		const labels = await byName(t, mailboxId);
		expect([...labels.keys()].sort()).toEqual(['Acme', 'Clients', 'Work']);
		expect(labels.get('Acme')?._id).toBe(acme);
		expect(labels.get('Work')?.parentId).toBeUndefined();
		expect(labels.get('Clients')?.parentId).toBe(labels.get('Work')?._id);
		expect(labels.get('Acme')?.parentId).toBe(labels.get('Clients')?._id);
		// Only the leaf is the label the user picked a colour for; the ancestors
		// are scaffolding created on the way down.
		expect(labels.get('Acme')?.color).toBe('#ff8800');
		expect(labels.get('Work')?.color).toBeUndefined();
	});

	it('reuses existing ancestors rather than duplicating them', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await t.mutation(api.mail.labels.create, { mailboxId, name: 'Work/Clients/Acme' });
		await t.mutation(api.mail.labels.create, { mailboxId, name: 'Work/Clients/Brightpath' });
		const list = await t.query(api.mail.labels.list, { mailboxId });
		expect(list.filter((row) => row.name === 'Work')).toHaveLength(1);
		expect(list.filter((row) => row.name === 'Clients')).toHaveLength(1);
	});

	it('allows the same leaf name under two different parents', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await t.mutation(api.mail.labels.create, { mailboxId, name: 'Work/Archive' });
		// Mailbox-wide name uniqueness would refuse this, which is exactly the
		// restriction nesting exists to lift.
		await expect(
			t.mutation(api.mail.labels.create, { mailboxId, name: 'Personal/Archive' })
		).resolves.toBeDefined();
	});

	it('still refuses an exact duplicate leaf', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await t.mutation(api.mail.labels.create, { mailboxId, name: 'Work/Clients' });
		await expect(
			t.mutation(api.mail.labels.create, { mailboxId, name: 'Work/Clients' })
		).rejects.toThrow();
	});

	it('refuses to nest past the depth bound', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await expect(
			t.mutation(api.mail.labels.create, { mailboxId, name: 'a/b/c/d/e/f/g' })
		).rejects.toThrow();
	});

	it('appends each sibling after the last', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await t.mutation(api.mail.labels.create, { mailboxId, name: 'first' });
		await t.mutation(api.mail.labels.create, { mailboxId, name: 'second' });
		const labels = await byName(t, mailboxId);
		expect(labels.get('first')?.order).toBe(0);
		expect(labels.get('second')?.order).toBe(1);
	});
});

describe('mail.labels.update nesting', () => {
	it('reparents, detaches and pins', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		const work = await t.mutation(api.mail.labels.create, { mailboxId, name: 'Work' });
		const acme = await t.mutation(api.mail.labels.create, { mailboxId, name: 'Acme' });

		await t.mutation(api.mail.labels.update, { labelId: acme, parentId: work, isPinned: true });
		let labels = await byName(t, mailboxId);
		expect(labels.get('Acme')?.parentId).toBe(work);
		expect(labels.get('Acme')?.isPinned).toBe(true);

		// `null` is the explicit "back to a root", distinct from omitting the arg.
		await t.mutation(api.mail.labels.update, { labelId: acme, parentId: null });
		labels = await byName(t, mailboxId);
		expect(labels.get('Acme')?.parentId).toBeUndefined();
	});

	it('refuses a reparent that would close a cycle', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await t.mutation(api.mail.labels.create, { mailboxId, name: 'Work/Clients/Acme' });
		const labels = await byName(t, mailboxId);
		const work = labels.get('Work')!._id;
		const acme = labels.get('Acme')!._id;

		// Work under its own grandchild would detach the whole ring from every
		// root, and the tree build would silently stop rendering all three.
		await expect(
			t.mutation(api.mail.labels.update, { labelId: work, parentId: acme })
		).rejects.toThrow();
		await expect(
			t.mutation(api.mail.labels.update, { labelId: work, parentId: work })
		).rejects.toThrow();
	});

	it('scopes rename uniqueness to the siblings, not the mailbox', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await t.mutation(api.mail.labels.create, { mailboxId, name: 'Work/Archive' });
		const personal = await t.mutation(api.mail.labels.create, { mailboxId, name: 'Personal/Old' });
		await expect(
			t.mutation(api.mail.labels.update, { labelId: personal, name: 'Archive' })
		).resolves.toBeNull();
	});
});

describe('mail.labels.reorder', () => {
	it('stamps the order the caller sent', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		const a = await t.mutation(api.mail.labels.create, { mailboxId, name: 'a' });
		const b = await t.mutation(api.mail.labels.create, { mailboxId, name: 'b' });
		const c = await t.mutation(api.mail.labels.create, { mailboxId, name: 'c' });

		await t.mutation(api.mail.labels.reorder, { mailboxId, labelIds: [c, a, b] });
		const labels = await byName(t, mailboxId);
		expect([labels.get('c')?.order, labels.get('a')?.order, labels.get('b')?.order]).toEqual([
			0, 1, 2,
		]);
	});

	it('skips an id from another mailbox instead of failing the batch', async () => {
		const t = convexTest(schema, modules);
		const mine = await seedMailbox(t, { address: 'mine@owlat.test' });
		const other = await seedMailbox(t, { address: 'other@owlat.test' });
		const a = await t.mutation(api.mail.labels.create, { mailboxId: mine, name: 'a' });
		const foreign = await t.mutation(api.mail.labels.create, { mailboxId: other, name: 'x' });

		await t.mutation(api.mail.labels.reorder, { mailboxId: mine, labelIds: [foreign, a] });
		const labels = await byName(t, mine);
		expect(labels.get('a')?.order).toBe(1);
		expect((await byName(t, other)).get('x')?.order).toBe(0);
	});
});

describe('mail.labels.remove', () => {
	it('promotes the children of a deleted branch instead of destroying them', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await t.mutation(api.mail.labels.create, { mailboxId, name: 'Work/Clients/Acme' });
		const labels = await byName(t, mailboxId);

		await t.mutation(api.mail.labels.remove, { labelId: labels.get('Clients')!._id });

		const after = await byName(t, mailboxId);
		expect([...after.keys()].sort()).toEqual(['Acme', 'Work']);
		// Acme rises to where Clients was, not to a root and not into nothing.
		expect(after.get('Acme')?.parentId).toBe(labels.get('Work')!._id);
	});
});

describe('mail.labels.unreadCounts', () => {
	it('tallies unread mail per label and skips read mail', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		const work = await t.mutation(api.mail.labels.create, { mailboxId, name: 'Work' });
		const acme = await t.mutation(api.mail.labels.create, { mailboxId, name: 'Acme' });

		const unread = await seedMessage(t, mailboxId, { subject: 'unread' });
		const read = await seedMessage(t, mailboxId, { subject: 'read' });
		await t.run(async (ctx) => {
			await ctx.db.patch(unread, { labelIds: [work, acme] });
			await ctx.db.patch(read, { labelIds: [work], flagSeen: true });
		});

		const { counts, isTruncated } = await t.query(api.mail.labels.unreadCounts, { mailboxId });
		expect(counts[work]).toBe(1);
		expect(counts[acme]).toBe(1);
		expect(isTruncated).toBe(false);
	});

	it('returns nothing for a mailbox the caller cannot read', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'user-A' });
		sessionMocks.userId = 'user-B';
		sessionMocks.role = 'editor';
		expect(await t.query(api.mail.labels.unreadCounts, { mailboxId })).toEqual({
			counts: {},
			isTruncated: false,
		});
	});
});

/** A `size`-message thread in the seeded inbox, raw-inserted like an existing mailbox's mail. */
async function seedThread(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>,
	size: number
): Promise<{ threadId: Id<'mailThreads'>; messageIds: Id<'mailMessages'>[] }> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const folder = (await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mailboxId).eq('role', 'inbox'))
			.first())!;
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: 'long',
			participants: ['someone@example.com'],
			messageCount: size,
			unreadCount: 0,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: 'long',
			latestFromAddress: 'someone@example.com',
			latestSubject: 'long',
			folderRoles: ['inbox'],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
		const rawStorageId = await ctx.storage.store(new Blob(['raw']));
		const messageIds: Id<'mailMessages'>[] = [];
		for (let i = 0; i < size; i++) {
			messageIds.push(
				await ctx.db.insert('mailMessages', {
					mailboxId,
					folderId: folder._id,
					uid: i + 1,
					modseq: 1,
					rfc822MessageId: `<long-${i}@example.com>`,
					threadId,
					fromAddress: 'someone@example.com',
					toAddresses: ['me@example.com'],
					ccAddresses: [],
					bccAddresses: [],
					subject: `long ${i}`,
					normalizedSubject: 'long',
					snippet: `long ${i}`,
					rawStorageId,
					rawSize: 3,
					attachments: [],
					hasAttachments: false,
					flagSeen: true,
					flagFlagged: false,
					flagAnswered: false,
					flagDraft: false,
					flagDeleted: false,
					customFlags: [],
					labelIds: [],
					receivedAt: now + i,
					internalDate: now,
					createdAt: now,
					updatedAt: now,
				})
			);
		}
		return { threadId, messageIds };
	});
}

const toggleHandler = toggleOnMessage as unknown as {
	_handler: (
		ctx: MutationCtx,
		args: { messageId: Id<'mailMessages'>; labelId: Id<'mailLabels'>; add: boolean }
	) => Promise<unknown>;
};

/** Documents per table that one label toggle's queries hand back. */
async function countedToggle(
	t: TestConvex<typeof schema>,
	args: { messageId: Id<'mailMessages'>; labelId: Id<'mailLabels'>; add: boolean }
): Promise<QueriedDocuments> {
	const queried: QueriedDocuments = {};
	await t.run((ctx) =>
		toggleHandler._handler({ ...ctx, db: tableCountingDb(ctx.db, queried) } as MutationCtx, args)
	);
	return queried;
}

async function threadLabels(t: TestConvex<typeof schema>, threadId: Id<'mailThreads'>) {
	return (await t.run((ctx) => ctx.db.get(threadId)))!.labelIds;
}

describe('thread label reconciliation and the label rows', () => {
	it('answers "does a sibling still carry it" with one probe once the rows are ready', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		const work = await t.mutation(api.mail.labels.create, { mailboxId, name: 'Work' });
		const { threadId, messageIds } = await seedThread(t, mailboxId, 200);
		const [first, second] = messageIds as [Id<'mailMessages'>, Id<'mailMessages'>];
		await t.run(async (ctx) => {
			await ctx.db.patch(first, { labelIds: [work] });
			await ctx.db.patch(second, { labelIds: [work] });
			await ctx.db.patch(threadId, { labelIds: [work] });
		});

		// Before the backfill: the toggle reads every message of the thread.
		const scan = await countedToggle(t, { messageId: first, labelId: work, add: false });
		expect(scan['mailMessages']).toBe(200);
		expect(await threadLabels(t, threadId)).toEqual([work]);

		await readyLabelRows(t, mailboxId);
		const indexed = await countedToggle(t, { messageId: second, labelId: work, add: false });
		expect(indexed['mailMessages'] ?? 0).toBe(0);
		// The removed pair's own row, then an empty probe for any other.
		expect(indexed['mailLabelMessages']).toBe(1);
		expect(await threadLabels(t, threadId)).toEqual([]);
		expect(await labelRowsOf(t, second)).toEqual([]);

		await countedToggle(t, { messageId: first, labelId: work, add: true });
		expect(await threadLabels(t, threadId)).toEqual([work]);
		expect((await labelRowsOf(t, first)).map((row) => row.labelId)).toEqual([work]);
	});

	it('keeps the rows exact across writes made before and after the backfill', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		const work = await t.mutation(api.mail.labels.create, { mailboxId, name: 'Work' });
		const home = await t.mutation(api.mail.labels.create, { mailboxId, name: 'Home' });
		const { threadId, messageIds } = await seedThread(t, mailboxId, 3);
		const [a, b, c] = messageIds as [Id<'mailMessages'>, Id<'mailMessages'>, Id<'mailMessages'>];
		// An existing label the rows never saw, then a toggle before the walk.
		await t.run((ctx) => ctx.db.patch(a, { labelIds: [home] }));
		await t.mutation(api.mail.labels.toggleOnMessage, { messageId: a, labelId: work, add: true });
		expect((await labelRowsOf(t, a)).map((row) => row.labelId)).toEqual([work]);

		await readyLabelRows(t, mailboxId);
		expect((await labelRowsOf(t, a)).map((row) => row.labelId).sort()).toEqual([work, home].sort());

		await t.mutation(api.mail.labels.setOnMessages, {
			messageIds: [b, c],
			labelId: work,
			add: true,
		});
		await t.mutation(api.mail.labels.toggleOnThread, { threadId, labelId: home, add: false });
		for (const id of [a, b, c]) {
			expect((await labelRowsOf(t, id)).map((row) => row.labelId)).toEqual([work]);
		}
		await t.mutation(api.mail.labels.toggleOnThread, { threadId, labelId: work, add: false });
		for (const id of [a, b, c]) expect(await labelRowsOf(t, id)).toEqual([]);
		expect(await threadLabels(t, threadId)).toEqual([]);
	});
});
