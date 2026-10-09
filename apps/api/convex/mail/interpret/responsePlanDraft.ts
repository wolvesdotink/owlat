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
import { itemAmountValidator, planVerdictValidator } from '../../lib/validators/threadBrief';
import {
	coverageEntryValidator,
	draftRefValidator,
	draftSpanValidator,
	itemRevisionRefValidator,
	responsePlanStanceValidator,
	type DraftRef,
} from '../../lib/validators/responsePlan';
import { threadRefValidator, type ThreadRef } from '../../lib/validators/threadRef';
import {
	canRead,
	isDraftLive,
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
 * thread, the plan of the exact inbound message the session answers (carried
 * on the session, review F9), or the thread's defaults without one.
 */
export const loadForAskTarget = internalQuery({
	args: {
		target: answerAskTargetValidator,
		openSlots: v.array(v.string()),
		inboundMessageId: v.optional(v.id('inboundMessages')),
	},
	handler: async (ctx, args): Promise<PlanForDraft | null> => {
		const options = { openSlots: args.openSlots };
		if (args.target.kind === 'mailDraft') {
			const draft = await ctx.db.get(args.target.draftId);
			if (!draft?.threadId) return null;
			const draftRef: DraftRef = { kind: 'mailDraft', id: draft._id };
			return planForDraft(ctx, { kind: 'mail', id: draft.threadId }, draftRef, options);
		}
		const ref: ThreadRef = { kind: 'team', id: args.target.threadId };
		const draftRef: DraftRef | null = args.inboundMessageId
			? { kind: 'inboundDraft', id: args.inboundMessageId }
			: null;
		if (draftRef && !(await isDraftOfThread(ctx, draftRef, ref))) return null;
		return planForDraft(ctx, ref, draftRef, options);
	},
});

/**
 * The coverage check's read, under the caller's session: null unless the
 * caller can read the thread and the draft replies in it and is still a
 * draft. The stances are the STORED ones (the web writes its choices before it
 * asks), so the result binds to the plan revision it was computed for.
 */
export const loadForCoverage = internalQuery({
	args: { threadRef: threadRefValidator, draftRef: draftRefValidator },
	handler: async (ctx, args): Promise<PlanForDraft | null> => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session || !(await canRead(ctx, args.threadRef, session))) return null;
		if (!(await isDraftOfThread(ctx, args.draftRef, args.threadRef))) return null;
		if (!(await isDraftLive(ctx, args.draftRef))) return null;
		return planForDraft(ctx, args.threadRef, args.draftRef);
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
	amount: v.optional(itemAmountValidator),
	itemId: v.optional(v.id('threadItems')),
});

/**
 * Store a checked plan for a draft (the agent draft step, Answer mode's
 * coverage check, draft on arrival). The caller already applied the reader
 * rule; claim and promise texts are sealed here.
 *
 * Compare-and-set on the plan revision (review D1): the result is written only
 * while the stored stances are still the ones the check read
 * (`planRevision`); a result computed for older stances is dropped, never
 * written over newer ones. A draft that no longer replies in the thread, or
 * is no longer a draft (sent, rejected, discarded), is not written either, so
 * a late check cannot recreate a removed plan. Returns whether it stored.
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
		// The plan revision the check read.
		planRevision: v.number(),
		attachmentSetHash: v.string(),
		isCheckIncomplete: v.boolean(),
	},
	handler: async (ctx, args): Promise<{ isStored: boolean }> => {
		if (!(await isDraftOfThread(ctx, args.draftRef, args.threadRef))) return { isStored: false };
		if (!(await isDraftLive(ctx, args.draftRef))) return { isStored: false };
		const existing = await readPlanRow(ctx, args.draftRef);
		if ((existing?.planRevision ?? 0) !== args.planRevision) return { isStored: false };
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
			planRevision: args.planRevision,
			checkedPlanRevision: args.planRevision,
			attachmentSetHash: args.attachmentSetHash,
			isCheckIncomplete: args.isCheckIncomplete,
			updatedAt: Date.now(),
		});
		return { isStored: true };
	},
});
