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

/** {@link prepareAskTarget} for an Answer mode action. A failed ask reads as `preparing`. */
export async function prepareAskTargetForConsumer(
	ctx: Pick<ActionCtx, 'runMutation'>,
	target: AnswerAskTarget
): Promise<FullReadState> {
	if (target.kind !== 'mailDraft') return 'ready';
	try {
		return await ctx.runMutation(internal.mail.interpret.fullRead.prepareAskTarget, { target });
	} catch {
		return 'preparing'; // unknown: no model call on a thread that may not be fully read
	}
}

/** The action side: ask before reading the plan. A failed ask reads as `preparing`. */
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
		return 'preparing'; // unknown: no model call on a thread that may not be fully read
	}
}

/** How long an interactive consumer waits for a thread's upgrade before it answers `preparing`. */
export const INTERACTIVE_FULL_READ_WAIT_MS = 45_000;
const INTERACTIVE_POLL_MS = 1_500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Prepare, then wait (bounded) until the thread is fully read: Answer mode
 * and the coverage check, whose person is waiting for the answer anyway.
 * `preparing` when the upgrade did not land in time: the caller calls no model.
 */
export async function awaitFullRead(
	ctx: Pick<ActionCtx, 'runMutation' | 'runQuery'>,
	ref: ThreadRef,
	opts: { timeoutMs?: number; pollMs?: number } = {}
): Promise<FullReadState> {
	if ((await prepareThreadForConsumer(ctx, ref)) === 'ready') return 'ready';
	return pollUntilFullyRead(
		() => ctx.runQuery(internal.mail.interpret.fullRead.fullyRead, { threadRef: ref }),
		opts
	);
}

/** {@link awaitFullRead} for an Answer mode ask target. */
export async function awaitAskTargetFullRead(
	ctx: Pick<ActionCtx, 'runMutation' | 'runQuery'>,
	target: AnswerAskTarget,
	opts: { timeoutMs?: number; pollMs?: number } = {}
): Promise<FullReadState> {
	if ((await prepareAskTargetForConsumer(ctx, target)) === 'ready') return 'ready';
	return pollUntilFullyRead(
		() => ctx.runQuery(internal.mail.interpret.fullRead.askTargetFullyRead, { target }),
		opts
	);
}

async function pollUntilFullyRead(
	isFullyRead: () => Promise<boolean>,
	opts: { timeoutMs?: number; pollMs?: number }
): Promise<FullReadState> {
	const deadline = Date.now() + (opts.timeoutMs ?? INTERACTIVE_FULL_READ_WAIT_MS);
	const pollMs = opts.pollMs ?? INTERACTIVE_POLL_MS;
	while (Date.now() < deadline) {
		await sleep(pollMs);
		if (await isFullyRead()) return 'ready';
	}
	return 'preparing';
}
