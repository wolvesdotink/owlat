/**
 * A person's save while the agent can still draft over it takes the reply over
 * (#1221). The thread composer stays open during `drafting`, and Save wrote the
 * reply without the takeover Send does first. The agent's late draft then
 * replaced the saved text and, as a new draft, cleared its revisions. The same
 * held for `awaiting_clarification`, whose questions time out back into
 * drafting. A save in `draft_ready` stays a plain save.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';

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
		([path]) => !path.includes('knowledgeExtraction') && !path.includes('llmProvider')
	)
);

type Harness = ReturnType<typeof convexTest>;
type SaveMutation = 'saveDraftRevision' | 'editDraft';

// Approve, the clarification resume and the lifecycle effects schedule work;
// none of it may run here.
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

const AGENT_DRAFT = 'Thanks for writing. Your refund is on its way.';
const HUMAN_REPLY = 'Hi Jonas, I sent the refund of 42 EUR today.';
const HUMAN_REPLY_2 = 'Hi Jonas, I sent the refund of 42 EUR today. Best, Ada';

async function seed(t: Harness, fields: Record<string, unknown>) {
	return t.run(async (ctx) => {
		await ctx.db.insert('agentConfig', {
			isAutoReplyEnabled: true,
			confidenceThreshold: 0.8,
			humanApproveUndoDelayMs: 15_000,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		const messageId = (await ctx.db.insert('inboundMessages', {
			messageId: 'msg-1221',
			from: 'jonas@example.com',
			to: 'support@owlat.app',
			subject: 'Refund',
			textBody: 'Where is my refund?',
			processingStatus: 'drafting',
			receivedAt: Date.now(),
			...fields,
		})) as Id<'inboundMessages'>;
		// The draft step still in flight.
		const draftActionId = await insertRunningAction(ctx, messageId, 'draft');
		return { messageId, draftActionId };
	});
}

function insertRunningAction(
	ctx: MutationCtx,
	inboundMessageId: Id<'inboundMessages'>,
	actionType: 'draft' | 'route'
) {
	return ctx.db.insert('agentActions', {
		inboundMessageId,
		actionType,
		status: 'running',
		retryCount: 0,
		startedAt: Date.now(),
		createdAt: Date.now(),
	});
}

const getMessage = (t: Harness, id: Id<'inboundMessages'>): Promise<Doc<'inboundMessages'>> =>
	t.run(async (ctx) => (await ctx.db.get(id))!);

const save = (t: Harness, via: SaveMutation, id: Id<'inboundMessages'>, text: string) =>
	via === 'saveDraftRevision'
		? t.mutation(api.inbox.draftRevisions.saveDraftRevision, {
				inboundMessageId: id,
				draftResponse: text,
			})
		: t.mutation(api.inbox.mutations.editDraft, { inboundMessageId: id, draftResponse: text });

/**
 * The draft step finishing the way the walker runs it: `execute` writes its
 * output through `recordDraftOutput`, the step routes `in_state`, and the
 * walker closes the action with `recordStepEnd` before it schedules `route`.
 */
async function draftStepFinishes(
	t: Harness,
	id: Id<'inboundMessages'>,
	draftActionId: Id<'agentActions'>
) {
	await t.mutation(internal.inbox.stepOutputs.recordDraftOutput, {
		inboundMessageId: id,
		draftResponse: AGENT_DRAFT,
		draftSubject: 'Re: Refund',
		confidenceScore: 0.95,
	});
	await t.mutation(internal.inbox.processingLifecycle.recordStepEnd, {
		actionId: draftActionId,
		output: JSON.stringify({ draftResponse: AGENT_DRAFT }),
	});
}

/** The `route` step the draft step hands off to, run by the real walker. */
const routeStepRuns = (t: Harness, id: Id<'inboundMessages'>) =>
	t.action(internal.agent.walker.runStep, {
		inboundMessageId: id,
		kind: 'route',
		input: { inboundMessageId: id, confidence: 0.95, category: 'support' },
	});

/** What the pipeline did after the save: its actions and pending walker runs. */
const pipelineTrace = (t: Harness, id: Id<'inboundMessages'>) =>
	t.run(async (ctx) => ({
		actions: (await ctx.db.query('agentActions').collect())
			.filter((a) => a.inboundMessageId === id)
			.map((a) => a.actionType),
		walkerRuns: (await ctx.db.system.query('_scheduled_functions').collect()).filter(
			(f) => f.name.includes('walker') && f.state.kind === 'pending'
		).length,
	}));

const takeoverAudits = (t: Harness) =>
	t.run(async (ctx) =>
		(await ctx.db.query('auditLogs').collect())
			.filter((a) => a.action === 'inbound.reply_taken_over')
			.map((a) => a.details)
	);

