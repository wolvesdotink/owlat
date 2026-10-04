/**
 * A new agent draft starts without the edits a person saved over an earlier
 * one (#1201). Left in place, the old `draftRevisions` / `draftSavedAt` /
 * `isDraftEdited` made the untouched draft look edited: saved-first in the
 * queue, diffed against the old draft, an `'edited'` autonomy signal on an
 * unchanged approve, and no `clarification_unedited_send`. Reopening a rejected
 * message drops its draft and, with it, the edits saved over that draft.
 *
 * The path #1201 found, Retry after a failed send of the edit, no longer
 * re-drafts at all: it sends the approved text again (#1220,
 * retryKeepsApprovedText.test.ts). The re-draft below is driven directly.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = { userId: 'reviewer-1', role: 'owner' };
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue(session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('reviewer-1'),
		getMutationContext: vi.fn().mockResolvedValue(session),
		requireOrgPermission: vi.fn().mockResolvedValue(session),
		requireAdminContext: vi.fn().mockResolvedValue(session),
	};
});

// See draftRevisions.test.ts: the `../../**` glob omits the `inbox/` dir it
// climbed through, so merge a second glob rooted at `inbox/`.
const rootGlob = import.meta.glob('../../**/*.*s');
const inboxGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../inbox/'),
		mod,
	])
);
const modules = Object.fromEntries(
	Object.entries({ ...rootGlob, ...inboxGlob }).filter(
		([path]) =>
			!path.includes('agent/walker') &&
			!path.includes('agent/steps/') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('llmProvider')
	)
);

type Harness = ReturnType<typeof convexTest>;

// The reopen schedules work; none of it may run here.
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

const FIRST_DRAFT = 'Thanks for writing. Your refund is on its way.';
const EDIT = 'Thanks for writing, Jonas. Your refund of 42 EUR is on its way.';
const SECOND_DRAFT = 'Hi Jonas, the refund of 42 EUR left today.';

async function seed(t: Harness, fields: Record<string, unknown> = {}) {
	return t.run(async (ctx) => {
		await ctx.db.insert('agentConfig', {
			isAutoReplyEnabled: true,
			confidenceThreshold: 0.8,
			humanApproveUndoDelayMs: 15_000,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		return (await ctx.db.insert('inboundMessages', {
			messageId: 'msg-1201',
			from: 'jonas@example.com',
			to: 'support@owlat.app',
			subject: 'Refund',
			textBody: 'Where is my refund?',
			processingStatus: 'draft_ready',
			draftResponse: FIRST_DRAFT,
			draftSubject: 'Re: Refund',
			receivedAt: Date.now(),
			...fields,
		})) as Id<'inboundMessages'>;
	});
}

const getMessage = (t: Harness, id: Id<'inboundMessages'>): Promise<Doc<'inboundMessages'>> =>
	t.run(async (ctx) => (await ctx.db.get(id))!);

const save = (t: Harness, id: Id<'inboundMessages'>, text: string) =>
	t.mutation(api.inbox.draftRevisions.saveDraftRevision, {
		inboundMessageId: id,
		draftResponse: text,
	});

async function feedback(t: Harness) {
	return t.run(async (ctx) =>
		(await ctx.db.query('autonomyFeedback').collect()).map((f) => f.outcomeSignal ?? f.action)
	);
}

/** Save an edit, then let the agent draft the message again. */
async function saveThenRedraft(t: Harness, id: Id<'inboundMessages'>) {
	await save(t, id, EDIT);

	// A pipeline run reaching the draft step again: the draft step's write and
	// the route step's hold for review.
	await t.run((ctx) => ctx.db.patch(id, { processingStatus: 'drafting' }));
	await t.mutation(internal.inbox.stepOutputs.recordDraftOutput, {
		inboundMessageId: id,
		draftResponse: SECOND_DRAFT,
		draftSubject: 'Re: Refund',
		confidenceScore: 0.8,
	});
	const held = await t.mutation(internal.inbox.processingLifecycle.transition, {
		inboundMessageId: id,
		input: { to: 'draft_ready', at: Date.now() },
	});
	expect(held).toMatchObject({ ok: true });
}

describe('a re-draft after a saved edit', () => {
	it('starts the new agent draft without the old saved edits', async () => {
		const t = convexTest(schema, modules);
		const id = await seed(t);

		await save(t, id, EDIT);
		const saved = await getMessage(t, id);
		expect(saved.draftRevisions).toHaveLength(2);
		expect(saved.isDraftEdited).toBe(true);
		expect(saved.draftSavedAt).toBeTypeOf('number');

		await saveThenRedraft(t, id);

		const redrafted = await getMessage(t, id);
		expect(redrafted.processingStatus).toBe('draft_ready');
		expect(redrafted.draftResponse).toBe(SECOND_DRAFT);
		expect(redrafted.draftRevisions).toBeUndefined();
		expect(redrafted.draftSavedAt).toBeUndefined();
		expect(redrafted.isDraftEdited).toBeUndefined();
	});

	it('records no edited signal when the new draft is approved unchanged', async () => {
		const t = convexTest(schema, modules);
		// The first draft answered the agent's clarification questions, so an
		// unedited send is the strong outcome signal.
		const id = await seed(t, {
			classification: {
				category: 'support',
				priority: 'normal',
				sentiment: 'neutral',
				intent: 'question',
				confidence: 0.8,
			},
			pendingClarification: { questions: [], askedAt: 1, answeredAt: 2 },
		});
		await saveThenRedraft(t, id);

		await t.mutation(api.inbox.mutations.approveDraft, { inboundMessageId: id });
		await t.mutation(internal.inbox.decisionFeedback.recordApprovalSignalsAtSend, {
			inboundMessageId: id,
		});

		expect(await feedback(t)).toEqual(['approved', 'clarification_unedited_send']);
	});

	it('seeds the new agent draft as revision 0 on the first save after it', async () => {
		const t = convexTest(schema, modules);
		const id = await seed(t);
		await saveThenRedraft(t, id);

		await save(t, id, 'Hi Jonas, the refund of 42 EUR left today. Best, Ada');

		const message = await getMessage(t, id);
		expect(message.draftRevisions?.map((r) => [r.savedBy, r.text])).toEqual([
			['agent', SECOND_DRAFT],
			['reviewer-1', 'Hi Jonas, the refund of 42 EUR left today. Best, Ada'],
		]);
		expect(message.isDraftEdited).toBe(true);
	});
});

describe('reopening a rejected message with a saved edit', () => {
	it('leaves no saved edits behind with the dropped draft', async () => {
		const t = convexTest(schema, modules);
		const id = await seed(t);
		await save(t, id, EDIT);
		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: id,
			input: { to: 'rejected', at: Date.now(), userId: 'reviewer-1' },
		});

		await t.mutation(api.inbox.manualReply.takeOverReply, { inboundMessageId: id });

		const reopened = await getMessage(t, id);
		expect(reopened.processingStatus).toBe('draft_ready');
		expect(reopened.draftResponse).toBeUndefined();
		expect(reopened.draftRevisions).toBeUndefined();
		expect(reopened.draftSavedAt).toBeUndefined();
		expect(reopened.isDraftEdited).toBeUndefined();
	});
});
