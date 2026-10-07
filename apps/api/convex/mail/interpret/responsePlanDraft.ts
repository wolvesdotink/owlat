/**
 * Response plans (SPEC §6): the internal reads and the write the node
 * drafters and Answer mode's coverage check use (the agent `draft` step, draft
 * on arrival, "Draft with AI", `coverage.check`). The public reads and the
 * owner's stance writes are in `responsePlan.ts`.
 */

import { v } from 'convex/values';
import { internalQuery } from '../../_generated/server';
import { internalMutation } from '../../lib/writeFence';
import { sealBodyAtWrite } from '../../lib/messageBody';
import { getBetterAuthSessionWithRole } from '../../lib/sessionOrganization';
import { answerAskTargetValidator } from '../../lib/validators/answerAsk';
import {
	coverageEntryValidator,
	draftRefFromFields,
	draftRefValidator,
	draftSpanValidator,
	itemRevisionRefValidator,
	planVerdictValidator,
	responsePlanStanceValidator,
	type DraftRef,
} from '../../lib/validators/threadBrief';
import { threadRefValidator, type ThreadRef } from '../../lib/validators/threadRef';
import {
	canRead,
	givenStanceValidator,
	isDraftOfThread,
	planForDraft,
	readPlanRow,
	upsertPlan,
	type PlanForDraft,
} from './responsePlanState';

/** The node drafters' read (agent draft step, draft on arrival, Answer mode). */
export const loadForDraft = internalQuery({
	args: {
		threadRef: threadRefValidator,
		draftRef: v.optional(draftRefValidator),
	},
	handler: (ctx, args): Promise<PlanForDraft> =>
		planForDraft(ctx, args.threadRef, args.draftRef ?? null),
});

/**
 * Answer mode "Draft with AI"'s read for an ask session's target (the session
 * already passed its access check): a Postbox draft's own plan; for a team
 * thread, the plan most recently written in it (the reply's inbound message).
 */
export const loadForAskTarget = internalQuery({
	args: { target: answerAskTargetValidator, openSlots: v.array(v.string()) },
	handler: async (ctx, args): Promise<PlanForDraft | null> => {
		const options = { openSlots: args.openSlots };
		if (args.target.kind === 'mailDraft') {
			const draft = await ctx.db.get(args.target.draftId);
			if (!draft?.threadId) return null;
			const draftRef: DraftRef = { kind: 'mailDraft', id: draft._id };
			return planForDraft(ctx, { kind: 'mail', id: draft.threadId }, draftRef, options);
		}
		const ref: ThreadRef = { kind: 'team', id: args.target.threadId };
		const plans = await ctx.db
			.query('draftResponsePlans')
			.withIndex('by_conversation_thread', (q) => q.eq('conversationThreadId', ref.id))
			.take(20);
		const newest = plans.sort((a, b) => b.updatedAt - a.updatedAt)[0];
		return planForDraft(ctx, ref, newest ? draftRefFromFields(newest) : null, options);
	},
});

/**
 * The coverage check's read, under the caller's session: null unless the
 * caller can read the thread and the draft replies in it. `stances` are the
 * owner's current choices (possibly not stored yet).
 */
export const loadForCoverage = internalQuery({
	args: {
		threadRef: threadRefValidator,
		draftRef: draftRefValidator,
		stances: v.array(givenStanceValidator),
	},
	handler: async (ctx, args): Promise<PlanForDraft | null> => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session || !(await canRead(ctx, args.threadRef, session))) return null;
		if (!(await isDraftOfThread(ctx, args.draftRef, args.threadRef))) return null;
		return planForDraft(ctx, args.threadRef, args.draftRef, {
			chosen: args.stances.map((s) => ({ ...s, source: 'owner' as const })),
		});
	},
});

const plainClaimValidator = v.object({
	text: v.string(),
	spans: v.array(draftSpanValidator),
	isMatched: v.boolean(),
	attachmentId: v.optional(v.string()),
});
const plainPromiseValidator = v.object({
	text: v.string(),
	spans: v.array(draftSpanValidator),
	duePhrase: v.optional(v.string()),
	itemId: v.optional(v.id('threadItems')),
});

/**
 * Store a checked plan for a draft (the agent draft step, Answer mode's
 * coverage check). The caller already applied the reader rule; claim and
 * promise texts are sealed here. A draft that no longer replies in the
 * thread is not written.
 */
export const recordCheck = internalMutation({
	args: {
		threadRef: threadRefValidator,
		draftRef: draftRefValidator,
		threadRevision: v.number(),
		itemRevisions: v.array(itemRevisionRefValidator),
		stances: v.array(responsePlanStanceValidator),
		coverage: v.array(coverageEntryValidator),
		fileClaims: v.array(plainClaimValidator),
		newPromises: v.array(plainPromiseValidator),
		draftHash: v.string(),
		verdict: planVerdictValidator,
	},
	handler: async (ctx, args) => {
		if (!(await isDraftOfThread(ctx, args.draftRef, args.threadRef))) return null;
		const existing = await readPlanRow(ctx, args.draftRef);
		await upsertPlan(ctx, args.threadRef, args.draftRef, {
			threadRevision: args.threadRevision,
			itemRevisions: args.itemRevisions,
			stances: args.stances,
			ownerInputs: existing?.ownerInputs ?? [],
			coverage: args.coverage,
			fileClaims: await Promise.all(
				args.fileClaims.map(async (c) => ({ ...c, text: await sealBodyAtWrite(c.text) }))
			),
			newPromises: await Promise.all(
				args.newPromises.map(async ({ duePhrase, ...p }) => ({
					...p,
					text: await sealBodyAtWrite(p.text),
					// The words only: a promise's deadline is not resolved to a date here.
					...(duePhrase ? { due: { phrase: duePhrase, isAmbiguous: true } } : {}),
				}))
			),
			draftHash: args.draftHash,
			verdict: args.verdict,
			updatedAt: Date.now(),
		});
		return null;
	},
});
