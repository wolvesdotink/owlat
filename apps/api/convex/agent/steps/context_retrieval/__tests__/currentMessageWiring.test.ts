/**
 * `contextRetrievalStep.execute` renders the [CURRENT MESSAGE] briefing from the
 * thread's structured actions (interpretation in `actions` mode) instead of the
 * raw sender prose, so the draft/clarify steps consume the structured form:
 *   - a stored complete extraction  -> rendered, the run is NOT called again;
 *   - no extraction yet             -> the run is called once, then rendered;
 *   - failed / partial / unreadable -> FAIL SOFT to the hidden-stripped raw body.
 *
 * Convex query/action/mutation seams are mocked — no live backend.
 */

import { ACTION_MODEL_BUDGET_MS } from '../../../../lib/llm/actionDeadline';
import { describe, it, expect } from 'vitest';
import { makeStepCtx } from '../../__tests__/stepCtx';
import { contextRetrievalStep } from '../index';
import type { Id } from '../../../../_generated/dataModel';
import type { BriefingItem } from '../../../../mail/interpret/teamActions';

const messageId = 'msg_current' as Id<'inboundMessages'>;
const input = { inboundMessageId: messageId };

const RAW_BODY = 'RAWBODYSENTINEL please tell me where order 4821 is';

const ITEM: BriefingItem = {
	intent: 'question',
	facets: ['information'],
	responsibility: 'us',
	text: 'Tell the customer where order 4821 is.',
	isUnconfirmed: false,
	isReviewNeeded: false,
	isFromCurrentMessage: true,
	askedAt: 1,
};

type Read = {
	interpretation: {
		status: 'complete' | 'partial' | 'failed' | 'skipped';
		isRerunDue?: boolean;
		budgetRefusal?: { reason: 'monthly_ceiling'; limit: string };
	} | null;
	items: BriefingItem[];
};

const toRead = (read: Read) => ({
	interpretation: read.interpretation,
	selection: {
		ours: read.items.filter((i) => i.responsibility !== 'them'),
		theirs: read.items.filter((i) => i.responsibility === 'them'),
		omitted: 0,
		omittedOurs: 0,
		omittedTheirs: 0,
		isReadTruncated: false,
	},
});

/** ctx serving one contact-less/thread-less inbound; retrieval legs empty. */
function makeCtx(
	reads: Array<Read | 'throw'>,
	opts: { canRun?: boolean; runResult?: Record<string, unknown> } = {}
) {
	const message = {
		_id: messageId,
		from: 'sender@example.com',
		to: 'me@hl.camp',
		subject: 'Order status',
		textBody: RAW_BODY,
		receivedAt: Date.now(),
	};
	const runs: unknown[] = [];
	const captures: unknown[] = [];
	let readIndex = 0;
	const ctx = makeStepCtx<Parameters<typeof contextRetrievalStep.execute>[0]>({
		queries: {
			getMessage: message,
			getContact: null,
			getRecentActivities: [],
			getThreadMessages: [],
			getOpenCommitments: [],
			isGraphRetrievalEnabled: false,
			// knowledge/vectorCorpus: no table holds a vector, so no query embedding.
			hasQueryableVectors: false,
			briefingActions: () => {
				const read = reads[Math.min(readIndex++, reads.length - 1)];
				if (read === undefined) throw new Error('no read fixture');
				if (read === 'throw') throw new Error('read failed');
				return toRead(read);
			},
		},
		actions: {
			interpretMessage: (args: unknown) => {
				runs.push(args);
				return opts.runResult ?? { status: 'complete', createdItemIds: [] };
			},
			knowledge: [],
			semanticFileProcessing: [],
		},
		mutations: {
			recordContextTier: null,
			captureInbound: () => {
				captures.push(messageId);
				return opts.canRun ?? true;
			},
		},
	});
	return { ctx, runs, captures };
}

