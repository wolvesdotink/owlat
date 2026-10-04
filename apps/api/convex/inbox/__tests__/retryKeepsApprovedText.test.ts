/**
 * Retry keeps a person's reply (#1220). A reviewer edited and approved a
 * draft, the send failed, and Retry re-ran the whole agent pipeline: the new
 * agent draft replaced the approved text, cleared its revisions, and with
 * auto-reply on could go out unreviewed. The retry cron did the same to a
 * person's save on a message that failed in a pipeline step. Now a failed send
 * of approved text is sent again, a person's reply goes back to review, and
 * only a message nobody touched re-runs the agent, on both paths.
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
		([path]) => !path.includes('knowledgeExtraction') && !path.includes('llmProvider')
	)
);

type Harness = ReturnType<typeof convexTest>;

// Approve, Retry and the cron schedule the send and the pipeline; none of it
// may run here. The queued jobs are what the tests read.
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

const AGENT_DRAFT = 'Thanks for writing. Your refund is on its way.';
const EDIT = 'Hi Jonas, I sent the refund of 42 EUR today.';

async function seed(t: Harness, fields: Record<string, unknown> = {}) {
	return t.run(async (ctx) => {
		// Auto-reply on with a low bar: an agent draft would clear it.
		await ctx.db.insert('agentConfig', {
			isAutoReplyEnabled: true,
			confidenceThreshold: 0.5,
			humanApproveUndoDelayMs: 15_000,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		return (await ctx.db.insert('inboundMessages', {
			messageId: 'msg-1220',
			from: 'jonas@example.com',
			to: 'support@owlat.app',
			subject: 'Refund',
			textBody: 'Where is my refund?',
			processingStatus: 'draft_ready',
			draftResponse: AGENT_DRAFT,
			draftSubject: 'Re: Refund',
			confidenceScore: 0.97,
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

const retry = (t: Harness, id: Id<'inboundMessages'>) =>
	t.mutation(api.inbox.mutations.retryFailedMessage, { inboundMessageId: id });

const runRetryCron = (t: Harness) =>
	t.mutation(internal.inbox.processingLifecycle.retryFailedActions, {});

async function scheduled(t: Harness) {
	return t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect()).map((job) => ({
			name: job.name,
			args: job.args[0] as Record<string, unknown>,
		}))
	);
}

const pipelineRuns = async (t: Harness) =>
	(await scheduled(t)).filter((job) => job.name === 'agent/walker:start');

const sends = async (t: Harness) =>
	(await scheduled(t)).filter((job) => job.name === 'agent/agentPipeline:sendApprovedReply');

/** What `sendApprovedReply` does when the send cannot go out. */
const failSend = (t: Harness, id: Id<'inboundMessages'>) =>
	t.mutation(internal.inbox.processingLifecycle.transition, {
		inboundMessageId: id,
		input: { to: 'failed', at: Date.now(), errorMessage: 'Sending is disabled' },
	});

/** A pipeline step failing, as the walker reports it. */
async function failStep(
	t: Harness,
	id: Id<'inboundMessages'>,
	from: Doc<'inboundMessages'>['processingStatus']
) {
	await t.run((ctx) => ctx.db.patch(id, { processingStatus: from }));
	const actionId = await t.run((ctx) =>
		ctx.db.insert('agentActions', {
			inboundMessageId: id,
			actionType: 'classify',
			status: 'running',
			retryCount: 0,
			createdAt: Date.now(),
		})
	);
	await t.mutation(internal.inbox.processingLifecycle.transition, {
		inboundMessageId: id,
		input: {
			to: 'failed',
			at: Date.now(),
			errorMessage: 'Classifier timed out',
			failingActionId: actionId,
		},
	});
	return actionId;
}

