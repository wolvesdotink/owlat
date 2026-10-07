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
	askedAt: 1,
};

type Read = {
	interpretation: {
		status: 'complete' | 'partial' | 'failed' | 'skipped';
		isRerunDue?: boolean;
	} | null;
	items: BriefingItem[];
};

/** ctx serving one contact-less/thread-less inbound; retrieval legs empty. */
function makeCtx(reads: Array<Read | 'throw'>, opts: { canRun?: boolean } = {}) {
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
			briefingActions: () => {
				const read = reads[Math.min(readIndex++, reads.length - 1)];
				if (read === 'throw') throw new Error('read failed');
				return read;
			},
		},
		actions: {
			interpretMessage: (args: unknown) => {
				runs.push(args);
				return { status: 'complete', createdItemIds: [] };
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
		expect(runs).toEqual([{ source: { kind: 'inbound', id: messageId } }]);
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
});
