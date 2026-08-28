/**
 * The batch half of the thread list's bulk bar: `labels.setOnMessages`,
 * `snooze.snoozeMany` / `unsnoozeMany`, and the `mailbox/selection` id query
 * that feeds "Select all N matching".
 *
 * The three things worth pinning: one transaction really does write every
 * message (the loops these replaced could stop halfway), a foreign or stale id
 * inside a client-supplied selection is skipped rather than fatal, and the
 * thread aggregate ends up consistent after a batch rather than reflecting the
 * last message written.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { modules, seedMailbox, seedFolder, seedMessage } from './helpers.testlib';

const sessionMock = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'editor' as 'owner' | 'admin' | 'editor',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ({ userId: sessionMock.userId, role: sessionMock.role })),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => ({
			userId: sessionMock.userId,
			role: sessionMock.role,
			activeOrganizationId: 'org-1',
		})),
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			userId: sessionMock.userId,
			role: sessionMock.role,
			activeOrganizationId: 'org-1',
		})),
	};
});

beforeEach(() => {
	sessionMock.userId = 'user-A';
	sessionMock.role = 'editor';
});

/** A mailbox with an inbox and `count` messages in it, newest last. */
async function seedInbox(t: ReturnType<typeof convexTest>, count: number, userId = 'user-A') {
	const mailboxId = await seedMailbox(t, { userId });
	await seedFolder(t, mailboxId, 'inbox');
	const messageIds: Id<'mailMessages'>[] = [];
	for (let i = 0; i < count; i++) {
		messageIds.push(
			await seedMessage(t, mailboxId, { subject: `m${i}`, receivedAt: 1_000 + i * 1_000 })
		);
	}
	return { mailboxId, messageIds };
}

describe('mail.labels.setOnMessages', () => {
	it('labels every message in one call and reflects it on the thread', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageIds } = await seedInbox(t, 3);
		const labelId = await t.mutation(api.mail.labels.create, { mailboxId, name: 'Receipts' });

		const result = await t.mutation(api.mail.labels.setOnMessages, {
			messageIds,
			labelId,
			add: true,
		});
		expect(result.changed).toBe(3);

		await t.run(async (ctx) => {
			for (const id of messageIds) {
				const m = await ctx.db.get(id);
				expect(m?.labelIds).toContain(labelId);
				const thread = await ctx.db.get(m!.threadId);
				expect(thread?.labelIds).toContain(labelId);
			}
		});
	});

	it('removing drops the label from the messages and their threads', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageIds } = await seedInbox(t, 2);
		const labelId = await t.mutation(api.mail.labels.create, { mailboxId, name: 'Receipts' });
		await t.mutation(api.mail.labels.setOnMessages, { messageIds, labelId, add: true });

		const result = await t.mutation(api.mail.labels.setOnMessages, {
			messageIds,
			labelId,
			add: false,
		});
		expect(result.changed).toBe(2);
		await t.run(async (ctx) => {
			for (const id of messageIds) {
				const m = await ctx.db.get(id);
				expect(m?.labelIds).toEqual([]);
				const thread = await ctx.db.get(m!.threadId);
				expect(thread?.labelIds).toEqual([]);
			}
		});
	});

	it('counts only the messages it actually changed (re-running is a no-op)', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageIds } = await seedInbox(t, 2);
		const labelId = await t.mutation(api.mail.labels.create, { mailboxId, name: 'Receipts' });

		await t.mutation(api.mail.labels.setOnMessages, { messageIds, labelId, add: true });
		const again = await t.mutation(api.mail.labels.setOnMessages, {
			messageIds,
			labelId,
			add: true,
		});
		expect(again.changed).toBe(0);
	});

	it('skips ids from another mailbox instead of labelling across the boundary', async () => {
		const t = convexTest(schema, modules);
		const mine = await seedInbox(t, 1);
		const theirs = await seedInbox(t, 1, 'user-B');
		const labelId = await t.mutation(api.mail.labels.create, {
			mailboxId: mine.mailboxId,
			name: 'Receipts',
		});

		const result = await t.mutation(api.mail.labels.setOnMessages, {
			messageIds: [...mine.messageIds, ...theirs.messageIds],
			labelId,
			add: true,
		});
		expect(result.changed).toBe(1);
		await t.run(async (ctx) => {
			expect((await ctx.db.get(theirs.messageIds[0]!))?.labelIds).toEqual([]);
		});
	});

	it('refuses a label the caller cannot reach', async () => {
		const t = convexTest(schema, modules);
		const mine = await seedInbox(t, 1);
		const theirs = await seedInbox(t, 1, 'user-B');
		sessionMock.userId = 'user-B';
		const foreignLabel = await t.mutation(api.mail.labels.create, {
			mailboxId: theirs.mailboxId,
			name: 'Theirs',
		});

		sessionMock.userId = 'user-A';
		await expect(
			t.mutation(api.mail.labels.setOnMessages, {
				messageIds: mine.messageIds,
				labelId: foreignLabel,
				add: true,
			})
		).rejects.toThrow();
	});
});