describe('Retry after a failed send of an approved reply', () => {
	it('sends the approved text again and does not re-run the pipeline', async () => {
		const t = convexTest(schema, modules);
		const id = await seed(t);
		await save(t, id, EDIT);
		await t.mutation(api.inbox.mutations.approveDraft, { inboundMessageId: id });
		await failSend(t, id);
		expect((await getMessage(t, id)).processingStatus).toBe('failed');

		const result = await retry(t, id);

		const message = await getMessage(t, id);
		expect(message).toMatchObject({
			processingStatus: 'approved',
			approvalSource: 'human',
			draftResponse: EDIT,
		});
		expect(message.failedStage).toBeUndefined();
		expect(message.draftRevisions?.map((r) => r.text)).toEqual([AGENT_DRAFT, EDIT]);
		// The same undo window as Approve.
		expect(message.pendingAutoSend?.sendAt).toBeTypeOf('number');
		expect(await pipelineRuns(t)).toEqual([]);
		const queued = await sends(t);
		expect(queued[queued.length - 1]?.args).toEqual({ inboundMessageId: id, autonomous: false });
		expect(result).toEqual({ success: true, retried: 'sendAgain' });
	});

	it('records the failure as the send’s', async () => {
		const t = convexTest(schema, modules);
		const id = await seed(t);
		await t.mutation(api.inbox.mutations.approveDraft, { inboundMessageId: id });
		await failSend(t, id);
		expect(await getMessage(t, id)).toMatchObject({
			processingStatus: 'failed',
			failedStage: 'send',
		});
	});

	it('never lets the agent auto-send its own draft with auto-reply on', async () => {
		const t = convexTest(schema, modules);
		const id = await seed(t);
		await save(t, id, EDIT);
		await t.mutation(api.inbox.mutations.approveDraft, { inboundMessageId: id });
		await failSend(t, id);

		// A late router auto-approve cannot send from `failed`.
		const auto = await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: id,
			input: { to: 'approved', at: Date.now(), source: 'auto' },
		});
		expect(auto).toMatchObject({ ok: false, reason: 'illegal_edge' });

		await retry(t, id);
		await runRetryCron(t);

		// No agent run, so no agent draft and no route step to auto-approve one.
		expect(await pipelineRuns(t)).toEqual([]);
		expect((await sends(t)).every((job) => job.args['autonomous'] === false)).toBe(true);
		const message = await getMessage(t, id);
		expect(message.draftResponse).toBe(EDIT);
		expect(message.approvalSource).toBe('human');
	});

	it('also sends an unedited agent draft a person approved, as their approval', async () => {
		const t = convexTest(schema, modules);
		const id = await seed(t);
		await t.mutation(api.inbox.mutations.approveDraft, { inboundMessageId: id });
		await failSend(t, id);

		const result = await retry(t, id);
		expect(await getMessage(t, id)).toMatchObject({
			processingStatus: 'approved',
			draftResponse: AGENT_DRAFT,
		});
		expect(await pipelineRuns(t)).toEqual([]);
		expect(result).toMatchObject({ retried: 'sendAgain' });
	});

	it('puts a send-failed reply a person edited afterwards back in review, not out', async () => {
		const t = convexTest(schema, modules);
		const id = await seed(t);
		await t.mutation(api.inbox.mutations.approveDraft, { inboundMessageId: id });
		await failSend(t, id);

		// Editing the failed reply takes it over: it is a new reply to review.
		await save(t, id, EDIT);

		const message = await getMessage(t, id);
		expect(message.processingStatus).toBe('draft_ready');
		expect(message.manualTakeoverAt).toBeTypeOf('number');
		expect(message.draftResponse).toBe(EDIT);
	});
});

