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
import { attachmentSetHashOf, draftHashOf } from '@owlat/shared/threadBriefRules';
import { outgoingCoverageHold } from '../planGate';
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
		planRevision?: number;
		attachmentIds?: string[];
	} = {}
) {
	return t.mutation(internal.mail.interpret.responsePlanDraft.recordCheck, {
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
		planRevision: overrides.planRevision ?? 0,
		deletionEpoch: s.brief.deletionEpoch,
		attachmentSetHash: await attachmentSetHashOf(overrides.attachmentIds ?? []),
		isCheckIncomplete: false,
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
			reason: expect.stringContaining('no response plan'),
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

describe('outgoingCoverageHold (the Send-creating transaction)', () => {
	const hold = (t: Test, inboundId: Id<'inboundMessages'>, draftText: string, ids: string[] = []) =>
		t.run(async (ctx) => {
			const message = (await ctx.db.get(inboundId))!;
			return outgoingCoverageHold(ctx, message, { draftText, attachmentIds: ids });
		});

	it('never holds while the gate only observes', async () => {
		const t = convexTest(schema, modules);
		const s = await setup(t);
		expect(await hold(t, s.inboundId, 'anything')).toBeNull();
	});

	it('F8: holds an enforced send whose outgoing text is not the checked one', async () => {
		const t = convexTest(schema, modules);
		const s = await setup(t);
		await enforce(t, true);
		await recordPlan(t, s);
		expect(await hold(t, s.inboundId, DRAFT)).toBeNull();
		expect(await hold(t, s.inboundId, `${DRAFT} P.S. 20% off.`)).toContain('different draft text');
	});

	it('F4: holds when the outgoing files are not the checked set, ignoring earlier staged files', async () => {
		const t = convexTest(schema, modules);
		const s = await setup(t);
		await enforce(t, true);
		await recordPlan(t, s);
		expect(await hold(t, s.inboundId, DRAFT, ['f1'])).toContain('different attachments');
		// A file staged on the thread BEFORE the message arrived is not in the
		// autonomous set, so the route-time check does not count it either.
		await t.run(async (ctx) => {
			const storageId = await ctx.storage.store(new Blob(['x']));
			await ctx.db.patch(s.threadId, {
				replyAttachments: [
					{
						id: 'staged',
						storageId,
						filename: 'contract.pdf',
						contentType: 'application/pdf',
						size: 1,
						origin: 'upload',
						addedBy: 'user-A',
						addedAt: SENT - 60_000,
					},
				],
			});
		});
		expect((await check(t, s.inboundId)).objections).toEqual([]);
	});
});

describe('intakeAgentReply (review F8)', () => {
	it('refuses an enforced autonomous send whose outgoing text was not checked, before any Send', async () => {
		const t = convexTest(schema, modules);
		const s = await setup(t);
		await enforce(t, true);
		await recordPlan(t, s);
		const outcome = await t.mutation(internal.inbox.replyAttachments.intakeAgentReply, {
			inboundMessageId: s.inboundId,
			autonomous: true,
			email: 'customer@example.com',
			subject: 'Re: Order 42',
			html: '<p>changed</p>',
			draftText: `${DRAFT} And a discount.`,
			from: 'support@owlat.test',
		});
		expect(outcome).toMatchObject({ ok: false, reason: 'item_coverage' });
		expect(await t.run((ctx) => ctx.db.query('transactionalSends').collect())).toEqual([]);
	});
});

describe('compare-and-set and draft liveness', () => {
	it('F3: a check computed for older stances never overwrites newer ones', async () => {
		const t = convexTest(schema, modules);
		const s = await setup(t);
		expect(await recordPlan(t, s, { planRevision: 0 })).toEqual({ isStored: true });
		await t.run(async (ctx) => {
			const row = (await ctx.db.query('draftResponsePlans').first())!;
			await ctx.db.patch(row._id, { planRevision: 1, verdict: 'pending' });
		});
		expect(await recordPlan(t, s, { planRevision: 0 })).toEqual({ isStored: false });
		const row = await t.run(async (ctx) => (await ctx.db.query('draftResponsePlans').first())!);
		expect(row).toMatchObject({ planRevision: 1, verdict: 'pending', checkedPlanRevision: 0 });
		expect((await check(t, s.inboundId)).objections).toContain('pending_check');
	});

	it('F14: rejecting the draft deletes its plan', async () => {
		const t = convexTest(schema, modules);
		const s = await setup(t);
		await recordPlan(t, s);
		await t.run((ctx) => ctx.db.patch(s.inboundId, { processingStatus: 'draft_ready' }));
		const outcome = await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: s.inboundId,
			input: { to: 'rejected', at: SENT, userId: 'user-A' },
		});
		expect(outcome).toMatchObject({ ok: true });
		expect(await t.run((ctx) => ctx.db.query('draftResponsePlans').collect())).toEqual([]);
	});

	it('F14: a late check does not recreate the plan of a rejected draft', async () => {
		const t = convexTest(schema, modules);
		const s = await setup(t);
		await t.run((ctx) => ctx.db.patch(s.inboundId, { processingStatus: 'rejected' }));
		expect(await recordPlan(t, s)).toEqual({ isStored: false });
		expect(await t.run((ctx) => ctx.db.query('draftResponsePlans').collect())).toEqual([]);
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

describe('review round 2', () => {
	async function acceptedPlan(t: Test, s: Awaited<ReturnType<typeof setup>>, duePhrase: string) {
		return t.mutation(internal.mail.interpret.responsePlanDraft.recordCheck, {
			threadRef: s.ref,
			draftRef: { kind: 'inboundDraft', id: s.inboundId },
			threadRevision: s.brief.interpretationRevision,
			itemRevisions: [{ itemId: s.item._id, revision: s.item.revision }],
			stances: [{ itemId: s.item._id, stance: 'accept', source: 'owner' }],
			coverage: [{ itemId: s.item._id, verdict: 'addressed', spans: [{ start: 0, end: 5 }] }],
			fileClaims: [],
			newPromises: [
				{ text: 'refund it', spans: [{ start: 0, end: 5 }], duePhrase, itemId: s.item._id },
			],
			draftHash: await draftHashOf(DRAFT),
			verdict: 'covered',
			planRevision: 0,
			deletionEpoch: s.brief.deletionEpoch,
			attachmentSetHash: await attachmentSetHashOf([]),
			isCheckIncomplete: false,
		});
	}

	it('F1: a stored commitment with another deadline than the accepted item is held', async () => {
		const t = convexTest(schema, modules);
		const s = await setup(t);
		await enforce(t, true);
		// The item's own deadline is "by Friday" (reduceItem fixture).
		await acceptedPlan(t, s, 'by Wednesday');
		expect((await check(t, s.inboundId)).objections).toEqual(['unauthorized_commitment']);
		expect(
			await t.run(async (ctx) => {
				const message = (await ctx.db.get(s.inboundId))!;
				return outgoingCoverageHold(ctx, message, { draftText: DRAFT, attachmentIds: [] });
			})
		).toContain('commitment nobody authorised');
	});

	it('F1: the item’s own deadline passes', async () => {
		const t = convexTest(schema, modules);
		const s = await setup(t);
		await acceptedPlan(t, s, 'by Friday');
		expect((await check(t, s.inboundId)).objections).toEqual([]);
	});

	it('F5: a late check computed before a takeover is not stored', async () => {
		const t = convexTest(schema, modules);
		const s = await setup(t);
		// A person takes the received message over to write the reply themselves.
		const outcome = await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: s.inboundId,
			input: { to: 'draft_ready', at: SENT, manualTakeover: true },
		});
		expect(outcome).toMatchObject({ ok: true });
		// The check read "no plan" (revision 0) before the takeover.
		expect(await recordPlan(t, s, { planRevision: 0 })).toEqual({ isStored: false });
		const rows = await t.run((ctx) => ctx.db.query('draftResponsePlans').collect());
		expect(rows).toEqual([
			expect.objectContaining({ planRevision: 1, verdict: 'stale', coverage: [] }),
		]);
	});

	it('F5: a late check computed before Send intake is not stored', async () => {
		const t = convexTest(schema, modules);
		const s = await setup(t);
		await recordPlan(t, s, { planRevision: 0 });
		await t.run(async (ctx) => {
			const { retirePlansForDraft } = await import('../responsePlanState');
			await retirePlansForDraft(ctx, { kind: 'inboundDraft', id: s.inboundId }, s.threadId);
		});
		expect(await recordPlan(t, s, { planRevision: 0 })).toEqual({ isStored: false });
		const [row] = await t.run((ctx) => ctx.db.query('draftResponsePlans').collect());
		expect(row).toMatchObject({ planRevision: 1, verdict: 'stale', coverage: [] });
		expect(row?.checkedPlanRevision).toBeUndefined();
	});
});

describe('final review', () => {
	const intake = (t: Test, inboundId: Id<'inboundMessages'>) =>
		t.mutation(internal.inbox.replyAttachments.intakeAgentReply, {
			inboundMessageId: inboundId,
			autonomous: true,
			email: 'customer@example.com',
			subject: 'Re: Order 42',
			html: `<p>${DRAFT}</p>`,
			draftText: DRAFT,
			from: 'support@owlat.test',
		});

	it('F1: the autonomous intake holds once interpretation went incomplete, item_coverage in shadow mode', async () => {
		const t = convexTest(schema, modules);
		const s = await setup(t);
		await recordPlan(t, s);
		await t.run((ctx) => ctx.db.patch(s.brief._id, { completeness: 'partial' }));
		expect(await intake(t, s.inboundId)).toMatchObject({
			ok: false,
			reason: 'interpretation_incomplete',
		});
		expect(await t.run((ctx) => ctx.db.query('transactionalSends').collect())).toEqual([]);
	});

	it('F1: the autonomous intake holds once an open item was redacted by a purge', async () => {
		const t = convexTest(schema, modules);
		const s = await setup(t);
		await recordPlan(t, s);
		await t.run((ctx) => ctx.db.patch(s.item._id, { redactedFields: ['due'] }));
		expect(await intake(t, s.inboundId)).toMatchObject({
			ok: false,
			reason: 'interpretation_incomplete',
		});
	});

	it('F3: a check computed before an erasure is not stored after it', async () => {
		const t = convexTest(schema, modules);
		const s = await setup(t);
		// The purge ran in between: the epoch moved and the item is gone.
		await t.run(async (ctx) => {
			await ctx.db.patch(s.brief._id, { deletionEpoch: s.brief.deletionEpoch + 1 });
			await ctx.db.delete(s.item._id);
		});
		expect(await recordPlan(t, s)).toEqual({ isStored: false });
		expect(await t.run((ctx) => ctx.db.query('draftResponsePlans').collect())).toEqual([]);
	});

	it('F3: a check naming an item at another revision, or one it did not read, is not stored', async () => {
		const t = convexTest(schema, modules);
		const s = await setup(t);
		await t.run((ctx) => ctx.db.patch(s.item._id, { revision: s.item.revision + 1 }));
		expect(await recordPlan(t, s)).toEqual({ isStored: false });
	});

	it('F3: stripping a purged item bumps the plan revision', async () => {
		const { stripPlan } = await import('../purgeQuestions');
		const stripped = stripPlan(
			{
				itemRevisions: [],
				stances: [],
				ownerInputs: [],
				coverage: [],
				newPromises: [],
				planRevision: 3,
			},
			new Set(['gone'])
		);
		expect(stripped).toMatchObject({ planRevision: 4, verdict: 'stale' });
	});
});
