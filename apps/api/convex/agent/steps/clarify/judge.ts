'use node';

/**
 * The Team Inbox `clarify` step's use of the shared clarification service
 * (`inbox/clarifyJudge.ts`): slot extraction and the judgment of which open
 * slots to ask, on today's fast tier, every call metered under the message's
 * run as `agent_clarify` (a lost ledger row under-counts, it never fails the
 * step). The step itself keeps the pause, the eagerness dial, answer memory,
 * localization and the ask log.
 */

import type { LanguageModel } from 'ai';
import type { ActionCtx } from '../../../_generated/server';
import type { Id } from '../../../_generated/dataModel';
import { meterLlmCall } from '../../../analytics/meteredSpend';
import { addTokenUsage } from '../../../lib/llm/tokenUsage';
import { teamRoot } from '../../shared/agentSpend';
import { rethrowAdmissionRefusal } from '../../../lib/llm/admissionPort';
import {
	extractReplySlots,
	judgeOpenSlots,
	keptIndexes,
	type ClarifySurface,
} from '../../../inbox/clarifyJudge';
import type { ReplySlot } from '../../../inbox/clarificationSlots';
import type { ClarifySlotItem } from './items';
import type { TokenUsage } from '../types';

/** Today's Team surface: one fast-tier model for every stage, `agent_clarify` throughout. */
export function teamClarifySurface(
	ctx: ActionCtx,
	inboundMessageId: Id<'inboundMessages'>,
	model: LanguageModel
): ClarifySurface {
	const root = teamRoot(inboundMessageId);
	return {
		features: { slots: 'agent_clarify', samples: 'agent_clarify', judge: 'agent_clarify' },
		// One fast model for every stage, resolved by the step (`mail.clarify`).
		models: {
			slots: { task: 'mail.clarify' },
			samples: { task: 'mail.clarify_sample', tier: 'fast' },
			judge: { task: 'mail.clarify' },
		},
		model,
		meter: (feature, task, call) =>
			meterLlmCall(ctx, { feature, root, ...(task ? { task } : {}) }, call, {
				onWriteError: 'ignore',
			}),
		subject: { kind: 'inbound_message', inboundMessageId },
		root,
		// The necessity call replaces calls the pipeline held at its own priority.
		priority: 'pipeline',
		// A spend refusal is never a failed sample or judgment: the walker holds
		// the message.
		onCallError: rethrowAdmissionRefusal,
	};
}

/** What the slot and judgment stages found for the step. */
export type TeamSlotOutcome =
	| { readonly kind: 'no_candidate_slots' }
	| { readonly kind: 'insufficient_samples' }
	| { readonly kind: 'necessity_unavailable' }
	| { readonly kind: 'judged'; readonly candidates: ReplySlot[]; readonly keep: number[] };

/**
 * Stage 1 (typed reply slots) and stage 2 (which open, relevant slots to ask)
 * for the Team step. A failure of a model call it does not survive throws,
 * and the step fails soft as before.
 */
export async function teamOpenSlots(
	ctx: ActionCtx,
	surface: ClarifySurface,
	context: string,
	items: readonly ClarifySlotItem[]
): Promise<{ outcome: TeamSlotOutcome; tokenUsage?: TokenUsage; modelUsed?: string }> {
	const extracted = await extractReplySlots(ctx, surface, context, items);
	const usage = { modelUsed: extracted.modelUsed };
	// Candidate slots: unanswerable from context AND decision-relevant. A
	// converging assumption on an answerable or irrelevant slot is not worth a question.
	const candidates = extracted.slots.filter(
		(slot) => !slot.answerableFromContext && slot.decisionRelevant
	);
	if (candidates.length === 0) {
		return { outcome: { kind: 'no_candidate_slots' }, tokenUsage: extracted.tokenUsage, ...usage };
	}
	const judged = await judgeOpenSlots(ctx, surface, context, candidates);
	const tokenUsage = addTokenUsage(extracted.tokenUsage, judged.tokenUsage);
	const { judgment } = judged;
	if (judgment.kind === 'insufficient_samples' || judgment.kind === 'unjudged') {
		const kind = judgment.kind === 'unjudged' ? 'necessity_unavailable' : judgment.kind;
		return { outcome: { kind }, tokenUsage, ...usage };
	}
	return {
		outcome: { kind: 'judged', candidates, keep: keptIndexes(judgment, candidates.length) },
		tokenUsage,
		...usage,
	};
}
