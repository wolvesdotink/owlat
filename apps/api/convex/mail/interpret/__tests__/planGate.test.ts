/**
 * The `item_coverage` gate's reads (planGate.ts) on a Team Inbox thread: the
 * stored plan against the draft and the items as they are now, the enforce
 * setting (off by default), the dispatch recheck, and the shadow log on the
 * message's `agentShadowDecisions` row.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import { draftHashOf } from '../responsePlanRules';
import {
	modules as interpretModules,
	reduceItem,
	reduceResult,
	seedTeamThread,
	type Test,
} from './interpret.testlib';

// The route step's shadow write lives under agent/, which the shared map leaves out.
const modules = {
	...interpretModules,
	...import.meta.glob('../../../agent/shadowScorecard.ts'),
};

const SENT = Date.UTC(2026, 9, 7, 9, 0);
const DRAFT = 'Hi, your refund is on its way and will reach you by Monday.';

async function setup(t: Test) {
	const { threadId, inboundId } = await seedTeamThread(t);
	const ref = { kind: 'team' as const, id: threadId };
	await t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
		source: { kind: 'inbound', id: inboundId },
		threadRef: ref,
		mode: 'actions',
		contentRevision: 'rev-1',
		extractorVersion: 1,
		expectedRevision: 0,
		deletionEpoch: 0,
		sourceAt: SENT,
		direction: 'inbound',
		status: 'complete',
		result: reduceResult({
			items: [
				reduceItem({
					intent: 'request',
					facets: ['payment'],
					consequences: ['payment'],
					assertion: 'Refund the order by Monday',
					display: { en: 'Refund the order by Monday', de: 'Erstatte die Bestellung bis Montag' },
					requester: { email: 'customer@example.com', isUs: false },
					responsible: { email: 'support@owlat.test', isUs: true },
				}),
			],
			latest: undefined,
			facts: undefined,
		}),
	});
	await t.run((ctx) => ctx.db.patch(inboundId, { draftResponse: DRAFT }));
	const state = await t.run(async (ctx) => {
		const item = (await ctx.db.query('threadItems').collect()).find(
			(i) => i.conversationThreadId === threadId
		)!;
		const brief = (await ctx.db.query('threadBriefs').collect()).find(
			(b) => b.conversationThreadId === threadId
		)!;
		return { item, brief };
	});
	return { threadId, inboundId, ref, item: state.item, brief: state.brief };
}

async function recordPlan(
	t: Test,
	s: Awaited<ReturnType<typeof setup>>,
	overrides: {
		verdict?: 'addressed' | 'partial';
		draft?: string;
		isMatched?: boolean;
	} = {}
) {
	await t.mutation(internal.mail.interpret.responsePlanDraft.recordCheck, {
		threadRef: s.ref,
		draftRef: { kind: 'inboundDraft', id: s.inboundId },
		threadRevision: s.brief.interpretationRevision,
		itemRevisions: [{ itemId: s.item._id, revision: s.item.revision }],
		stances: [{ itemId: s.item._id, stance: 'answer', source: 'default' }],
		coverage: [
			{
				itemId: s.item._id,
				verdict: overrides.verdict ?? 'addressed',
				spans: [{ start: 4, end: 30 }],
			},
		],
		fileClaims:
			overrides.isMatched === undefined
				? []
				: [{ text: 'attached', spans: [{ start: 0, end: 8 }], isMatched: overrides.isMatched }],
		newPromises: [],
		draftHash: await draftHashOf(overrides.draft ?? DRAFT),
		verdict: 'covered',
	});
}

async function enforce(t: Test, isItemCoverageEnforced: boolean) {
	await t.run((ctx) =>
		ctx.db.insert('agentConfig', {
			isAutoReplyEnabled: true,
			confidenceThreshold: 0.8,
			isItemCoverageEnforced,
			createdAt: SENT,
			updatedAt: SENT,
		})
	);
}

const check = (t: Test, inboundMessageId: Id<'inboundMessages'>) =>
	t.query(internal.mail.interpret.planGate.itemCoverageCheck, { inboundMessageId });

describe('itemCoverageCheck', () => {
	it('objects to a draft with no plan, in shadow mode by default', async () => {
		const t = convexTest(schema, modules);
		const s = await setup(t);
		expect(await check(t, s.inboundId)).toEqual({
			objections: ['no_plan'],
			reason: expect.stringContaining('no checked response plan'),
			isEnforced: false,
		});
	});

	it('has nothing to object to for a covered, current plan', async () => {
		const t = convexTest(schema, modules);
		const s = await setup(t);
		await recordPlan(t, s);
		expect(await check(t, s.inboundId)).toEqual({
			objections: [],
			reason: null,
			isEnforced: false,
		});
	});

	it('objects once the draft text changed after the check', async () => {
		const t = convexTest(schema, modules);
		const s = await setup(t);
		await recordPlan(t, s, { draft: 'An older draft.' });
		expect((await check(t, s.inboundId)).objections).toEqual(['stale_draft']);
	});

	it('objects to a partly covered item and to a missing file', async () => {
		const t = convexTest(schema, modules);
		const s = await setup(t);
		await recordPlan(t, s, { verdict: 'partial', isMatched: false });
		expect((await check(t, s.inboundId)).objections).toEqual(['not_addressed', 'file_missing']);
	});

	it('objects when an item changed since the check', async () => {
		const t = convexTest(schema, modules);
		const s = await setup(t);
		await recordPlan(t, s);
		await t.run((ctx) => ctx.db.patch(s.item._id, { revision: s.item.revision + 1 }));
		expect((await check(t, s.inboundId)).objections).toEqual(['stale_items']);
	});

	it('reads the enforce setting', async () => {
		const t = convexTest(schema, modules);
		const s = await setup(t);
		await enforce(t, true);
		expect((await check(t, s.inboundId)).isEnforced).toBe(true);
	});
});

describe('dispatchHold', () => {
	it('never holds while the gate only observes', async () => {
		const t = convexTest(schema, modules);
		const s = await setup(t);
		expect(
			await t.query(internal.mail.interpret.planGate.dispatchHold, {
				inboundMessageId: s.inboundId,
			})
		).toEqual({ reason: null });
	});

	it('holds an enforced send whose draft moved since route time', async () => {
		const t = convexTest(schema, modules);
		const s = await setup(t);
		await enforce(t, true);
		await recordPlan(t, s);
		expect(
			await t.query(internal.mail.interpret.planGate.dispatchHold, {
				inboundMessageId: s.inboundId,
			})
		).toEqual({ reason: null });
		await t.run((ctx) => ctx.db.patch(s.inboundId, { draftResponse: `${DRAFT} P.S. 20% off.` }));
		expect(
			await t.query(internal.mail.interpret.planGate.dispatchHold, {
				inboundMessageId: s.inboundId,
			})
		).toEqual({ reason: expect.stringContaining('different draft text') });
	});
});

describe('recordShadow', () => {
	it('records the objection on a new observation, then on the route step’s row', async () => {
		const t = convexTest(schema, modules);
		const s = await setup(t);
		await t.mutation(internal.mail.interpret.planGate.recordShadow, {
			inboundMessageId: s.inboundId,
			objections: ['no_plan'],
			reason: 'Item coverage: no plan',
		});
		const rows = () => t.run((ctx) => ctx.db.query('agentShadowDecisions').collect());
		expect(await rows()).toEqual([
			expect.objectContaining({
				inboundMessageId: s.inboundId,
				isWouldHaveSent: true,
				isResolved: false,
				shadowDraft: DRAFT,
				itemCoverage: {
					objections: ['no_plan'],
					reason: 'Item coverage: no plan',
					at: expect.any(Number),
				},
			}),
		]);
		// The route step's own shadow write refreshes the row and keeps the field.
		await t.mutation(internal.agent.shadowScorecard.recordShadowDecision, {
			inboundMessageId: s.inboundId,
			category: 'support',
			wouldHaveSent: true,
			reason: 'Per-category rule permits auto-approval.',
			confidence: 0.9,
		});
		const [row] = await rows();
		expect(row).toMatchObject({
			category: 'support',
			itemCoverage: { objections: ['no_plan'] },
		});
	});
});
