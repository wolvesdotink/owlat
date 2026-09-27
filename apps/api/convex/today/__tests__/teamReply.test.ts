/**
 * A teammate answers a team-inbox conversation: every other member's
 * Workbench follows.
 *
 *   - the Answer queue drops the thread for everyone (the flag lives on the
 *     shared thread, and the real send path clears it);
 *   - the digest does not list the answered thread as a new arrival;
 *   - a verdict the classifier was still computing when the teammate answered
 *     from their personal address does not bring the flag back.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api, internal } from '../../_generated/api';
import {
	modules,
	seedFolder,
	seedMailbox,
	seedMessage,
} from '../../mail/__tests__/helpers.testlib';

const sessionMock = vi.hoisted(() => ({
	userId: 'user-C',
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
			return session()!;
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

const HOUR = 60 * 60 * 1000;
const TEAM = 'team@owlat.test';

async function addMember(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>,
	authUserId: string
) {
	await t.run((ctx) =>
		ctx.db.insert('mailboxMembers', {
			mailboxId,
			authUserId,
			role: 'member',
			addedBy: 'owner-user',
			createdAt: Date.now(),
		})
	);
}

/** A team inbox with members B and C, and one flagged customer question. */
async function seedTeamQuestion(t: TestConvex<typeof schema>) {
	const team = await seedMailbox(t, { userId: 'owner-user', address: TEAM, scope: 'shared' });
	await seedFolder(t, team);
	await seedFolder(t, team, 'sent');
	await addMember(t, team, 'user-B');
	await addMember(t, team, 'user-C');
	const messageId = await seedMessage(t, team, {
		subject: 'Can you ship to Vienna?',
		fromAddress: 'nora@example.com',
		receivedAt: Date.now() - HOUR,
	});
	const threadId = await t.run(async (ctx) => {
		const message = await ctx.db.get(messageId);
		const threadId = message!.threadId;
		await ctx.db.patch(threadId, {
			latestMessageId: messageId,
			category: { label: 'person', source: 'llm', classifiedAt: Date.now() },
			needsReply: {
				messageId,
				detectedAt: Date.now(),
				source: 'heuristic',
				urgency: 'normal',
			},
		});
		return threadId;
	});
	return { team, threadId, messageId };
}

/** Send a reply through the real draft lifecycle, as teammate B. */
async function sendReply(
	t: TestConvex<typeof schema>,
	fields: {
		mailboxId: Id<'mailboxes'>;
		threadId: Id<'mailThreads'>;
		fromAddress: string;
		sendAsMailboxId?: Id<'mailboxes'>;
	}
) {
	const draftId = await t.run((ctx) =>
		ctx.db.insert('mailDrafts', {
			...fields,
			sentByUserId: 'user-B',
			toAddresses: ['nora@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			subject: 'Re: Can you ship to Vienna?',
			bodyHtml: '<p>Yes</p>',
			bodyText: 'Yes',
			attachments: [],
			state: 'pending_send',
			lastEditedAt: Date.now(),
			createdAt: Date.now(),
		})
	);
	const rawStorageId = await t.run((ctx) => ctx.storage.store(new Blob(['raw'])));
	await t.mutation(internal.mail.draftLifecycle.transition, {
		draftId,
		input: {
			to: 'sent' as const,
			at: Date.now(),
			context: {
				rawStorageId,
				rawSize: 3,
				rfc822MessageId: 'reply-1@owlat.test',
				references: [],
				bodyHtml: '<p>Yes</p>',
				bodyText: 'Yes',
				attachmentsMeta: [],
			},
		},
	});
}

async function viewAs(t: TestConvex<typeof schema>, mailboxId: Id<'mailboxes'>) {
	sessionMock.userId = 'user-C';
	const since = Date.now() - 6 * HOUR;
	return {
		queue: await t.query(api.mail.needsReply.listQueue, { mailboxId }),
		digest: await t.query(api.today.mailbox.digest, { mailboxId, since }),
		sidebar: await t.query(api.today.mailbox.sidebarThreads, { mailboxId, limit: 5 }),
	};
}

describe('a teammate answers a team-inbox thread', () => {
	it('clears the thread from the other members’ Answer queue and digest', async () => {
		const t = convexTest(schema, modules);
		const { team, threadId } = await seedTeamQuestion(t);

		const before = await viewAs(t, team);
		expect(before.queue.items.map((i) => i.threadId)).toEqual([threadId]);
		expect(before.sidebar!.threads[0]).toMatchObject({ threadId, status: 'needs_you' });

		await sendReply(t, { mailboxId: team, threadId, fromAddress: TEAM });

		const after = await viewAs(t, team);
		expect(after.queue.items).toEqual([]);
		expect(after.digest!.arrived).toEqual([]);
		expect(after.digest!.arrivedTotal).toBe(0);
		// The sidebar pill goes with it: nothing is waiting on C any more.
		expect(after.sidebar!.threads[0]).toMatchObject({ threadId, status: null });
		expect(after.sidebar!.groupStatus).toBeNull();
	});

	it('keeps the thread in "What changed" for a member who had read it', async () => {
		const t = convexTest(schema, modules);
		const { team, threadId } = await seedTeamQuestion(t);
		sessionMock.userId = 'user-C';
		await t.mutation(api.mail.threadVisits.recordVisit, { threadId });

		await sendReply(t, { mailboxId: team, threadId, fromAddress: TEAM });

		const { queue, digest } = await viewAs(t, team);
		expect(queue.items).toEqual([]);
		expect(digest!.arrived).toEqual([]);
		expect(digest!.changed.map((c) => c.threadId)).toEqual([threadId]);
	});

	it('does not re-flag a thread a teammate answered from their personal address mid-classification', async () => {
		const t = convexTest(schema, modules);
		const { team, threadId, messageId } = await seedTeamQuestion(t);
		const personal = await seedMailbox(t, { userId: 'user-B', address: 'b@owlat.test' });
		await seedFolder(t, personal, 'sent');
		const context = await t.query(internal.mail.needsReply.getThreadContext, { threadId });

		await sendReply(t, {
			mailboxId: team,
			threadId,
			fromAddress: 'b@owlat.test',
			sendAsMailboxId: personal,
		});
		// The classifier started before the reply and lands after it.
		await t.mutation(internal.mail.needsReply.applyResult, {
			threadId,
			expectedLatestMessageId: context!.latestMessageId,
			needsReply: { messageId, source: 'heuristic', urgency: 'normal' },
		});

		const { queue, digest } = await viewAs(t, team);
		expect(queue.items).toEqual([]);
		expect(digest!.arrived).toEqual([]);
		const thread = await t.run((ctx) => ctx.db.get(threadId));
		expect(thread?.needsReply).toBeUndefined();
	});
});
