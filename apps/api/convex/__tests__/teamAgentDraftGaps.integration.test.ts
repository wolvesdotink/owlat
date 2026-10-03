/**
 * The team inbox agent's `[[...]]` placeholders (#1185). The draft step stores
 * the gap guard with its draft (`stepOutputs.recordDraftOutput` →
 * `inboundMessages.isDraftGapGuarded`), so a reviewer's Approve is refused
 * (DRAFT_HAS_GAPS) until each gap is filled or deleted, even though the thread
 * has no "Draft with AI" session. A draft without gaps approves as before.
 */
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import {
	createTestContact,
	createTestConversationThread,
	createTestInboundMessage,
} from './factories';

vi.mock('../delivery/workpool', () => ({
	transactionalEmailPool: { enqueueAction: vi.fn().mockResolvedValue(undefined) },
	campaignEmailPool: { enqueueAction: vi.fn().mockResolvedValue(undefined) },
	EMAIL_WORKPOOL_RETRY_BEHAVIOR: { maxAttempts: 1 },
}));

const session = vi.hoisted(() => ({
	userId: 'user-A',
	activeOrganizationId: 'org-1',
	role: 'owner',
}));
vi.mock('../lib/sessionOrganization', async () => ({
	...(await vi.importActual('../lib/sessionOrganization')),
	getMutationContext: vi.fn(async () => ({ ...session })),
	requireAdminContext: vi.fn(async () => ({ ...session })),
	requireOrgMember: vi.fn(async () => ({ ...session })),
	getBetterAuthSessionWithRole: vi.fn(async () => ({ ...session })),
	isActiveOrgMember: vi.fn(async () => true),
}));

const modules = import.meta.glob('../**/*.*s');
type Harness = TestConvex<typeof schema>;

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

/** A message the agent is drafting for, on a thread nobody drafts with AI. */
async function seedMessage(
	t: Harness,
	opts: { threaded?: boolean; status?: string; fields?: Record<string, unknown> } = {}
) {
	return t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			contactCount: 0,
			createdAt: Date.now(),
			defaultFromEmail: 'support@owlat.example',
			defaultFromName: 'Northwind Studio',
		});
		const contactId = await ctx.db.insert(
			'contacts',
			createTestContact({ email: 'jonas@example.com' })
		);
		const { updatedAt: _u, ...thread } = createTestConversationThread({ contactId });
		const threadId = await ctx.db.insert('conversationThreads', thread);
		const { threadId: _t, ...message } = createTestInboundMessage({
			contactId,
			from: 'Jonas Berg <jonas@example.com>',
			to: 'support@owlat.example',
			subject: 'Refund',
			processingStatus: opts.status ?? 'drafting',
			...opts.fields,
		});
		const messageId = await ctx.db.insert('inboundMessages', {
			...message,
			...(opts.threaded === false ? {} : { threadId }),
		});
		return messageId as Id<'inboundMessages'>;
	});
}

/** The draft step's write, then the route step's hold for review. */
async function agentDrafts(
	t: Harness,
	messageId: Id<'inboundMessages'>,
	draftResponse: string,
	draftOptions?: string[]
) {
	await t.mutation(internal.inbox.stepOutputs.recordDraftOutput, {
		inboundMessageId: messageId,
		draftResponse,
		draftSubject: 'Re: Refund',
		confidenceScore: 0.8,
		...(draftOptions ? { draftOptions } : {}),
	});
	await t.run((ctx) => ctx.db.patch(messageId, { processingStatus: 'draft_ready' }));
}

const guardOf = (t: Harness, id: Id<'inboundMessages'>) =>
	t.run(async (ctx) => (await ctx.db.get(id))?.isDraftGapGuarded);

const approve = (t: Harness, id: Id<'inboundMessages'>) =>
	t.mutation(api.inbox.mutations.approveDraft, { inboundMessageId: id });

const gapped = 'Hi Jonas, your refund of [[refund amount]] is on its way.';
const filled = 'Hi Jonas, your refund of 42 EUR is on its way.';
const refused = { data: { category: 'invalid_state', data: { code: 'DRAFT_HAS_GAPS' } } };

describe('an agent draft with [[...]] gaps in the team inbox', () => {
	it('is stored gap-guarded, and Approve is refused until the gap is filled', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seedMessage(t);
		await agentDrafts(t, messageId, gapped);

		expect(await guardOf(t, messageId)).toBe(true);
		await expect(approve(t, messageId)).rejects.toMatchObject(refused);

		// The composer's edit + approve: it carries the stored guard along.
		await t.mutation(api.inbox.mutations.editDraft, {
			inboundMessageId: messageId,
			draftResponse: filled,
			isGapGuarded: true,
		});
		const approved = await approve(t, messageId);
		expect(approved.success).toBe(true);
	});

	it('is refused after an edit that keeps the gap, and sent once the gap is deleted', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seedMessage(t);
		await agentDrafts(t, messageId, gapped);

		// A surface that knows nothing of the guard leaves it as it was.
		await t.mutation(api.inbox.mutations.editDraft, {
			inboundMessageId: messageId,
			draftResponse: `${gapped}\n\nBest, Ada`,
		});
		await expect(approve(t, messageId)).rejects.toMatchObject(refused);

		await t.mutation(api.inbox.mutations.editDraft, {
			inboundMessageId: messageId,
			draftResponse: 'Hi Jonas, your refund is on its way.',
		});
		const approved = await approve(t, messageId);
		expect(approved.success).toBe(true);
	});

	it('approves as before when the draft has no gaps', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seedMessage(t);
		await agentDrafts(t, messageId, filled);

		expect(await guardOf(t, messageId)).toBe(false);
		const approved = await approve(t, messageId);
		expect(approved.success).toBe(true);
	});

	it('does not count a [[...]] in the quoted original', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seedMessage(t);
		await agentDrafts(t, messageId, `${filled}\n\n> Can you check [[ticket 12]]?`);

		expect(await guardOf(t, messageId)).toBe(false);
		const approved = await approve(t, messageId);
		expect(approved.success).toBe(true);
	});

	it('clears the guard when the agent drafts again without gaps', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seedMessage(t);
		await agentDrafts(t, messageId, gapped);
		await agentDrafts(t, messageId, filled);

		expect(await guardOf(t, messageId)).toBe(false);
	});

	it('guards a gap in an offered variant, so picking it cannot send the gap', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seedMessage(t);
		await agentDrafts(t, messageId, filled, [filled, gapped]);
		expect(await guardOf(t, messageId)).toBe(true);

		// The review queue's option pick: edit to the variant, then approve.
		await t.mutation(api.inbox.mutations.editDraft, {
			inboundMessageId: messageId,
			draftResponse: gapped,
		});
		await expect(approve(t, messageId)).rejects.toMatchObject(refused);
	});

	it('refuses the gap on a message with no thread too', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seedMessage(t, { threaded: false });
		await agentDrafts(t, messageId, gapped);

		await expect(approve(t, messageId)).rejects.toMatchObject(refused);
	});

	it('drops the guard with the draft when a person reopens a rejected message', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seedMessage(t, {
			status: 'rejected',
			fields: { draftResponse: gapped, isDraftGapGuarded: true },
		});

		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: { to: 'draft_ready', at: Date.now(), manualTakeover: true },
		});

		const message = await t.run((ctx) => ctx.db.get(messageId));
		expect(message?.processingStatus).toBe('draft_ready');
		expect(message?.draftResponse).toBeUndefined();
		expect(message?.isDraftGapGuarded).toBeUndefined();
	});
});
