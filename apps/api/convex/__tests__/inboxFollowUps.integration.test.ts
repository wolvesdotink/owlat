import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import {
	createTestContact,
	createTestConversationThread,
	createTestInboundMessage,
} from './factories';
import { FOLLOW_UP_LIFECYCLE, followUpRefusal } from '../inbox/followUps';

// The follow-up enqueues a `team_reply` Send on the transactional workpool.
// Stub the pool so nothing is dispatched and the envelope can be inspected.
const { enqueueActionMock } = vi.hoisted(() => ({
	enqueueActionMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../delivery/workpool', () => ({
	transactionalEmailPool: { enqueueAction: enqueueActionMock },
	campaignEmailPool: { enqueueAction: vi.fn().mockResolvedValue(undefined) },
	EMAIL_WORKPOOL_RETRY_BEHAVIOR: { maxAttempts: 1 },
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	const fromIdentity = async (ctx: MutationCtx) => {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw new Error('Not authenticated');
		return { userId: identity.subject, role: 'owner' };
	};
	return {
		...actual,
		getMutationContext: vi.fn(fromIdentity),
		requireAdminContext: vi.fn(fromIdentity),
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			userId: 'test-user-123',
			activeOrganizationId: 'org_1',
			role: 'owner',
		})),
	};
});

const modules = import.meta.glob('../**/*.*s');

const testIdentity = {
	subject: 'test-user-123',
	issuer: 'https://test.issuer.com',
	tokenIdentifier: 'https://test.issuer.com|test-user-123',
};

