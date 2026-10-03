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

		// Writing the variant over the draft: edit to it, then approve.
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

// #1196: `draftOptions` are the variants of one agent draft. Left behind when the
// draft changed, they described a text nobody saw, and the Answer queue card
// approved `draftOptions[0]` over a reviewer's saved edit.
describe("an agent draft's variants", () => {
	const variant = 'Hi Jonas, the refund is on its way.';
	const edited = 'Hi Jonas, I have sent the refund of 42 EUR today. Best, Ada';

	// The whole row comes back: a bare `undefined` from `t.run` arrives as null.
	const optionsOf = async (t: Harness, id: Id<'inboundMessages'>) =>
		(await t.run((ctx) => ctx.db.get(id)))?.draftOptions;

	it('are dropped when a reviewer saves an edit', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seedMessage(t);
		await agentDrafts(t, messageId, filled, [filled, variant]);
		expect(await optionsOf(t, messageId)).toEqual([filled, variant]);

		await t.mutation(api.inbox.draftRevisions.saveDraftRevision, {
			inboundMessageId: messageId,
			draftResponse: edited,
		});

		expect(await optionsOf(t, messageId)).toBeUndefined();
	});

	it('are dropped by an edit through editDraft too', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seedMessage(t);
		await agentDrafts(t, messageId, filled, [filled, variant]);

		await t.mutation(api.inbox.mutations.editDraft, {
			inboundMessageId: messageId,
			draftResponse: edited,
		});

		expect(await optionsOf(t, messageId)).toBeUndefined();
		// Approve sends the edit, the text the reviewer saved.
		expect((await approve(t, messageId)).success).toBe(true);
		const message = await t.run((ctx) => ctx.db.get(messageId));
		expect(message?.draftResponse).toBe(edited);
	});

	it('are dropped when the agent drafts again without variants', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seedMessage(t);
		await agentDrafts(t, messageId, filled, [filled, variant]);
		await agentDrafts(t, messageId, 'Hi Jonas, the refund went out today.');

		expect(await optionsOf(t, messageId)).toBeUndefined();
	});

	it('leave nothing gapped to approve after a re-draft without gaps', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seedMessage(t);
		await agentDrafts(t, messageId, gapped, [gapped, `${variant} [[date]]`]);
		await agentDrafts(t, messageId, filled);

		const message = await t.run((ctx) => ctx.db.get(messageId));
		expect(message?.isDraftGapGuarded).toBe(false);
		expect(message?.draftOptions).toBeUndefined();
		const stored = [message?.draftResponse ?? '', ...(message?.draftOptions ?? [])];
		expect(stored.filter((text) => text.includes('[['))).toEqual([]);
		expect((await approve(t, messageId)).success).toBe(true);
	});

	it("stay through the route step's hand-off of the same draft, and go with a different one", async () => {
		const t = convexTest(schema, modules);
		const kept = await seedMessage(t);
		await t.mutation(internal.inbox.stepOutputs.recordDraftOutput, {
			inboundMessageId: kept,
			draftResponse: filled,
			draftSubject: 'Re: Refund',
			confidenceScore: 0.5,
			draftOptions: [filled, gapped],
		});
		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: kept,
			input: { to: 'draft_ready', at: Date.now(), draftResponse: filled },
		});
		expect(await optionsOf(t, kept)).toEqual([filled, gapped]);
		// The gapped variant still counts for the guard, as when it was stored.
		expect(await guardOf(t, kept)).toBe(true);

		const replaced = await seedMessage(t);
		await t.mutation(internal.inbox.stepOutputs.recordDraftOutput, {
			inboundMessageId: replaced,
			draftResponse: filled,
			draftSubject: 'Re: Refund',
			confidenceScore: 0.5,
			draftOptions: [filled, gapped],
		});
		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: replaced,
			input: { to: 'draft_ready', at: Date.now(), draftResponse: variant },
		});
		expect(await optionsOf(t, replaced)).toBeUndefined();
		expect(await guardOf(t, replaced)).toBe(false);
	});

	it('are dropped when a person reopens a rejected message', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seedMessage(t, {
			status: 'rejected',
			fields: { draftResponse: filled, draftOptions: [filled, gapped], isDraftGapGuarded: true },
		});

		await t.mutation(api.inbox.manualReply.takeOverReply, { inboundMessageId: messageId });

		const message = await t.run((ctx) => ctx.db.get(messageId));
		expect(message?.processingStatus).toBe('draft_ready');
		expect(message?.draftResponse).toBeUndefined();
		expect(message?.draftOptions).toBeUndefined();
	});
});

// Rolling deploy (#1196): a tab still on the previous web build approves
// `draftOptions[0]` over the shown draft whenever there are two or more, by
// `editDraft` then `approveDraft`. A row stored before the fix can hold a clean
// draft, stale gapped variants and a `false` guard.
describe('a row stored before the variants were cleared', () => {
	const staleGapped = `${gapped}\n`;
	const variant = 'Hi Jonas, the refund is on its way.';

	async function seedLegacyRow(t: Harness, draftOptions: string[]) {
		return seedMessage(t, {
			status: 'draft_ready',
			fields: { draftResponse: filled, draftOptions, isDraftGapGuarded: false },
		});
	}

	const queueRow = async (t: Harness, id: Id<'inboundMessages'>) => {
		const queue = await t.query(api.inbox.queries.getReviewQueue, {});
		return queue.find((entry) => entry.message._id === id)?.message;
	};

	it('reaches the review queue without the variants of a draft it no longer shows', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seedLegacyRow(t, [staleGapped, variant]);

		const row = await queueRow(t, messageId);
		expect(row?.draftResponse).toBe(filled);
		expect(row?.draftOptions).toBeUndefined();
	});

	it('still reaches the queue with the variants of the draft it shows', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seedLegacyRow(t, [filled, variant]);

		expect((await queueRow(t, messageId))?.draftOptions).toEqual([filled, variant]);
	});

	it("refuses the old card's write of a gapped variant, then Approve", async () => {
		const t = convexTest(schema, modules);
		const messageId = await seedLegacyRow(t, [staleGapped, variant]);

		// The old `approveOption`: the variant, trimmed, written over the draft.
		await t.mutation(api.inbox.mutations.editDraft, {
			inboundMessageId: messageId,
			draftResponse: staleGapped.trim(),
		});

		expect(await guardOf(t, messageId)).toBe(true);
		await expect(approve(t, messageId)).rejects.toMatchObject(refused);
	});

	it("keeps the client's guard for a person's own edit that matches no variant", async () => {
		const t = convexTest(schema, modules);
		const messageId = await seedLegacyRow(t, [staleGapped, variant]);

		await t.mutation(api.inbox.mutations.editDraft, {
			inboundMessageId: messageId,
			draftResponse: 'Hi Jonas, your [[order]] ticket is closed and the refund is on its way.',
			isGapGuarded: false,
		});

		expect(await guardOf(t, messageId)).toBe(false);
		expect((await approve(t, messageId)).success).toBe(true);
	});
});
