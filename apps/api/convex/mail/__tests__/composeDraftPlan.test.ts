/**
 * Answer mode's plan reads (mail/ai/composeDraftPlan.ts): a team reply drafts
 * to the plan of the exact inbound message its context answers, never to
 * whichever plan of the thread was written last (review F9).
 */
import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';
import { loadAnswerPlan, loadSlotItems } from '../ai/composeDraftPlan';

const plan = {
	items: [
		{
			id: 'item_1',
			revision: 1,
			intent: 'request',
			facets: [],
			responsibility: 'us',
			text: 'Refund',
		},
	],
	stances: [{ itemId: 'item_1', stance: 'accept', source: 'owner' }],
};

function ctxWith(calls: { name: string; args: Record<string, unknown> }[]) {
	return {
		runQuery: vi.fn(async (ref: unknown, args: Record<string, unknown>) => {
			const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
			calls.push({ name, args });
			if (name.includes('loadTeamThreadContext')) return { inboundMessageId: 'inbound_2' };
			return plan;
		}),
	};
}

describe('loadAnswerPlan', () => {
	it('reads the plan of the inbound message the team context answers', async () => {
		const calls: { name: string; args: Record<string, unknown> }[] = [];
		const items = await loadAnswerPlan(ctxWith(calls) as never, {
			target: { kind: 'teamThread', threadId: 'thread_1' as never },
			questions: [],
		});
		const read = calls.find((c) => c.name.includes('loadForAskTarget'))!;
		expect(read.args).toMatchObject({ inboundMessageId: 'inbound_2', openSlots: [] });
		expect(items).toEqual([expect.objectContaining({ itemId: 'item_1', stance: 'accept' })]);
		const slotCalls: typeof calls = [];
		await loadSlotItems(ctxWith(slotCalls) as never, {
			kind: 'teamThread',
			threadId: 'thread_1' as never,
		});
		expect(slotCalls.find((c) => c.name.includes('loadForAskTarget'))!.args).toMatchObject({
			inboundMessageId: 'inbound_2',
		});
	});

	it('a Postbox draft reads its own plan, with no team context read', async () => {
		const calls: { name: string; args: Record<string, unknown> }[] = [];
		await loadAnswerPlan(ctxWith(calls) as never, {
			target: { kind: 'mailDraft', draftId: 'draft_1' as never },
			questions: [{ id: 'q', slotType: 'decision', text: 'Which?', itemId: 'item_1' as never }],
		});
		expect(calls.map((c) => c.name).some((n) => n.includes('loadTeamThreadContext'))).toBe(false);
		expect(calls[0]!.args).toMatchObject({ openSlots: ['item_1'] });
		expect(calls[0]!.args).not.toHaveProperty('inboundMessageId');
	});
});

describe('review round 2: the answered message travels on the target (F2)', () => {
	it('reads the plan and slots of the target’s message, never the newest one', async () => {
		const calls: { name: string; args: Record<string, unknown> }[] = [];
		const target = {
			kind: 'teamThread' as const,
			threadId: 'thread_1' as never,
			inboundMessageId: 'inbound_older' as never,
		};
		await loadAnswerPlan(ctxWith(calls) as never, { target, questions: [] });
		await loadSlotItems(ctxWith(calls) as never, target);
		expect(calls.some((c) => c.name.includes('loadTeamThreadContext'))).toBe(false);
		const reads = calls.filter((c) => c.name.includes('loadForAskTarget'));
		expect(reads.map((c) => c.args['inboundMessageId'])).toEqual([
			'inbound_older',
			'inbound_older',
		]);
	});
});
