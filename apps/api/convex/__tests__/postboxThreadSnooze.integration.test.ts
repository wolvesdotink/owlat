/**
 * Thread-scope snooze + the back-from-snooze marker (mail/snooze.ts):
 *   - snoozeThread defers EVERY inbox message of the thread with one wake time
 *     and leaves non-inbox siblings (a sent copy) alone
 *   - the whole conversation leaves the inbox and shows up in the Snoozed view
 *   - the wake sweep resurfaces the thread ATOMICALLY: siblings past the
 *     take() page boundary are woken in the same pass
 *   - the sweep stamps `snoozeReturnedAt`, the list row carries it, and
 *     clearSnoozeReturned (fired on open) drops it
 *   - unsnoozeMany wakes the conversation early from the list
 *   - snoozeThread rejects a past timestamp and a mailbox the caller can't reach
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

const sessionMock = vi.hoisted(() => ({
	userId: 'test-user',
	role: 'owner' as 'owner' | 'editor',
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.userId,
			role: sessionMock.role,
		})),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.userId,
			role: sessionMock.role,
		})),
		getBetterAuthSessionWithRole: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.userId,
			role: sessionMock.role,
			activeOrganizationId: 'test-org',
		})),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('llmProvider')
	)
);

interface Seeded {
	mailboxId: Id<'mailboxes'>;
	inboxId: Id<'mailFolders'>;
	sentId: Id<'mailFolders'>;
}

async function seed(t: ReturnType<typeof convexTest>): Promise<Seeded> {
	let mailboxId!: Id<'mailboxes'>;
	let inboxId!: Id<'mailFolders'>;
	let sentId!: Id<'mailFolders'>;
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
		const folder = (name: string, role: 'inbox' | 'sent') =>
			ctx.db.insert('mailFolders', {
				mailboxId,
				name,
				role,
				uidValidity: now,
				uidNext: 1,
				highestModseq: 1,
				totalCount: 0,
				unseenCount: 0,
				subscribed: true,
				createdAt: now,
				updatedAt: now,
			});
		inboxId = await folder('INBOX', 'inbox');
		sentId = await folder('Sent', 'sent');
	});
	return { mailboxId, inboxId, sentId };
}

async function newThread(
	t: ReturnType<typeof convexTest>,
	seeded: Seeded,
	subject: string
): Promise<Id<'mailThreads'>> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert('mailThreads', {
			mailboxId: seeded.mailboxId,
			normalizedSubject: subject.toLowerCase(),
			participants: ['alice@example.com', 'me@example.com'],
			messageCount: 0,
			unreadCount: 0,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: subject,
			latestFromAddress: 'alice@example.com',
			latestSubject: subject,
			folderRoles: ['inbox'],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
	});
}

let uidSeq = 0;

async function addMessage(
	t: ReturnType<typeof convexTest>,
	seeded: Seeded,
	opts: {
		threadId: Id<'mailThreads'>;
		subject: string;
		folder?: 'inbox' | 'sent';
		snoozedUntil?: number;
		flagSeen?: boolean;
	}
): Promise<Id<'mailMessages'>> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const uid = ++uidSeq;
		const storageId = await ctx.storage.store(new Blob([opts.subject]));
		return await ctx.db.insert('mailMessages', {
			mailboxId: seeded.mailboxId,
			folderId: opts.folder === 'sent' ? seeded.sentId : seeded.inboxId,
			uid,
			modseq: uid,
			rfc822MessageId: `<${opts.subject}-${uid}@example.com>`,
			threadId: opts.threadId,
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
			flagSeen: opts.flagSeen ?? false,
			flagFlagged: false,
			flagAnswered: false,
			flagDraft: false,
			flagDeleted: false,
			customFlags: [],
			labelIds: [],
			snoozedUntil: opts.snoozedUntil,
			receivedAt: now,
			internalDate: now,
			createdAt: now,
			updatedAt: now,
		});
	});
}

const HOUR = 60 * 60 * 1000;

describe('postbox thread-scope snooze', () => {
	it('defers every inbox message of the thread with one wake time, leaving the sent copy alone', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const threadId = await newThread(t, seeded, 'planning');
		const a = await addMessage(t, seeded, { threadId, subject: 'planning' });
		const b = await addMessage(t, seeded, { threadId, subject: 'planning-2' });
		const mine = await addMessage(t, seeded, {
			threadId,
			subject: 'planning-reply',
			folder: 'sent',
			flagSeen: true,
		});
		await t.run((ctx) => ctx.db.patch(seeded.inboxId, { totalCount: 2, unseenCount: 2 }));

		const until = Date.now() + HOUR;
		expect(await t.mutation(api.mail.snooze.snoozeThread, { threadId, until })).toEqual({
			ok: true,
			snoozed: 2,
		});

		expect((await t.run((ctx) => ctx.db.get(a)))?.snoozedUntil).toBe(until);
		expect((await t.run((ctx) => ctx.db.get(b)))?.snoozedUntil).toBe(until);
		expect((await t.run((ctx) => ctx.db.get(mine)))?.snoozedUntil).toBeUndefined();
		// Both deferred messages left the folder unread count.
		expect((await t.run((ctx) => ctx.db.get(seeded.inboxId)))?.unseenCount).toBe(0);

		const inbox = await t.query(api.mail.mailbox.queries.listMessages, {
			mailboxId: seeded.mailboxId,
			folderRole: 'inbox',
		});
		expect(inbox.messages).toEqual([]);
		const snoozed = await t.query(api.mail.mailbox.queries.listMessages, {
			mailboxId: seeded.mailboxId,
			folderRole: 'snoozed',
		});
		expect(snoozed.messages.map((m) => m.subject).sort()).toEqual(['planning', 'planning-2']);
	});

	it('rejects a wake time in the past', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const threadId = await newThread(t, seeded, 'planning');
		await addMessage(t, seeded, { threadId, subject: 'planning' });
		await expect(
			t.mutation(api.mail.snooze.snoozeThread, { threadId, until: Date.now() - 1000 })
		).rejects.toThrow();
	});

	it('refuses a thread the caller has no access to', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const threadId = await newThread(t, seeded, 'planning');
		await addMessage(t, seeded, { threadId, subject: 'planning' });
		sessionMock.userId = 'someone-else';
		sessionMock.role = 'editor';
		try {
			await expect(
				t.mutation(api.mail.snooze.snoozeThread, { threadId, until: Date.now() + HOUR })
			).rejects.toThrow();
			await expect(t.mutation(api.mail.snooze.clearSnoozeReturned, { threadId })).rejects.toThrow();
		} finally {
			sessionMock.userId = 'test-user';
			sessionMock.role = 'owner';
		}
	});

	it('unsnoozeMany wakes the whole conversation early', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const threadId = await newThread(t, seeded, 'planning');
		const a = await addMessage(t, seeded, { threadId, subject: 'planning' });
		const b = await addMessage(t, seeded, { threadId, subject: 'planning-2' });
		await t.run((ctx) => ctx.db.patch(seeded.inboxId, { totalCount: 2, unseenCount: 2 }));
		await t.mutation(api.mail.snooze.snoozeThread, { threadId, until: Date.now() + HOUR });

		// The list is where a snoozed conversation is woken early: the rows are
		// selected and unsnoozed together. There is no thread-keyed twin — one
		// would have shipped with nothing on the instance able to call it.
		expect(await t.mutation(api.mail.snooze.unsnoozeMany, { messageIds: [a, b] })).toEqual({
			woken: 2,
		});
		expect((await t.run((ctx) => ctx.db.get(a)))?.snoozedUntil).toBeUndefined();
		expect((await t.run((ctx) => ctx.db.get(b)))?.snoozedUntil).toBeUndefined();
		expect((await t.run((ctx) => ctx.db.get(seeded.inboxId)))?.unseenCount).toBe(2);
	});

	it('the wake sweep finishes a thread whose siblings fell past the page boundary', async () => {
		// The sweep pages 100 due rows. A thread snoozed as a unit can straddle
		// that boundary; it must still come back as ONE conversation.
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const past = Date.now() - 1000;
		const noiseThread = await newThread(t, seeded, 'noise');
		for (let i = 0; i < 99; i++) {
			await addMessage(t, seeded, {
				threadId: noiseThread,
				subject: `noise-${i}`,
				snoozedUntil: past,
				flagSeen: true,
			});
		}
		const threadId = await newThread(t, seeded, 'planning');
		const ids: Id<'mailMessages'>[] = [];
		for (let i = 0; i < 5; i++) {
			ids.push(
				await addMessage(t, seeded, {
					threadId,
					subject: `planning-${i}`,
					snoozedUntil: past,
					flagSeen: true,
				})
			);
		}

		const result = await t.mutation(internal.mail.snooze.internalSweep, {});
		// 99 noise + 1 that fit in the page + the 4 finished off by the
		// thread-completion pass.
		expect(result.woken).toBe(104);
		for (const id of ids) {
			expect((await t.run((ctx) => ctx.db.get(id)))?.snoozedUntil).toBeUndefined();
		}
	});

	it('the sweep stamps snoozeReturnedAt, the list row carries it, and opening clears it', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const threadId = await newThread(t, seeded, 'planning');
		await addMessage(t, seeded, {
			threadId,
			subject: 'planning',
			snoozedUntil: Date.now() - 1000,
		});

		await t.mutation(internal.mail.snooze.internalSweep, {});
		expect((await t.run((ctx) => ctx.db.get(threadId)))?.snoozeReturnedAt).toBeGreaterThan(0);

		const inbox = await t.query(api.mail.mailbox.queries.listMessages, {
			mailboxId: seeded.mailboxId,
			folderRole: 'inbox',
		});
		expect(inbox.messages[0]?.snoozeReturnedAt).toBeGreaterThan(0);

		await t.mutation(api.mail.snooze.clearSnoozeReturned, { threadId });
		expect((await t.run((ctx) => ctx.db.get(threadId)))?.snoozeReturnedAt).toBeUndefined();
		// Idempotent — the reader fires it on every open.
		await t.mutation(api.mail.snooze.clearSnoozeReturned, { threadId });
		expect((await t.run((ctx) => ctx.db.get(threadId)))?.snoozeReturnedAt).toBeUndefined();
	});

	it('re-snoozing a returned thread drops the stale returned marker', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const threadId = await newThread(t, seeded, 'planning');
		await addMessage(t, seeded, {
			threadId,
			subject: 'planning',
			snoozedUntil: Date.now() - 1000,
		});
		await t.mutation(internal.mail.snooze.internalSweep, {});
		expect((await t.run((ctx) => ctx.db.get(threadId)))?.snoozeReturnedAt).toBeGreaterThan(0);

		await t.mutation(api.mail.snooze.snoozeThread, { threadId, until: Date.now() + HOUR });
		expect((await t.run((ctx) => ctx.db.get(threadId)))?.snoozeReturnedAt).toBeUndefined();
	});
});
