/**
 * The consumers' side of the full-read prerequisite (`fullRead.ts`, Sol r1
 * F2): an action asks before it reads the thread's plan. Split out so the
 * entry points have their callers outside their own module.
 */

import type { ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import type { ThreadRef } from '../../lib/validators/threadRef';
import type { AnswerAskTarget } from '../../lib/validators/answerAsk';
import type { FullReadState } from './fullRead';

/** {@link prepareAskTarget} for an Answer mode action. Fail-soft. */
export async function prepareAskTargetForConsumer(
	ctx: Pick<ActionCtx, 'runMutation'>,
	target: AnswerAskTarget
): Promise<FullReadState> {
	if (target.kind !== 'mailDraft') return 'ready';
	try {
		return await ctx.runMutation(internal.mail.interpret.fullRead.prepareAskTarget, { target });
	} catch {
		return 'ready';
	}
}

/** The action side: ask before reading the plan. Fail-soft: a failed ask reads as before. */
export async function prepareThreadForConsumer(
	ctx: Pick<ActionCtx, 'runMutation'>,
	ref: ThreadRef
): Promise<FullReadState> {
	if (ref.kind !== 'mail') return 'ready';
	try {
		return await ctx.runMutation(internal.mail.interpret.fullRead.prepareThread, {
			threadRef: ref,
		});
	} catch {
		return 'ready';
	}
}
