/**
 * Read on arrival, the run's side (SPEC §2.3): which runs are arrival reads,
 * the depth decision once the message is scoped (`arrivalDecide.ts`), and
 * the answers a run gives for the outcomes that end it there.
 *
 * An arrival read is a run of a received Postbox message of a personal
 * mailbox that was not asked for a full read. Opening a thread (`lazy.ts`)
 * and the upgrade of a thread's earlier mail (`defer.ts`) ask for `full`;
 * delivery, the category wake and its ceiling, and the stale sweep do not.
 *
 * Isolate-safe; not a Convex function.
 */

import type { ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import type { SegmentedMessage } from '@owlat/shared/mailSegments';
import { detectExactWording } from '@owlat/shared/exactWordingDetector';
import { freshTextOf } from '../arrival/scopedInput';
import { logWarn } from '../../lib/runtimeLog';
import { isSecurityMail } from './eligibility';
import { scopeForInterpretation, segmentScoped } from './scope';
import type { ArrivalVerdict } from './arrivalDecide';
import type { ArrivalAdmission } from './arrivalAdmit';
import type { InterpretArgs, InterpretRunResult } from './runShape';

/** The `errorCode` of a run that settled its source short of a full read. */
export const ARRIVAL_SETTLED = 'arrival_settled';

/** Whether this run is an arrival read (see the module doc). Pure. */
export function isArrivalRead(
	args: Pick<InterpretArgs, 'source' | 'depth'>,
	loaded: { direction: 'inbound' | 'outbound'; mode: 'brief' | 'actions' }
): args is InterpretArgs & { source: { kind: 'mail' } } {
	return (
		args.depth !== 'full' &&
		args.source.kind === 'mail' &&
		loaded.direction === 'inbound' &&
		loaded.mode === 'brief'
	);
}

/** Ask how deep to read, with the security-mail and exact-wording screens of the scoped text. */
export async function decideArrival(
	ctx: Pick<ActionCtx, 'runMutation'>,
	args: InterpretArgs & { source: { kind: 'mail' } },
	scoped: { subject: string; segmented: SegmentedMessage },
	deletionEpoch: number
): Promise<ArrivalVerdict> {
	const fresh = freshTextOf(scoped.segmented);
	return ctx.runMutation(internal.mail.interpret.arrivalDecide.decideArrivalDepth, {
		source: { kind: 'mail', id: args.source.id },
		...(args.leaseToken ? { leaseToken: args.leaseToken } : {}),
		deletionEpoch,
		isSecurityMail: isSecurityMail({ subject: scoped.subject, freshText: fresh }),
		isExactWordingCandidate:
			detectExactWording({ subject: scoped.subject, text: fresh }).length > 0,
	});
}

/**
 * Admission counted a display-only source over the owner limit before
 * anything of it was read: still screen its own text for exact wording, so a
 * candidate is never placed in the digest or updates (#1384). No model call;
 * a fenced thread or a scope that fails screens nothing.
 */
export async function screenCountedArrival(
	ctx: ActionCtx,
	args: InterpretArgs & { source: { kind: 'mail' } }
): Promise<void> {
	const source = { kind: 'mail' as const, id: args.source.id };
	try {
		if (await ctx.runQuery(internal.mail.interpret.staleFence.isSourceFenced, { source })) return;
		const scoped = await scopeForInterpretation(ctx, source);
		if (!scoped || !scoped.ok) return;
		const { segmented } = segmentScoped(scoped);
		const fresh = freshTextOf(segmented);
		if (detectExactWording({ subject: scoped.subject, text: fresh }).length === 0) return;
		await ctx.runMutation(internal.mail.interpret.arrivalDecide.noteCountedArrivalScreen, {
			source,
			isExactWordingCandidate: true,
		});
	} catch (error) {
		logWarn('[arrival] exact-wording screen of a counted source failed', error);
	}
}

/** What a run answers for a source settled without a full read. */
export function settledAnswer(depth: string): InterpretRunResult {
	return {
		status: 'skipped',
		isReplayed: false,
		createdItemIds: [],
		errorCode: `${ARRIVAL_SETTLED}_${depth}`,
	};
}

/** The run's answer for an admission that stops it before anything is read. */
export function admissionAnswer(
	admitted: Exclude<ArrivalAdmission, { kind: 'go' }>
): InterpretRunResult {
	if (admitted.kind === 'settled') return settledAnswer('count');
	if (admitted.kind === 'done') return { status: 'done' };
	return { status: admitted.kind, retryAt: admitted.retryAt };
}

/** The run's answer for every verdict that ends it before the model (not `full` / `gist`). */
export function arrivalAnswer(
	verdict: Exclude<ArrivalVerdict, { kind: 'full' } | { kind: 'gist' }>
): InterpretRunResult {
	switch (verdict.kind) {
		case 'settled':
			return settledAnswer(verdict.depth);
		case 'wait':
			return { status: 'wait', retryAt: verdict.retryAt };
		case 'busy':
			return { status: 'busy', retryAt: verdict.retryAt };
		case 'done':
			return { status: 'done' };
		case 'gone':
			return { status: 'gone' };
	}
}

/**
 * A display-only arrival read whose spend was refused after the decision, or
 * whose gist could not be read: settled as an upgradeable count (§2.6).
 */
export async function countArrival(
	ctx: Pick<ActionCtx, 'runMutation'>,
	args: InterpretArgs & { source: { kind: 'mail' } },
	reason: 'budget' | 'gistUnavailable' | 'gistFailed',
	deletionEpoch: number
): Promise<InterpretRunResult> {
	const outcome = await ctx.runMutation(internal.mail.interpret.arrivalDecide.settleArrivalCount, {
		source: { kind: 'mail', id: args.source.id },
		...(args.leaseToken ? { leaseToken: args.leaseToken } : {}),
		deletionEpoch,
		reason,
	});
	if (outcome === 'gone') return { status: 'gone' };
	if (outcome === 'busy') return { status: 'busy', retryAt: Date.now() };
	return settledAnswer('count');
}