describe.each<SaveMutation>(['saveDraftRevision', 'editDraft'])(
	'a %s while the agent is drafting',
	(via) => {
		it('keeps the saved reply and its revisions when the agent draft lands', async () => {
			const t = convexTest(schema, modules);
			const { messageId, draftActionId } = await seed(t, {});

			await save(t, via, messageId, HUMAN_REPLY);
			await save(t, via, messageId, HUMAN_REPLY_2);
			await draftStepFinishes(t, messageId, draftActionId);
			await routeStepRuns(t, messageId);

			const message = await getMessage(t, messageId);
			expect(message.processingStatus).toBe('draft_ready');
			expect(message.manualTakeoverAt).toBeTypeOf('number');
			expect(message.draftResponse).toBe(HUMAN_REPLY_2);
			expect(message.draftRevisions?.map((r) => [r.savedBy, r.text])).toEqual([
				['reviewer-1', HUMAN_REPLY],
				['reviewer-1', HUMAN_REPLY_2],
			]);
			expect(message.draftSavedAt).toBeTypeOf('number');
			// Route stood down before it began: no route action, no decision, and
			// the walker scheduled nothing further.
			expect(message.agentDecision).toBeUndefined();
			expect(await pipelineTrace(t, messageId)).toEqual({ actions: ['draft'], walkerRuns: 0 });
			expect(await takeoverAudits(t)).toEqual([{ from: 'drafting', via: 'save' }]);
		});

		it('keeps an edit of an agent draft against the route step in flight', async () => {
			const t = convexTest(schema, modules);
			// The draft step wrote its output and the route step is running.
			const { messageId } = await seed(t, {
				draftResponse: AGENT_DRAFT,
				draftSubject: 'Re: Refund',
			});
			const routeActionId = await t.run((ctx) => insertRunningAction(ctx, messageId, 'route'));

			await save(t, via, messageId, HUMAN_REPLY);
			// The route step's auto-send transition lands after the save.
			const autoSend = await t.mutation(internal.inbox.processingLifecycle.transition, {
				inboundMessageId: messageId,
				input: {
					to: 'approved',
					at: Date.now(),
					source: 'auto',
					completedActionId: routeActionId,
				},
			});

			expect(autoSend).toMatchObject({ ok: false, reason: 'taken_over' });
			const routeAction = await t.run(async (ctx) => (await ctx.db.get(routeActionId))!);
			expect(routeAction.status).toBe('abandoned');
			const message = await getMessage(t, messageId);
			expect(message.processingStatus).toBe('draft_ready');
			expect(message.draftResponse).toBe(HUMAN_REPLY);
			expect(message.draftRevisions?.map((r) => [r.savedBy, r.text])).toEqual([
				['agent', AGENT_DRAFT],
				['reviewer-1', HUMAN_REPLY],
			]);
			expect(message.isDraftEdited).toBe(true);
		});
	}
);

describe('a save while the agent waits on its clarification questions', () => {
	it('takes the reply over, so the timed-out resume cannot draft over it', async () => {
		const t = convexTest(schema, modules);
		const { messageId } = await seed(t, {
			processingStatus: 'awaiting_clarification',
			pendingClarification: { questions: [], askedAt: 1 },
		});

		await save(t, 'saveDraftRevision', messageId, HUMAN_REPLY);
		const resumed = await t.mutation(
			internal.inbox.processingLifecycle.reconcileAbandonedClarifications,
			{}
		);
		await t.mutation(internal.inbox.stepOutputs.recordDraftOutput, {
			inboundMessageId: messageId,
			draftResponse: AGENT_DRAFT,
			draftSubject: 'Re: Refund',
			confidenceScore: 0.95,
		});

		expect(resumed).toEqual({ resumed: 0 });
		const message = await getMessage(t, messageId);
		expect(message.processingStatus).toBe('draft_ready');
		expect(message.pendingClarification).toBeUndefined();
		expect(message.draftResponse).toBe(HUMAN_REPLY);
		expect(message.draftRevisions?.map((r) => r.text)).toEqual([HUMAN_REPLY]);
	});
});

describe('a save in draft_ready', () => {
	it.each<SaveMutation>(['saveDraftRevision', 'editDraft'])(
		'is a plain %s, not a takeover',
		async (via) => {
			const t = convexTest(schema, modules);
			const { messageId } = await seed(t, {
				processingStatus: 'draft_ready',
				draftResponse: AGENT_DRAFT,
				draftSubject: 'Re: Refund',
			});

			await save(t, via, messageId, HUMAN_REPLY);

			const message = await getMessage(t, messageId);
			expect(message.processingStatus).toBe('draft_ready');
			expect(message.manualTakeoverAt).toBeUndefined();
			expect(message.draftResponse).toBe(HUMAN_REPLY);
			expect(message.draftRevisions).toHaveLength(2);
			expect(await takeoverAudits(t)).toEqual([]);
		}
	);
});

describe('a re-draft with no human save during it', () => {
	it('still writes the agent draft over the edits saved to the earlier one', async () => {
		const t = convexTest(schema, modules);
		// Edits saved over an earlier draft, then the pipeline re-drafts.
		const { messageId, draftActionId } = await seed(t, {
			draftResponse: HUMAN_REPLY,
			draftRevisions: [
				{ text: 'An earlier agent draft.', savedAt: 1, savedBy: 'agent' },
				{ text: HUMAN_REPLY, savedAt: 2, savedBy: 'reviewer-1' },
			],
			draftSavedAt: 2,
			isDraftEdited: true,
		});

		await draftStepFinishes(t, messageId, draftActionId);
		// The route step holds the draft for review (the walker's transition).
		const routeActionId = await t.run((ctx) => insertRunningAction(ctx, messageId, 'route'));
		const held = await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: { to: 'draft_ready', at: Date.now(), completedActionId: routeActionId },
		});

		expect(held).toMatchObject({ ok: true });
		const message = await getMessage(t, messageId);
		expect(message.processingStatus).toBe('draft_ready');
		expect(message.manualTakeoverAt).toBeUndefined();
		expect(message.draftResponse).toBe(AGENT_DRAFT);
		expect(message.draftRevisions).toBeUndefined();
		expect(message.draftSavedAt).toBeUndefined();
		expect(message.isDraftEdited).toBeUndefined();
	});
});
