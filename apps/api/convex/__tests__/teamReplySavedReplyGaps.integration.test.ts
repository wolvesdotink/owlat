/**
 * A saved reply's `[[...]]` gaps in a Team inbox reply. The guard is stored
 * with the working draft (`inboundMessages.isDraftGapGuarded`), so it survives
 * a save and a reload, and `approveDraft` refuses it like an AI draft's gaps
 * even though the thread has no "Draft with AI" session. A follow-up has no
 * stored draft, so the composer's guard rides the send.
 */
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
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

/** A thread with one inbound message in `status` and nobody drafting with AI. */
async function seedThread(t: Harness, status = 'draft_ready') {
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
		const messageId = await ctx.db.insert(
			'inboundMessages',
			createTestInboundMessage({
				threadId,
				contactId,
				from: 'Jonas Berg <jonas@example.com>',
				to: 'support@owlat.example',
				subject: 'Order status',
				processingStatus: status,
				draftResponse: 'Thanks for writing.',
				draftSubject: 'Re: Order status',
			})
		);
		return { threadId, messageId: messageId as Id<'inboundMessages'> };
	});
}

const gapped = 'Hi Jonas, your order [[order number]] ships today.';
const filled = 'Hi Jonas, your order 4711 ships today.';
const refused = { data: { category: 'invalid_state', data: { code: 'DRAFT_HAS_GAPS' } } };

describe('a saved reply gap in a Team inbox reply', () => {
	it('is stored with the saved draft, and approving it is refused until filled', async () => {
		const t = convexTest(schema, modules);
		const { messageId } = await seedThread(t);

		await t.mutation(api.inbox.draftRevisions.saveDraftRevision, {
			inboundMessageId: messageId,
			draftResponse: gapped,
			isGapGuarded: true,
		});
		const saved = await t.run((ctx) => ctx.db.get(messageId));
		expect(saved?.isDraftGapGuarded).toBe(true);

		await expect(
			t.mutation(api.inbox.mutations.approveDraft, { inboundMessageId: messageId })
		).rejects.toMatchObject(refused);

		// Filled in and sent (the composer's edit + approve): the guard rides along.
		await t.mutation(api.inbox.mutations.editDraft, {
			inboundMessageId: messageId,
			draftResponse: filled,
			isGapGuarded: true,
		});
		const approved = await t.mutation(api.inbox.mutations.approveDraft, {
			inboundMessageId: messageId,
		});
		expect(approved.success).toBe(true);
	});

	it('is refused through the edit + approve send path too', async () => {
		const t = convexTest(schema, modules);
		const { messageId } = await seedThread(t);
		await t.mutation(api.inbox.mutations.editDraft, {
			inboundMessageId: messageId,
			draftResponse: gapped,
			isGapGuarded: true,
		});
		await expect(
			t.mutation(api.inbox.mutations.approveDraft, { inboundMessageId: messageId })
		).rejects.toMatchObject(refused);
	});

	it('a save without the guard leaves it; one that clears it lets hand-written brackets go', async () => {
		const t = convexTest(schema, modules);
		const { messageId } = await seedThread(t);
		await t.mutation(api.inbox.draftRevisions.saveDraftRevision, {
			inboundMessageId: messageId,
			draftResponse: gapped,
			isGapGuarded: true,
		});
		// A surface that knows nothing of the guard (the review queue's edit).
		await t.mutation(api.inbox.mutations.editDraft, {
			inboundMessageId: messageId,
			draftResponse: `${gapped} `,
		});
		await expect(
			t.mutation(api.inbox.mutations.approveDraft, { inboundMessageId: messageId })
		).rejects.toMatchObject(refused);

		// "Write my own": the person's own double brackets are their text.
		await t.mutation(api.inbox.mutations.editDraft, {
			inboundMessageId: messageId,
			draftResponse: 'See [[wiki link]].',
			isGapGuarded: false,
		});
		const approved = await t.mutation(api.inbox.mutations.approveDraft, {
			inboundMessageId: messageId,
		});
		expect(approved.success).toBe(true);
	});

	it('a follow-up the composer marks as guarded is refused with its gap left', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedThread(t, 'sent');
		await expect(
			t.mutation(api.inbox.followUps.sendFollowUp, {
				threadId,
				body: gapped,
				subject: '',
				isGapGuarded: true,
			})
		).rejects.toMatchObject(refused);

		const sent = await t.mutation(api.inbox.followUps.sendFollowUp, {
			threadId,
			body: filled,
			subject: '',
			isGapGuarded: true,
		});
		expect(sent.success).toBe(true);
	});
});
