/**
 * The Workbench: one tab per mailbox.
 *
 *   - each tab keeps its own "since you last looked" mark; the global mark
 *     (finishing the Answer queue) still catches every tab up;
 *   - the digest lists people and alerts, and only counts newsletters and the
 *     like — with a few sender names — even for a thread the viewer knew;
 *   - mail the classifier has not reached yet is sorted by the ingest heuristic.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import {
	modules,
	seedFolder,
	seedMailbox,
	seedMessage,
} from '../../mail/__tests__/helpers.testlib';

const sessionMock = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'editor' as 'owner' | 'admin' | 'editor' | null,
	orgId: 'org-1',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = () => {
		if (sessionMock.role === null) return null;
		return {
			userId: sessionMock.userId,
			role: sessionMock.role,
			activeOrganizationId: sessionMock.orgId,
		};
	};
	return {
		...actual,
		requireOrgMember: vi.fn(async () => {
			if (sessionMock.role === null) throw new Error('Not authenticated');
			return {
				userId: sessionMock.userId,
				role: sessionMock.role,
				activeOrganizationId: sessionMock.orgId,
			};
		}),
		getMutationContext: vi.fn(async () => {
			const s = session();
			if (!s) throw new Error('Not authenticated');
			return s;
		}),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getBetterAuthSessionWithRole: vi.fn(async () => session()),
	};
});

function setSession(userId: string, role: 'owner' | 'admin' | 'editor' | null = 'editor') {
	sessionMock.userId = userId;
	sessionMock.role = role;
}

const HOUR = 60 * 60 * 1000;

/** The digest counts from the tab's own watermark; set it, then read. */
async function digestSince(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>,
	since: number
) {
	await t.mutation(api.today.state.markSeen, { at: since, scope: mailboxId });
	return t.query(api.today.mailbox.digest, { mailboxId });
}

async function threadOf(t: TestConvex<typeof schema>, messageId: Id<'mailMessages'>) {
	return t.run(async (ctx) => {
		const message = await ctx.db.get(messageId);
		if (!message) throw new Error('missing message');
		// The seed helper leaves `latestMessageId` unset; the real delivery path sets it.
		await ctx.db.patch(message.threadId, { latestMessageId: messageId });
		return message.threadId;
	});
}

/** Add a later inbound message to an existing thread, as delivery would. */
async function addReply(
	t: TestConvex<typeof schema>,
	threadId: Id<'mailThreads'>,
	at: number,
	fromAddress = 'ben@example.com'
) {
	return t.run(async (ctx) => {
		const thread = await ctx.db.get(threadId);
		if (!thread) throw new Error('missing thread');
		const seed = await ctx.db
			.query('mailMessages')
			.withIndex('by_thread', (q) => q.eq('threadId', threadId))
			.first();
		if (!seed) throw new Error('missing seed');
		const { _id, _creationTime, ...rest } = seed;
		const messageId = await ctx.db.insert('mailMessages', {
			...rest,
			fromAddress,
			receivedAt: at,
			internalDate: at,
			rfc822MessageId: `<reply-${at}@example.com>`,
		});
		await ctx.db.patch(threadId, {
			messageCount: thread.messageCount + 1,
			lastMessageAt: at,
			latestMessageId: messageId,
			latestFromAddress: fromAddress,
		});
		return messageId;
	});
}

async function categorise(
	t: TestConvex<typeof schema>,
	threadId: Id<'mailThreads'>,
	label: 'person' | 'newsletter' | 'notification' | 'receipt' | 'promotion' | 'spam' | 'other',
	source: 'heuristic' | 'llm' | 'user' = 'llm'
) {
	await t.run(async (ctx) =>
		ctx.db.patch(threadId, { category: { label, source, classifiedAt: Date.now() } })
	);
}

