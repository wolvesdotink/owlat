/**
 * mail.needsReplyPrepared.getPreparedDraft: the reply the AI already wrote for
 * one flagged thread (the Reply Queue's clarification draft and the
 * draft-on-arrival slot), read per thread for Answer mode instead of through
 * the whole mailbox's queue. Nothing for a thread without the flag, and
 * nothing from a mailbox the caller cannot read.
 */
import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import { modules, seedFolder, seedMailbox, seedMessage } from './helpers.testlib';

const sessionMocks = vi.hoisted(() => ({ userId: 'user-A' }));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = async () => ({
		userId: sessionMocks.userId,
		role: 'editor' as const,
		activeOrganizationId: 'org-1',
	});
	return {
		...actual,
		requireOrgMember: vi.fn(session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(session),
		getBetterAuthSessionWithRole: vi.fn(session),
	};
});

beforeEach(() => {
	sessionMocks.userId = 'user-A';
});

async function seedFlaggedThread(
	t: ReturnType<typeof convexTest>,
	flag: { clarificationDraft?: string; slotDraft?: string } | null
): Promise<Id<'mailThreads'>> {
	const mailboxId = await seedMailbox(t, { userId: 'user-A' });
	await seedFolder(t, mailboxId);
	const messageId = await seedMessage(t, mailboxId, { subject: 'Invoice' });
	let threadId!: Id<'mailThreads'>;
	await t.run(async (ctx) => {
		const message = await ctx.db.get(messageId);
		threadId = message!.threadId!;
		if (!flag) return;
		const now = Date.now();
		await ctx.db.patch(threadId, {
			needsReply: {
				messageId,
				detectedAt: now,
				source: 'llm',
				urgency: 'normal',
				...(flag.clarificationDraft !== undefined
					? {
							clarification: {
								isNeeded: false,
								questions: [],
								askedAt: now,
								answeredAt: now,
								draft: flag.clarificationDraft,
							},
						}
					: {}),
				...(flag.slotDraft !== undefined
					? { draftSlot: { draft: flag.slotDraft, confidence: 0.8, generatedAt: now } }
					: {}),
			},
		});
	});
	return threadId;
}

describe('mail.needsReplyPrepared.getPreparedDraft', () => {
	it("returns the thread's clarification draft and draft slot", async () => {
		const t = convexTest(schema, modules);
		const threadId = await seedFlaggedThread(t, {
			clarificationDraft: '  Hi Jonas, attached.  ',
			slotDraft: 'Hi Jonas, here it is.',
		});
		expect(await t.query(api.mail.needsReplyPrepared.getPreparedDraft, { threadId })).toEqual({
			clarificationDraft: 'Hi Jonas, attached.',
			slotDraft: 'Hi Jonas, here it is.',
		});
	});

	it('returns nulls for a flag without drafts, and null for an unflagged thread', async () => {
		const t = convexTest(schema, modules);
		const flagged = await seedFlaggedThread(t, {});
		expect(
			await t.query(api.mail.needsReplyPrepared.getPreparedDraft, { threadId: flagged })
		).toEqual({ clarificationDraft: null, slotDraft: null });
		const plain = await seedFlaggedThread(t, null);
		expect(
			await t.query(api.mail.needsReplyPrepared.getPreparedDraft, { threadId: plain })
		).toBeNull();
	});

	it('reads nothing from a mailbox the caller cannot open', async () => {
		const t = convexTest(schema, modules);
		const threadId = await seedFlaggedThread(t, { slotDraft: 'Private draft' });
		sessionMocks.userId = 'user-B';
		expect(await t.query(api.mail.needsReplyPrepared.getPreparedDraft, { threadId })).toBeNull();
	});
});