beforeEach(() => {
	vi.useFakeTimers();
	enqueueActionMock.mockClear();
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

/**
 * #807 — a person writes again on a Team inbox thread whose latest message was
 * already answered. The answered message stays `sent`; the follow-up gets its
 * own row, undo window and `team_reply` Send.
 */
describe('followUpRefusal', () => {
	it('takes a follow-up only once the latest message was answered, on email', () => {
		expect(followUpRefusal({ processingStatus: 'sent', to: 'support@example.com' })).toBeNull();
		expect(followUpRefusal({ processingStatus: 'draft_ready', to: 'a@example.com' })).toMatch(
			/not been answered/
		);
		expect(followUpRefusal({ processingStatus: 'sent', to: 'whatsapp' })).toMatch(/email/);
	});

	it('never leaves a terminal state', () => {
		for (const state of ['sent', 'failed', 'cancelled'] as const) {
			expect(FOLLOW_UP_LIFECYCLE.isTerminal(state)).toBe(true);
		}
		expect(FOLLOW_UP_LIFECYCLE.isLegalEdge('sending', 'cancelled')).toBe(false);
	});
});

describe('inbox follow-ups', () => {
	async function seed(
		t: ReturnType<typeof convexTest>,
		status = 'sent',
		options: { withSender?: boolean } = {}
	) {
		return await t.run(async (ctx) => {
			if (options.withSender !== false) {
				await ctx.db.insert('instanceSettings', {
					contactCount: 0,
					createdAt: Date.now(),
					defaultFromEmail: 'support@owlat.example',
					defaultFromName: 'Northwind Studio',
				});
			}
			const contactId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'jonas@example.com' })
			);
			const {
				updatedAt: _u,
				channel: _c,
				...thread
			} = createTestConversationThread({
				contactId,
			});
			const threadId = await ctx.db.insert('conversationThreads', thread);
			const messageId = await ctx.db.insert(
				'inboundMessages',
				createTestInboundMessage({
					threadId,
					contactId,
					from: 'Jonas Berg <jonas@example.com>',
					to: 'support@owlat.example',
					subject: 'CSV export',
					messageId: '<q2-export@example.com>',
					processingStatus: status,
					draftResponse: 'Yes, use Export → CSV.',
					draftSubject: 'Re: CSV export',
				})
			);
			return { threadId, messageId: messageId as Id<'inboundMessages'> };
		});
	}

	it('refuses a follow-up while the latest message still has its own reply to give', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seed(t, 'draft_ready');
		await expect(
			t.withIdentity(testIdentity).mutation(api.inbox.followUps.sendFollowUp, {
				threadId,
				body: 'One more thing',
				subject: '',
			})
		).rejects.toThrow(/not been answered/);
	});

	it('schedules the follow-up behind the undo window, leaving the answered message alone', async () => {
		const t = convexTest(schema, modules);
		const { threadId, messageId } = await seed(t);

		const result = await t.withIdentity(testIdentity).mutation(api.inbox.followUps.sendFollowUp, {
			threadId,
			body: '  Both variants are in the CSV.  ',
			subject: '',
		});
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.undo?.sendAt).toBeGreaterThan(Date.now());

		const [followUp, message, audit] = await t.run(async (ctx) => [
			await ctx.db.get(result.followUpId),
			await ctx.db.get(messageId),
			await ctx.db.query('auditLogs').collect(),
		]);
		expect(followUp).toMatchObject({
			status: 'scheduled',
			body: 'Both variants are in the CSV.',
			// Blank subject → the answered reply's subject.
			subject: 'Re: CSV export',
			createdBy: 'test-user-123',
			inReplyToMessageId: messageId,
		});
		expect(message?.processingStatus).toBe('sent');
		expect(message?.draftResponse).toBe('Yes, use Export → CSV.');
		expect(audit.map((row) => row.action)).toContain('inbound.follow_up_sent');
		expect(enqueueActionMock).not.toHaveBeenCalled();
	});

	it('sends a threaded team_reply once the window closes, and finishes on delivery', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seed(t);
		const result = await t
			.withIdentity(testIdentity)
			.mutation(api.inbox.followUps.sendFollowUp, { threadId, body: 'Both.', subject: '' });
		if (!result.success) throw new Error('expected a scheduled follow-up');

		await t.mutation(internal.inbox.followUps.dispatch, { followUpId: result.followUpId });

		const followUp = await t.run((ctx) => ctx.db.get(result.followUpId));
		expect(followUp?.status).toBe('sending');
		const send = await t.run((ctx) => ctx.db.get(followUp!.sendId!));
		expect(send).toMatchObject({
			kind: 'team_reply',
			email: 'jonas@example.com',
			followUpId: result.followUpId,
		});
		const envelope = enqueueActionMock.mock.calls[0]?.[2]?.envelopeInput;
		expect(envelope?.headers).toMatchObject({ 'In-Reply-To': '<q2-export@example.com>' });
		expect(envelope?.template?.htmlContent).toContain('Both.');

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'transactional', id: followUp!.sendId! },
			transition: { to: 'sent', at: Date.now(), providerMessageId: 'prov-1' },
		});
		const done = await t.run((ctx) => ctx.db.get(result.followUpId));
		expect(done?.status).toBe('sent');
		expect(done?.sentAt).toBeTypeOf('number');
	});

	it('undoes inside the window and hands the text back; the dispatch then does nothing', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seed(t);
		const asUser = t.withIdentity(testIdentity);
		const result = await asUser.mutation(api.inbox.followUps.sendFollowUp, {
			threadId,
			body: 'Oops, wrong thread',
			subject: 'Re: CSV export',
		});
		if (!result.success) throw new Error('expected a scheduled follow-up');

		const undone = await asUser.mutation(api.inbox.followUps.cancelFollowUp, {
			followUpId: result.followUpId,
		});
		expect(undone).toEqual({
			cancelled: true,
			body: 'Oops, wrong thread',
			subject: 'Re: CSV export',
		});
		await t.mutation(internal.inbox.followUps.dispatch, { followUpId: result.followUpId });

		const followUp = await t.run((ctx) => ctx.db.get(result.followUpId));
		expect(followUp?.status).toBe('cancelled');
		expect(enqueueActionMock).not.toHaveBeenCalled();
		// Undone follow-ups are left out of the thread view.
		expect(await asUser.query(api.inbox.followUps.listForThread, { threadId })).toEqual([]);
	});

	it('fails with a reason when there is no sending identity', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seed(t, 'sent', { withSender: false });
		const result = await t
			.withIdentity(testIdentity)
			.mutation(api.inbox.followUps.sendFollowUp, { threadId, body: 'Hello', subject: '' });
		if (!result.success) throw new Error('expected a scheduled follow-up');

		await t.mutation(internal.inbox.followUps.dispatch, { followUpId: result.followUpId });
		const followUp = await t.run((ctx) => ctx.db.get(result.followUpId));
		expect(followUp?.status).toBe('failed');
		expect(followUp?.errorMessage).toMatch(/sending identity/);
	});

	it('holds while a teammate is replying on the thread', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seed(t);
		await t.run((ctx) =>
			ctx.db.insert('threadPresence', {
				threadId,
				userId: 'teammate-9',
				mode: 'replying',
				heartbeatAt: Date.now(),
			})
		);
		const result = await t
			.withIdentity(testIdentity)
			.mutation(api.inbox.followUps.sendFollowUp, { threadId, body: 'Hi', subject: '' });
		expect(result).toMatchObject({ success: false, reason: 'reply_in_progress' });
		expect(await t.run((ctx) => ctx.db.query('inboxFollowUps').collect())).toHaveLength(0);
	});
});
