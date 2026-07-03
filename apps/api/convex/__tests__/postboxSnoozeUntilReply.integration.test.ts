/**
 * "Snooze until they reply" coverage.
 *
 *   - snoozeUntilReply hides the message (cap on `snoozedUntil`, flag set) and
 *     drops it from the folder unread count like a normal snooze.
 *   - an inbound reply into the thread clears the watch early
 *     (clearSnoozeUntilReplyForThread — the hook mail/delivery.ts fires) and
 *     re-floats the message into its folder.
 *   - with NO reply, the standard snooze sweep resurfaces it exactly once at
 *     the cap and clears the flag.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { clearSnoozeUntilReplyForThread } from '../mail/snooze';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		getBetterAuthSessionWithRole: vi.fn().mockResolvedValue({
			userId: 'test-user',
			role: 'owner',
			activeOrganizationId: 'test-org',
		}),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(([path]) =>
		!path.includes('sesActions') &&
		!path.includes('agentSecurity') &&
		!path.includes('agentContext') &&
		!path.includes('llmProvider')
	)
);

async function seed(t: ReturnType<typeof convexTest>) {
	let mailboxId!: Id<'mailboxes'>;
	let inboxId!: Id<'mailFolders'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'test-user',
			organizationId: 'test-org',
			address: 'me@example.com',
			domain: 'example.com',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		inboxId = await ctx.db.insert('mailFolders', {
			mailboxId,
			name: 'INBOX',
			role: 'inbox',
			uidValidity: now,
			uidNext: 1,
			highestModseq: 1,
			totalCount: 1,
			unseenCount: 1,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
	});
	return { mailboxId, inboxId };
}

async function seedMessage(
	t: ReturnType<typeof convexTest>,
	opts: { mailboxId: Id<'mailboxes'>; folderId: Id<'mailFolders'>; subject: string }
): Promise<{ messageId: Id<'mailMessages'>; threadId: Id<'mailThreads'> }> {
	let messageId!: Id<'mailMessages'>;
	let threadId!: Id<'mailThreads'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		const storageId = await ctx.storage.store(new Blob([opts.subject]));
		threadId = await ctx.db.insert('mailThreads', {
			mailboxId: opts.mailboxId,
			normalizedSubject: opts.subject.toLowerCase(),
			participants: ['alice@example.com'],
			messageCount: 1,
			unreadCount: 1,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: opts.subject,
			latestFromAddress: 'alice@example.com',
			latestSubject: opts.subject,
			folderRoles: ['inbox'],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
		messageId = await ctx.db.insert('mailMessages', {
			mailboxId: opts.mailboxId,
			folderId: opts.folderId,
			uid: 1,
			modseq: 1,
			rfc822MessageId: `<${opts.subject}@example.com>`,
			threadId,
			fromAddress: 'alice@example.com',
			toAddresses: ['me@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			subject: opts.subject,
			normalizedSubject: opts.subject.toLowerCase(),
			snippet: opts.subject,
			rawStorageId: storageId,
			rawSize: opts.subject.length,
			attachments: [],
			hasAttachments: false,
			flagSeen: false,
			flagFlagged: false,
			flagAnswered: false,
			flagDraft: false,
			flagDeleted: false,
			customFlags: [],
			labelIds: [],
			receivedAt: now,
			internalDate: now,
			createdAt: now,
			updatedAt: now,
		});
	});
	return { messageId, threadId };
}

describe('snooze until they reply', () => {
	it('hides the message and drops it from the unread count', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, inboxId } = await seed(t);
		const { messageId } = await seedMessage(t, { mailboxId, folderId: inboxId, subject: 'q' });

		const cap = Date.now() + 7 * 24 * 60 * 60 * 1000;
		await t.mutation(api.mail.snooze.snoozeUntilReply, { messageId, capUntil: cap });

		const msg = await t.run((ctx) => ctx.db.get(messageId));
		expect(msg?.snoozedUntil).toBe(cap);
		expect(msg?.snoozeUntilReply).toBe(true);
		expect((await t.run((ctx) => ctx.db.get(inboxId)))?.unseenCount).toBe(0);
	});

	it('clears the watch on an inbound reply and re-floats the message', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, inboxId } = await seed(t);
		const { messageId, threadId } = await seedMessage(t, {
			mailboxId,
			folderId: inboxId,
			subject: 'q',
		});

		const cap = Date.now() + 7 * 24 * 60 * 60 * 1000;
		await t.mutation(api.mail.snooze.snoozeUntilReply, { messageId, capUntil: cap });
		expect((await t.run((ctx) => ctx.db.get(inboxId)))?.unseenCount).toBe(0);

		// The awaited reply lands — mail/delivery.ts calls this hook.
		await t.run((ctx) => clearSnoozeUntilReplyForThread(ctx, threadId, Date.now()));

		const msg = await t.run((ctx) => ctx.db.get(messageId));
		expect(msg?.snoozedUntil).toBeUndefined();
		expect(msg?.snoozeUntilReply).toBeUndefined();
		// Re-entered its folder → back in the unread count.
		expect((await t.run((ctx) => ctx.db.get(inboxId)))?.unseenCount).toBe(1);
	});

	it('resurfaces exactly once at the cap when no reply arrives', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, inboxId } = await seed(t);
		const { messageId } = await seedMessage(t, { mailboxId, folderId: inboxId, subject: 'q' });

		await t.mutation(api.mail.snooze.snoozeUntilReply, {
			messageId,
			capUntil: Date.now() + 7 * 24 * 60 * 60 * 1000,
		});
		// Force the cap due while keeping the until-reply flag set.
		await t.run((ctx) => ctx.db.patch(messageId, { snoozedUntil: Date.now() - 1000 }));

		const first = await t.mutation(internal.mail.snooze.internalSweep, {});
		expect(first.woken).toBe(1);
		const msg = await t.run((ctx) => ctx.db.get(messageId));
		expect(msg?.snoozedUntil).toBeUndefined();
		expect(msg?.snoozeUntilReply).toBeUndefined();
		expect((await t.run((ctx) => ctx.db.get(inboxId)))?.unseenCount).toBe(1);

		// Fires exactly once — a second sweep wakes nothing.
		const second = await t.mutation(internal.mail.snooze.internalSweep, {});
		expect(second.woken).toBe(0);
	});
});