describe('workbench marks', () => {
	it('keeps one mark per tab and lets the global mark catch every tab up', async () => {
		const t = convexTest(schema, modules);
		setSession('user-A');
		const personal = await seedMailbox(t, { address: 'a@owlat.test' });
		const sales = await seedMailbox(t, { address: 'sales@owlat.test' });
		const now = Date.now();

		await t.mutation(api.today.state.markSeen, { at: now - 2 * HOUR, scope: personal });
		const personalState = await t.query(api.today.state.get, { scope: personal });
		expect(personalState).toMatchObject({ seenAt: now - 2 * HOUR, isFallback: false });
		// Another tab has not been marked: still the first-visit fallback.
		const salesState = await t.query(api.today.state.get, { scope: sales });
		expect(salesState.isFallback).toBe(true);
		expect(salesState.seenAt).toBeGreaterThanOrEqual(now - 24 * HOUR);
		expect(salesState.seenAt).toBeLessThanOrEqual(Date.now() - 24 * HOUR);

		// The global mark moves every tab that is behind it, but never one ahead.
		await t.mutation(api.today.state.markSeen, { at: now - 3 * HOUR });
		expect((await t.query(api.today.state.get, { scope: sales })).seenAt).toBe(now - 3 * HOUR);
		expect((await t.query(api.today.state.get, { scope: personal })).seenAt).toBe(now - 2 * HOUR);
		expect((await t.query(api.today.state.get, { scope: 'team' })).seenAt).toBe(now - 3 * HOUR);
	});

	it('undoes a tab mark, and a first mark undoes back to no mark', async () => {
		const t = convexTest(schema, modules);
		setSession('user-A');
		const mailboxId = await seedMailbox(t);
		const now = Date.now();

		await t.mutation(api.today.state.markSeen, { at: now - HOUR, scope: mailboxId });
		expect((await t.query(api.today.state.get, { scope: mailboxId })).previousSeenAt).toBeNull();
		await t.mutation(api.today.state.markSeen, { at: now, scope: mailboxId });
		expect((await t.query(api.today.state.get, { scope: mailboxId })).previousSeenAt).toBe(
			now - HOUR
		);

		await t.mutation(api.today.state.undoMarkSeen, { scope: mailboxId });
		expect((await t.query(api.today.state.get, { scope: mailboxId })).seenAt).toBe(now - HOUR);
		// Undo is one step; the restored mark has nothing left to undo.
		expect((await t.mutation(api.today.state.undoMarkSeen, { scope: mailboxId })).restored).toBe(
			false
		);

		const other = await seedMailbox(t, { address: 'b@owlat.test' });
		await t.mutation(api.today.state.markSeen, { at: now, scope: other });
		await t.mutation(api.today.state.undoMarkSeen, { scope: other });
		expect((await t.query(api.today.state.get, { scope: other })).isFallback).toBe(true);
	});

	it('answers every tab from one unscoped read, the same as the scoped one', async () => {
		const t = convexTest(schema, modules);
		setSession('user-A');
		const personal = await seedMailbox(t, { address: 'a@owlat.test' });
		const sales = await seedMailbox(t, { address: 'sales@owlat.test' });
		const now = Date.now();

		const before = await t.query(api.today.state.get, {});
		expect(before.watermarks.marks).toEqual([]);
		expect(before.watermarks.unmarked.isFallback).toBe(true);

		await t.mutation(api.today.state.markSeen, { at: now - 2 * HOUR, scope: personal });
		await t.mutation(api.today.state.markSeen, { at: now - HOUR, scope: personal });
		await t.mutation(api.today.state.markSeen, { at: now - 3 * HOUR });
		await t.mutation(api.today.state.markSeen, { at: now - 5 * HOUR, scope: 'team' });

		const { watermarks } = await t.query(api.today.state.get, {});
		const pick = (scope: typeof personal | 'team') =>
			watermarks.marks.find((m) => m.scope === scope) ?? watermarks.unmarked;
		for (const scope of [personal, sales, 'team'] as const) {
			const { seenAt, previousSeenAt, isFallback } = await t.query(api.today.state.get, {
				scope,
			});
			expect(pick(scope)).toMatchObject({ seenAt, previousSeenAt, isFallback });
		}
		expect(pick(personal)).toMatchObject({ seenAt: now - HOUR, previousSeenAt: now - 2 * HOUR });
		// Behind the global mark: the global one wins, with nothing of its own to undo.
		expect(pick('team')).toMatchObject({ seenAt: now - 3 * HOUR, previousSeenAt: null });
		expect(pick(sales)).toMatchObject({ seenAt: now - 3 * HOUR, previousSeenAt: null });
	});

	it('refuses to mark a mailbox the caller cannot read', async () => {
		const t = convexTest(schema, modules);
		const privateBox = await seedMailbox(t, { userId: 'user-A' });
		setSession('user-B');
		await expect(t.mutation(api.today.state.markSeen, { scope: privateBox })).rejects.toThrow();
	});
});