describe('mail.snooze.snoozeMany / unsnoozeMany', () => {
	it('defers every selected message to the same wake time and wakes them again', async () => {
		const t = convexTest(schema, modules);
		const { messageIds } = await seedInbox(t, 3);
		const until = Date.now() + 60_000;

		const snoozed = await t.mutation(api.mail.snooze.snoozeMany, { messageIds, until });
		expect(snoozed.snoozed).toBe(3);
		await t.run(async (ctx) => {
			for (const id of messageIds) {
				expect((await ctx.db.get(id))?.snoozedUntil).toBe(until);
			}
		});

		const woken = await t.mutation(api.mail.snooze.unsnoozeMany, { messageIds });
		expect(woken.woken).toBe(3);
		await t.run(async (ctx) => {
			for (const id of messageIds) {
				expect((await ctx.db.get(id))?.snoozedUntil).toBeUndefined();
			}
		});
	});

	it('rejects a wake time in the past for the whole batch', async () => {
		const t = convexTest(schema, modules);
		const { messageIds } = await seedInbox(t, 2);
		await expect(
			t.mutation(api.mail.snooze.snoozeMany, { messageIds, until: Date.now() - 1 })
		).rejects.toThrow();
	});

	it('skips messages in another user mailbox', async () => {
		const t = convexTest(schema, modules);
		const mine = await seedInbox(t, 1);
		const theirs = await seedInbox(t, 1, 'user-B');
		const result = await t.mutation(api.mail.snooze.snoozeMany, {
			messageIds: [...mine.messageIds, ...theirs.messageIds],
			until: Date.now() + 60_000,
		});
		expect(result.snoozed).toBe(1);
		await t.run(async (ctx) => {
			expect((await ctx.db.get(theirs.messageIds[0]!))?.snoozedUntil).toBeUndefined();
		});
	});

	it('unsnoozeMany ignores messages that were never snoozed', async () => {
		const t = convexTest(schema, modules);
		const { messageIds } = await seedInbox(t, 2);
		const result = await t.mutation(api.mail.snooze.unsnoozeMany, { messageIds });
		expect(result.woken).toBe(0);
	});
});

describe('mail.mailbox.selection.listMessageIds', () => {
	it('returns the folder ids newest-first and reports an uncapped answer', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageIds } = await seedInbox(t, 3);
		const result = await t.query(api.mail.mailbox.selection.listMessageIds, {
			mailboxId,
			folderRole: 'inbox',
		});
		expect(result.capped).toBe(false);
		expect(result.ids).toEqual([...messageIds].reverse());
	});

	it('honours the oldest-first order the list is showing', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageIds } = await seedInbox(t, 3);
		const result = await t.query(api.mail.mailbox.selection.listMessageIds, {
			mailboxId,
			folderRole: 'inbox',
			sortOrder: 'oldest',
		});
		expect(result.ids).toEqual(messageIds);
	});

	it('omits snoozed messages, which the list is not showing either', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageIds } = await seedInbox(t, 3);
		await t.mutation(api.mail.snooze.snoozeMany, {
			messageIds: [messageIds[0]!],
			until: Date.now() + 60_000,
		});
		const result = await t.query(api.mail.mailbox.selection.listMessageIds, {
			mailboxId,
			folderRole: 'inbox',
		});
		expect(result.ids).not.toContain(messageIds[0]);
		expect(result.ids).toHaveLength(2);
	});

	it('returns nothing for a mailbox the caller cannot read', async () => {
		const t = convexTest(schema, modules);
		const theirs = await seedInbox(t, 2, 'user-B');
		const result = await t.query(api.mail.mailbox.selection.listMessageIds, {
			mailboxId: theirs.mailboxId,
			folderRole: 'inbox',
		});
		expect(result).toEqual({ ids: [], capped: false });
	});

	it('returns nothing for a folder id belonging to another mailbox', async () => {
		const t = convexTest(schema, modules);
		const mine = await seedInbox(t, 1);
		const theirs = await seedInbox(t, 1, 'user-B');
		let foreignFolderId!: Id<'mailFolders'>;
		await t.run(async (ctx) => {
			const m = await ctx.db.get(theirs.messageIds[0]!);
			foreignFolderId = m!.folderId;
		});
		const result = await t.query(api.mail.mailbox.selection.listMessageIds, {
			mailboxId: mine.mailboxId,
			folderId: foreignFolderId,
		});
		expect(result).toEqual({ ids: [], capped: false });
	});
});
