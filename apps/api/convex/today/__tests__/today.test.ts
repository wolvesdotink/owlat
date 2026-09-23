/**
 * Today's per-user memory and per-mailbox reads.
 *
 *   - the watermark moves forward only, and can be undone once;
 *   - a thread visit makes later messages read as "Updated" / "What changed"
 *     for THAT member only (a shared inbox has shared read flags);
 *   - the digest sorts new mail into changed / arrived / filed, leaves
 *     needs-reply threads to the Answer queue, and hides mail the caller
 *     cannot open;
 *   - the sidebar returns one status per row and surfaces hidden urgency.
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
import { deriveThreadStatus, mostUrgentStatus } from '../threadStatus';

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

describe('thread status rules', () => {
	it('ranks draft ready over needs-you over updated over waiting', () => {
		expect(deriveThreadStatus({ needsReply: { draftSlot: {} }, newSinceVisit: 3 })).toBe(
			'draft_ready'
		);
		expect(deriveThreadStatus({ needsReply: {}, newSinceVisit: 3 })).toBe('needs_you');
		expect(deriveThreadStatus({ followUp: { dueAt: 1 }, newSinceVisit: 0 })).toBe('needs_you');
		expect(deriveThreadStatus({ newSinceVisit: 2, followUp: {} })).toBe('updated');
		expect(deriveThreadStatus({ followUp: {}, newSinceVisit: 0 })).toBe('waiting');
		expect(deriveThreadStatus({ newSinceVisit: 0 })).toBeNull();
		expect(mostUrgentStatus(['waiting', null, 'updated', 'needs_you'])).toBe('needs_you');
		expect(mostUrgentStatus([null, undefined])).toBeNull();
	});
});

describe('today watermark', () => {
	it('falls back to the last 24 hours, then only moves forward and undoes once', async () => {
		const t = convexTest(schema, modules);
		setSession('user-A');
		const now = Date.now();
		const first = await t.query(api.today.state.get, { now });
		expect(first.isFallback).toBe(true);
		expect(first.seenAt).toBe(now - 24 * HOUR);

		await t.mutation(api.today.state.markSeen, { at: now - HOUR });
		await t.mutation(api.today.state.markSeen, { at: now - 2 * HOUR }); // backwards: ignored
		const moved = await t.query(api.today.state.get, {});
		expect(moved).toMatchObject({ seenAt: now - HOUR, isFallback: false });

		await t.mutation(api.today.state.markSeen, { at: now });
		expect((await t.query(api.today.state.get, {})).previousSeenAt).toBe(now - HOUR);
		await t.mutation(api.today.state.undoMarkSeen, {});
		expect((await t.query(api.today.state.get, {})).seenAt).toBe(now - HOUR);
		expect((await t.mutation(api.today.state.undoMarkSeen, {})).restored).toBe(false);

		// Another member's watermark is independent.
		setSession('user-B');
		expect((await t.query(api.today.state.get, { now })).isFallback).toBe(true);
	});
});

describe('today digest', () => {
	it('sorts mail into changed, arrived and filed; needs-reply goes to the queue', async () => {
		const t = convexTest(schema, modules);
		setSession('user-A');
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		const now = Date.now();
		const since = now - 3 * HOUR;

		const known = await threadOf(
			t,
			await seedMessage(t, mailboxId, { subject: 'Renewal', receivedAt: now - 5 * HOUR })
		);
		await t.mutation(api.mail.threadVisits.recordVisit, { threadId: known });
		await t.run(async (ctx) => {
			const visit = await ctx.db.query('mailThreadVisits').first();
			if (visit) await ctx.db.patch(visit._id, { visitedAt: now - 4 * HOUR });
		});
		await addReply(t, known, now - HOUR);

		await threadOf(
			t,
			await seedMessage(t, mailboxId, { subject: 'Brand assets', receivedAt: now - 2 * HOUR })
		);
		const newsletter = await threadOf(
			t,
			await seedMessage(t, mailboxId, { subject: 'Weekly digest', receivedAt: now - HOUR })
		);
		await t.run(async (ctx) =>
			ctx.db.patch(newsletter, {
				category: { label: 'newsletter', source: 'heuristic', classifiedAt: now },
			})
		);
		const ask = await threadOf(
			t,
			await seedMessage(t, mailboxId, { subject: 'Can you call?', receivedAt: now - HOUR })
		);
		await t.run(async (ctx) => {
			const message = await ctx.db
				.query('mailMessages')
				.withIndex('by_thread', (q) => q.eq('threadId', ask))
				.first();
			await ctx.db.patch(ask, {
				needsReply: {
					messageId: message!._id,
					detectedAt: now,
					source: 'heuristic',
					urgency: 'normal',
				},
			});
		});
		await seedMessage(t, mailboxId, { subject: 'Old news', receivedAt: now - 10 * HOUR });

		const digest = await t.query(api.today.mailbox.digest, { mailboxId, since });
		expect(digest).not.toBeNull();
		expect(digest!.changed.map((c) => c.subject)).toEqual(['Renewal']);
		expect(digest!.changed[0]!.newMessages).toBe(1);
		expect(digest!.changed[0]!.sources).toHaveLength(1);
		expect(digest!.arrived.map((a) => a.subject)).toEqual(['Brand assets']);
		expect(digest!.filed.newsletter).toBe(1);
		expect(digest!.newMail).toBe(4);
	});

	it('returns null for a mailbox the caller cannot open', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'user-A' });
		await seedFolder(t, mailboxId);
		setSession('user-B');
		expect(await t.query(api.today.mailbox.digest, { mailboxId, since: 0 })).toBeNull();
		expect(await t.query(api.today.mailbox.sidebarThreads, { mailboxId, limit: 3 })).toBeNull();
	});
});

describe('sidebar threads', () => {
	it('gives one status per row and carries hidden urgency', async () => {
		const t = convexTest(schema, modules);
		setSession('user-A');
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		const now = Date.now();
		const urgent = await threadOf(
			t,
			await seedMessage(t, mailboxId, { subject: 'Old ask', receivedAt: now - 9 * HOUR })
		);
		await t.run(async (ctx) => {
			const message = await ctx.db
				.query('mailMessages')
				.withIndex('by_thread', (q) => q.eq('threadId', urgent))
				.first();
			await ctx.db.patch(urgent, {
				needsReply: {
					messageId: message!._id,
					detectedAt: now,
					source: 'heuristic',
					urgency: 'high',
				},
			});
		});
		const seen = await threadOf(
			t,
			await seedMessage(t, mailboxId, { subject: 'Seen', receivedAt: now - 3 * HOUR })
		);
		await t.mutation(api.mail.threadVisits.recordVisit, { threadId: seen });
		await t.run(async (ctx) => {
			const visit = await ctx.db.query('mailThreadVisits').first();
			if (visit) await ctx.db.patch(visit._id, { visitedAt: now - 2 * HOUR });
		});
		await addReply(t, seen, now - HOUR);
		await threadOf(
			t,
			await seedMessage(t, mailboxId, { subject: 'Fresh', receivedAt: now - 30 * 60 * 1000 })
		);

		const result = await t.query(api.today.mailbox.sidebarThreads, { mailboxId, limit: 2 });
		expect(result!.threads.map((r) => [r.subject, r.status])).toEqual([
			['Fresh', null],
			['Seen', 'updated'],
		]);
		expect(result!.hiddenStatus).toBe('needs_you');
		expect(result!.groupStatus).toBe('needs_you');

		// The visit is per member: user-B never opened "Seen".
		await t.run(async (ctx) =>
			ctx.db.insert('mailboxMembers', {
				mailboxId,
				authUserId: 'user-B',
				role: 'member',
				addedBy: 'user-A',
				createdAt: now,
			})
		);
		await t.run(async (ctx) => ctx.db.patch(mailboxId, { scope: 'shared' }));
		setSession('user-B');
		const other = await t.query(api.today.mailbox.sidebarThreads, { mailboxId, limit: 2 });
		expect(other!.threads.find((r) => r.subject === 'Seen')?.status).toBeNull();
	});
});

describe('inbox appearance', () => {
	it('lets an owner rename and recolour, and refuses members', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, {
			userId: 'user-A',
			scope: 'shared',
			address: 'support@owlat.test',
		});
		await t.run(async (ctx) =>
			ctx.db.insert('mailboxMembers', {
				mailboxId,
				authUserId: 'user-B',
				role: 'member',
				addedBy: 'user-A',
				createdAt: Date.now(),
			})
		);
		setSession('user-A');
		await t.mutation(api.mail.mailbox.appearance.setAppearance, {
			mailboxId,
			displayName: ' Support ',
			colorSlot: 1,
		});
		const row = await t.run(async (ctx) => ctx.db.get(mailboxId));
		expect(row).toMatchObject({ displayName: 'Support', colorSlot: 1 });
		await expect(
			t.mutation(api.mail.mailbox.appearance.setAppearance, { mailboxId, colorSlot: 9 })
		).rejects.toThrow();
		await t.mutation(api.mail.mailbox.appearance.setAppearance, { mailboxId, colorSlot: null });
		expect((await t.run(async (ctx) => ctx.db.get(mailboxId)))?.colorSlot).toBeUndefined();

		setSession('user-B');
		await expect(
			t.mutation(api.mail.mailbox.appearance.setAppearance, { mailboxId, displayName: 'Mine now' })
		).rejects.toThrow();
	});
});