describe('contextRetrievalStep.execute — structured current message', () => {
	it('reuses a stored complete extraction without running the model again', async () => {
		const { ctx, runs } = makeCtx([{ interpretation: { status: 'complete' }, items: [ITEM] }]);
		const { output } = await contextRetrievalStep.execute(ctx, input);
		expect(output.context).toContain('[CURRENT MESSAGE]');
		expect(output.context).toContain('[OPEN FOR THE TEAM');
		expect(output.context).toContain('Tell the customer where order 4821 is.');
		// The raw prose never sits in the briefing.
		expect(output.context).not.toContain('RAWBODYSENTINEL');
		expect(runs).toEqual([]);
	});

	it('runs interpretation in the team thread once when nothing is stored', async () => {
		const { ctx, runs, captures } = makeCtx([
			{ interpretation: null, items: [] },
			{ interpretation: { status: 'complete' }, items: [ITEM] },
		]);
		const { output } = await contextRetrievalStep.execute(ctx, input);
		// The eligibility snapshot is taken before the first run.
		expect(captures).toEqual([messageId]);
		// Awaited, so it runs on this step's clock: the message's root, with the
		// action's deadline (ADR-0073).
		expect(runs).toEqual([
			{
				source: { kind: 'inbound', id: messageId },
				root: { rootRequestId: `team:${messageId}`, deadlineAt: expect.any(Number) },
			},
		]);
		const deadlineAt = (runs[0] as { root: { deadlineAt: number } }).root.deadlineAt;
		expect(deadlineAt).toBeGreaterThan(Date.now());
		expect(deadlineAt).toBeLessThanOrEqual(Date.now() + ACTION_MODEL_BUDGET_MS);
		expect(output.context).toContain('Tell the customer where order 4821 is.');
		expect(output.context).not.toContain('RAWBODYSENTINEL');
	});

	it('runs again when the stored extraction is due for a repair', async () => {
		const { ctx, runs } = makeCtx([
			{ interpretation: { status: 'failed', isRerunDue: true }, items: [] },
			{ interpretation: { status: 'complete' }, items: [ITEM] },
		]);
		const { output } = await contextRetrievalStep.execute(ctx, input);
		expect(runs).toHaveLength(1);
		expect(output.context).toContain('Tell the customer where order 4821 is.');
	});

	it('does not run without a source snapshot, and falls back to the raw body', async () => {
		const { ctx, runs } = makeCtx([{ interpretation: null, items: [] }], { canRun: false });
		const { output } = await contextRetrievalStep.execute(ctx, input);
		expect(runs).toEqual([]);
		expect(output.context).toContain('RAWBODYSENTINEL');
	});

	it.each(['failed', 'partial'] as const)(
		'falls back to the raw body when interpretation is %s (fail soft)',
		async (status) => {
			const { ctx } = makeCtx([{ interpretation: { status }, items: [ITEM] }]);
			const { output } = await contextRetrievalStep.execute(ctx, input);
			expect(output.context).toContain('RAWBODYSENTINEL');
			expect(output.context).not.toContain('[OPEN FOR THE TEAM');
		}
	);

	it('falls back to the raw body when the interpretation state cannot be read', async () => {
		const { ctx } = makeCtx(['throw']);
		const { output } = await contextRetrievalStep.execute(ctx, input);
		expect(output.context).toContain('[CURRENT MESSAGE]');
		expect(output.context).toContain('RAWBODYSENTINEL');
	});

	it('passes a budget refusal the run answered with on to the walker (Sol r3 F5)', async () => {
		const { ctx, runs } = makeCtx([{ interpretation: null, items: [] }], {
			runResult: {
				status: 'failed',
				isReplayed: false,
				createdItemIds: [],
				errorCode: 'budget',
				budgetRefusal: { reason: 'monthly_ceiling', limit: 'ceiling' },
			},
		});
		await expect(contextRetrievalStep.execute(ctx, input)).rejects.toMatchObject({
			reason: 'monthly_ceiling',
			data: { data: { code: 'AI_BUDGET_EXHAUSTED', reason: 'monthly_ceiling' } },
		});
		expect(runs).toHaveLength(1);
	});

	it('holds on a stored refusal when the cached read is not yet due for a retry (final F1)', async () => {
		const { ctx, runs } = makeCtx([
			{
				interpretation: {
					status: 'failed',
					budgetRefusal: { reason: 'monthly_ceiling', limit: 'ceiling' },
				},
				items: [],
			},
		]);
		await expect(contextRetrievalStep.execute(ctx, input)).rejects.toMatchObject({
			reason: 'monthly_ceiling',
			data: { data: { code: 'AI_BUDGET_EXHAUSTED', reason: 'monthly_ceiling' } },
		});
		// The stored result is reused, never run again before its retry.
		expect(runs).toEqual([]);
	});

	it('still falls back to the raw body for a failed run that met no refusal', async () => {
		const { ctx } = makeCtx([{ interpretation: null, items: [] }], {
			runResult: {
				status: 'failed',
				isReplayed: false,
				createdItemIds: [],
				errorCode: 'model_error',
			},
		});
		const { output } = await contextRetrievalStep.execute(ctx, input);
		expect(output.context).toContain('RAWBODYSENTINEL');
	});
});
