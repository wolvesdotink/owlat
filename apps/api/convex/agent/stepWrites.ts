/**
 * What an Agent step (module) records besides its route: the scan verdict,
 * the context tier, the draft and its response plan, the agent decision, the
 * observations around it and the shadow decision bundles scheduled beside
 * it. A step's `execute` returns these as data, and
 * the walker's step commit (`./walkerCommit.ts`) applies them in the
 * transaction that records the step and schedules the next one, so they land
 * exactly when the step's result does and never without it.
 *
 * Each write goes through the owning module's `MutationCtx` helper; where
 * that module has an internal mutation for it, the mutation wraps the same
 * helper.
 */

import { v, type Infer } from 'convex/values';
import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { securityFlagsValidator } from '../lib/convexValidators';
import { omit } from '../lib/validators/fields';
import { logError } from '../lib/runtimeLog';
import {
	agentDecisionFields,
	applyAgentDecision,
	applyContextTier,
	applyDraftOutput,
	applySecurityScan,
	contextTierFields,
	draftOutputFields,
} from '../inbox/stepOutputs';
import { applyClarificationAsk } from '../inbox/clarificationLog';
import { clarificationAskLogFields } from '../schema/askEagerness';
import { markStandingAnswersUsed } from '../inbox/clarificationMemory';
import { recordCheckArgs, recordPlanCheck } from '../mail/interpret/responsePlanDraft';
import { applyItemCoverageShadow, itemCoverageShadowFields } from '../mail/interpret/planGate';
import { scheduleTeamBundle, teamBundleValidator } from '../decision/schedule';
import { applyShadowDecision, shadowDecisionFields } from './shadowScorecard';

export const stepWriteValidator = v.union(
	// The scan's verdict when no transition carries it (agent off, a refused guard).
	v.object({ kind: v.literal('security_scan'), securityFlags: securityFlagsValidator }),
	v.object({ kind: v.literal('context_tier'), ...contextTierFields }),
	v.object({ kind: v.literal('draft_output'), ...omit(draftOutputFields, ['draftOptions']) }),
	v.object({ kind: v.literal('draft_plan'), ...recordCheckArgs }),
	v.object({ kind: v.literal('agent_decision'), ...agentDecisionFields }),
	v.object({ kind: v.literal('shadow_decision'), ...shadowDecisionFields }),
	v.object({ kind: v.literal('item_coverage_shadow'), ...itemCoverageShadowFields }),
	v.object({
		kind: v.literal('clarification_ask'),
		...omit(clarificationAskLogFields, ['createdAt']),
	}),
	// The standing answers clarify filled questions from, counted as used.
	v.object({
		kind: v.literal('standing_answers_used'),
		rowIds: v.array(v.id('clarificationMemory')),
	}),
	// A shadow decision bundle scheduled beside the step (`decision/schedule.ts`).
	v.object({ kind: v.literal('decision_bundle'), bundle: teamBundleValidator })
);

export type StepWrite = Infer<typeof stepWriteValidator>;

/**
 * Observations and read-side mirrors: a failure of one is logged and the rest
 * of the commit lands, so it can never keep the step from completing. The
 * scan verdict, the context tier and the draft are not among them: later
 * steps and autonomous paths act on those.
 */
const BEST_EFFORT: ReadonlySet<StepWrite['kind']> = new Set([
	'draft_plan',
	'agent_decision',
	'shadow_decision',
	'item_coverage_shadow',
	'clarification_ask',
	'standing_answers_used',
	'decision_bundle',
]);

/**
 * Whether a step's result may still land: the message is still in the status
 * the step began in, and no person took the reply over. Otherwise the step
 * worked on input that has moved on, and what it decided is dropped.
 */
export function isStepCurrent(
	message: Doc<'inboundMessages'> | null,
	ranIn: string | undefined
): boolean {
	return (
		message !== null &&
		ranIn !== undefined &&
		message.processingStatus === ranIn &&
		message.manualTakeoverAt === undefined
	);
}

/** Apply a step's writes, in the order the step decided them. */
export async function applyStepWrites(
	ctx: MutationCtx,
	inboundMessageId: Id<'inboundMessages'>,
	writes: readonly StepWrite[]
): Promise<void> {
	for (const write of writes) {
		if (!BEST_EFFORT.has(write.kind)) {
			await applyStepWrite(ctx, inboundMessageId, write);
			continue;
		}
		try {
			await applyStepWrite(ctx, inboundMessageId, write);
		} catch (error) {
			logError(`[walker] the step's ${write.kind} write failed:`, error);
		}
	}
}

async function applyStepWrite(
	ctx: MutationCtx,
	inboundMessageId: Id<'inboundMessages'>,
	write: StepWrite
): Promise<void> {
	switch (write.kind) {
		case 'security_scan':
			return applySecurityScan(ctx, inboundMessageId, write.securityFlags);
		case 'context_tier': {
			const { kind: _kind, ...args } = write;
			return applyContextTier(ctx, inboundMessageId, args);
		}
		case 'draft_output': {
			const { kind: _kind, ...args } = write;
			return applyDraftOutput(ctx, inboundMessageId, args);
		}
		case 'draft_plan': {
			const { kind: _kind, ...args } = write;
			await recordPlanCheck(ctx, args);
			return;
		}
		case 'agent_decision': {
			const { kind: _kind, ...args } = write;
			return applyAgentDecision(ctx, inboundMessageId, args);
		}
		case 'shadow_decision': {
			const { kind: _kind, ...args } = write;
			return applyShadowDecision(ctx, inboundMessageId, args);
		}
		case 'item_coverage_shadow':
			return applyItemCoverageShadow(ctx, inboundMessageId, {
				objections: write.objections,
				reason: write.reason,
			});
		case 'clarification_ask': {
			const { kind: _kind, ...args } = write;
			return applyClarificationAsk(ctx, args);
		}
		case 'standing_answers_used':
			return markStandingAnswersUsed(ctx, write.rowIds, Date.now());
		case 'decision_bundle':
			return scheduleTeamBundle(ctx, inboundMessageId, write.bundle);
	}
}