describe('workbench digest triage', () => {
	it('lists people and alerts, and only counts filed mail with its senders', async () => {
		const t = convexTest(schema, modules);
		setSession('user-A');
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		await seedFolder(t, mailboxId, 'spam');
		const now = Date.now();
		const since = now - 6 * HOUR;
		const seed = async (
			subject: string,
			fromAddress: string,
			extra: { fromName?: string; role?: 'inbox' | 'spam'; at?: number } = {}
		) =>
			threadOf(
				t,
				await seedMessage(t, mailboxId, {
					subject,
					fromAddress,
					fromName: extra.fromName,
					role: extra.role,
					receivedAt: extra.at ?? now - HOUR,
				})
			);

		await categorise(t, await seed('Lunch on Friday?', 'nora@example.com'), 'person');
		await categorise(
			t,
			await seed('Security alert: new sign-in', 'alerts@bank.example'),
			'notification',
			'heuristic'
		);
		await categorise(t, await seed('Project inquiry', 'lea@studio.example'), 'other', 'heuristic');
		await categorise(t, await seed('Trip ideas', 'mei@example.com'), 'other', 'llm');
		await categorise(
			t,
			await seed('This week', 'news@verge.example', { fromName: 'The Verge' }),
			'newsletter'
		);
		await categorise(
			t,
			await seed('Issue 42', 'hi@stratechery.example', { fromName: 'Stratechery' }),
			'newsletter'
		);
		await categorise(
			t,
			await seed('Deploy finished', 'noreply@ci.example'),
			'notification',
			'heuristic'
		);
		await categorise(t, await seed('You won!', 'x@scam.example', { role: 'spam' }), 'spam');

		// A newsletter thread the viewer once opened is still filed, not "changed".
		const known = await seed('Weekly digest', 'digest@news.example', {
			fromName: 'Weekly Digest',
			at: now - 8 * HOUR,
		});
		await categorise(t, known, 'newsletter');
		await t.mutation(api.mail.threadVisits.recordVisit, { threadId: known });
		await t.run(async (ctx) => {
			const visit = await ctx.db
				.query('mailThreadVisits')
				.withIndex('by_user_and_thread', (q) => q.eq('userId', 'user-A').eq('threadId', known))
				.first();
			await ctx.db.patch(visit!._id, { visitedAt: now - 7 * HOUR });
			await ctx.db.patch(known, { lastMessageAt: now - 30 * 60 * 1000 });
		});

		const digest = await digestSince(t, mailboxId, since);
		expect(digest).not.toBeNull();
		expect(digest!.changed).toEqual([]);
		const bySubject = Object.fromEntries(digest!.arrived.map((a) => [a.subject, a]));
		expect(Object.keys(bySubject).sort()).toEqual(
			['Lunch on Friday?', 'Project inquiry', 'Security alert: new sign-in', 'Trip ideas'].sort()
		);
		expect(bySubject['Lunch on Friday?']).toMatchObject({ bucket: 'important', reason: 'person' });
		expect(bySubject['Security alert: new sign-in']).toMatchObject({
			bucket: 'important',
			reason: 'alert',
		});
		expect(bySubject['Project inquiry']).toMatchObject({
			bucket: 'important',
			reason: 'new_sender',
		});
		expect(bySubject['Trip ideas']).toMatchObject({ bucket: 'routine', reason: null });

		expect(digest!.filed).toMatchObject({ newsletter: 3, notification: 1, spam: 1 });
		expect([...digest!.filedSenders.newsletter].sort()).toEqual(
			['Stratechery', 'The Verge', 'Weekly Digest'].sort()
		);
		expect(digest!.filedSenders.notification).toEqual(['ci.example']);
	});

	it('sorts mail the classifier has not reached yet with the ingest heuristic', async () => {
		const t = convexTest(schema, modules);
		setSession('user-A');
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		const now = Date.now();
		const list = await threadOf(
			t,
			await seedMessage(t, mailboxId, {
				subject: 'Our autumn issue',
				fromAddress: 'editor@magazine.example',
				receivedAt: now - HOUR,
			})
		);
		await t.run(async (ctx) => {
			const thread = await ctx.db.get(list);
			await ctx.db.patch(thread!.latestMessageId!, {
				unsubscribe: { httpUrl: 'https://magazine.example/u', oneClick: true },
			});
		});
		await threadOf(
			t,
			await seedMessage(t, mailboxId, {
				subject: 'Receipt for your order',
				fromAddress: 'shop@store.example',
				receivedAt: now - HOUR,
			})
		);
		await threadOf(
			t,
			await seedMessage(t, mailboxId, {
				subject: 'Quick question',
				fromAddress: 'jonas@example.com',
				receivedAt: now - HOUR,
			})
		);

		const digest = await digestSince(t, mailboxId, now - 3 * HOUR);
		expect(digest!.arrived.map((a) => [a.subject, a.bucket])).toEqual([
			['Quick question', 'important'],
		]);
		expect(digest!.filed).toMatchObject({ newsletter: 1, receipt: 1 });
	});
});