describe('a person’s save on a message that failed in a pipeline step', () => {
	it('survives the retry cron', async () => {
		const t = convexTest(schema, modules);
		// The draft step wrote its draft, then the route step failed.
		const id = await seed(t);
		const actionId = await failStep(t, id, 'drafting');
		expect((await getMessage(t, id)).processingStatus).toBe('failed');

		await save(t, id, EDIT);
		await runRetryCron(t);

		const message = await getMessage(t, id);
		expect(message.processingStatus).toBe('draft_ready');
		expect(message.draftResponse).toBe(EDIT);
		expect(message.draftRevisions?.map((r) => r.text)).toEqual([AGENT_DRAFT, EDIT]);
		expect(message.manualTakeoverAt).toBeTypeOf('number');
		expect(await pipelineRuns(t)).toEqual([]);
		// The agent's retries end with the takeover.
		expect((await t.run((ctx) => ctx.db.get(actionId)))?.status).toBe('abandoned');
	});

	it('survives the retry cron on a row saved before this release', async () => {
		const t = convexTest(schema, modules);
		const id = await seed(t, {
			processingStatus: 'failed',
			errorMessage: 'Route step failed',
			draftResponse: EDIT,
			draftSavedAt: Date.now(),
			isDraftEdited: true,
			draftRevisions: [
				{ text: AGENT_DRAFT, savedAt: 1, savedBy: 'agent' },
				{ text: EDIT, savedAt: 2, savedBy: 'reviewer-1' },
			],
		});
		const actionId = await t.run((ctx) =>
			ctx.db.insert('agentActions', {
				inboundMessageId: id,
				actionType: 'route',
				status: 'failed',
				retryCount: 1,
				createdAt: Date.now(),
			})
		);

		await runRetryCron(t);

		const message = await getMessage(t, id);
		expect(message.processingStatus).toBe('failed');
		expect(message.draftResponse).toBe(EDIT);
		expect(message.draftRevisions).toHaveLength(2);
		expect(await pipelineRuns(t)).toEqual([]);
		// Left for a person, and out of the cron's scan.
		expect((await t.run((ctx) => ctx.db.get(actionId)))?.status).toBe('abandoned');

		// That person's Retry puts the reply back in review.
		const result = await retry(t, id);
		expect(await getMessage(t, id)).toMatchObject({
			processingStatus: 'draft_ready',
			draftResponse: EDIT,
		});
		expect(result).toMatchObject({ retried: 'review' });
	});
});

describe('a failure before anyone touched the reply', () => {
	it('re-runs the agent on Retry', async () => {
		const t = convexTest(schema, modules);
		const id = await seed(t, { draftResponse: undefined, draftSubject: undefined });
		const actionId = await failStep(t, id, 'classifying');
		expect((await getMessage(t, id)).failedStage).toBe('pipeline');

		const result = await retry(t, id);

		expect((await getMessage(t, id)).processingStatus).toBe('received');
		expect(await pipelineRuns(t)).toHaveLength(1);
		expect((await t.run((ctx) => ctx.db.get(actionId)))?.status).toBe('pending');
		expect(result).toEqual({ success: true, retried: 'redraft' });
	});

	it('re-runs the agent from the retry cron', async () => {
		const t = convexTest(schema, modules);
		const id = await seed(t, { draftResponse: undefined, draftSubject: undefined });
		await failStep(t, id, 'classifying');

		await runRetryCron(t);

		expect((await getMessage(t, id)).processingStatus).toBe('received');
		expect(await pipelineRuns(t)).toHaveLength(1);
	});

	it('re-runs the agent after a failed send nobody reviewed', async () => {
		const t = convexTest(schema, modules);
		const id = await seed(t, { processingStatus: 'drafting' });
		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: id,
			input: { to: 'approved', at: Date.now(), source: 'auto' },
		});
		await failSend(t, id);

		const result = await retry(t, id);
		expect(await pipelineRuns(t)).toHaveLength(1);
		expect(result).toMatchObject({ retried: 'redraft' });
	});
});

describe('a message a person took over', () => {
	it('keeps the person’s reply through a Retry', async () => {
		const t = convexTest(schema, modules);
		// Failed before this release, after a person's approval: no stage on record.
		const id = await seed(t, {
			processingStatus: 'failed',
			errorMessage: 'Sending is disabled',
			draftResponse: EDIT,
			approvalSource: 'human',
			manualTakeoverAt: Date.now(),
		});

		const result = await retry(t, id);

		const message = await getMessage(t, id);
		expect(message.processingStatus).toBe('draft_ready');
		expect(message.draftResponse).toBe(EDIT);
		expect(message.manualTakeoverAt).toBeTypeOf('number');
		expect(await pipelineRuns(t)).toEqual([]);
		expect(result).toMatchObject({ retried: 'review' });
	});
});
