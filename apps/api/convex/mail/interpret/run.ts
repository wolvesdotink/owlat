'use node';

/**
 * `interpretMessage` (SPEC §4 `run.ts`): interpret one message and fold it
 * into its thread.
 *
 *   0. lease     one run per source (`lease.ts`): held elsewhere → `busy`
 *   1. load      thread, mode, the eligibility snapshot taken at enqueue
 *                (`sources.ts`; none → not interpreted), brief revision, items, facts
 *   2. eligible? an ineligible message is recorded as skipped and stops here
 *   3. scope     signed-block scoping, undecryptable → skipped; the body
 *                fingerprint the reducer rechecks
 *   4. segment   `segmentMessage` (stable ids) → content revision
 *   5. dedupe    an applied extraction of this revision + extractor is reused,
 *                unless it is incomplete and its retry is due (`retry.ts`)
 *   6. gate      `ai` flag and the spend ceiling (`gate.ts`)
 *   6b. hold     one spend hold for the extraction and the verifier's maximum
 *                (`runHold.ts`); refused, the run defers, backed off, unspent
 *   7. model     `runLlmObject` on the `extract` tier, temperature 0, metered
 *                as `interpret`, drawing on the hold
 *   8. ground    every claim's quotes verbatim in the named segment
 *   9. verify    consequential claims on the `guard` tier (`verify.ts`), capped and
 *               routed by the policy (`verifyRoute.ts`)
 *  10. reduce    `applyInterpretation`, compare-and-set, retried when stale;
 *                a changed body or mode starts the run over once
 *
 * Read on arrival (SPEC §2.3): between 5 and 6 an arrival read decides how
 * deep it goes (`arrivalRun.ts`, `arrivalDecide.ts`): full as above, a gist
 * (`gist.ts`), or a count / nothing settled without a model call. Steps 1–10
 * of one attempt live in `runOnce.ts`.
 *
 * FAIL-SOFT: any refusal or failure records a `failed` extraction, so the brief says
 * it is incomplete. Never deletes items, never reads as "nothing to do", never throws.
 * `runInterpretation` is the plain core the wiring calls inside its own actions
 * (needs-reply, the team context step); `interpretMessage` is its action.
 */

import { v } from 'convex/values';
import { internalAction, type ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { admissionAnswer, screenCountedArrival } from './arrivalRun';
import {
	interpretModeValidator,
	interpretationSourceValidator,
	type InterpretationSource,
} from '../../lib/validators/threadBrief';
import { predecessorRoot, predecessorsPending, runDeferredPredecessors } from './defer';
import type { InterpretArgs, InterpretRunResult, Restart } from './runShape';
import { withSourceLease } from './runApply';
import { recordRestartFailure, runOnce } from './runOnce';
import { anchorActionDeadline } from '../../lib/llm/actionDeadline';
import { llmRootContextValidator } from '../../lib/llmUsageTags';
import { depthValidator } from '../../lib/validators/arrival';

export type { InterpretArgs, InterpretRunResult } from './runShape';

/** Whole-run attempts when the body or the thread's mode changed under it. */
const MAX_RUN_ATTEMPTS = 2;

/** Interpret one message (see the module doc). Never throws. */
export async function runInterpretation(
	ctx: ActionCtx,
	args: InterpretArgs
): Promise<InterpretRunResult> {
	anchorActionDeadline(ctx); // one model budget per action, from here (ADR-0073)
	// One run per source at a time (lease.ts): claimed before anything is read or bought.
	return withSourceLease(ctx, args.source, args.depth, (leaseToken) =>
		runLeased(ctx, { ...args, leaseToken })
	);
}

async function runLeased(ctx: ActionCtx, args: InterpretArgs): Promise<InterpretRunResult> {
	// Read on arrival: admitted before anything is read, predecessors included (Sol r1 F3/F4).
	if (args.source.kind === 'mail') {
		const admitted = await ctx.runMutation(internal.mail.interpret.arrivalAdmit.admitArrivalRun, {
			source: { kind: 'mail', id: args.source.id },
			...(args.leaseToken ? { leaseToken: args.leaseToken } : {}),
			...(args.depth ? { depth: args.depth } : {}),
			...(args.isUpgrade ? { isUpgrade: true } : {}),
			isCallerResuming: args.predecessors !== undefined,
			...(args.parentSource ? { parentSource: args.parentSource } : {}),
		});
		if (admitted.kind === 'settled') {
			// Counted over the owner limit unread: its text is still screened (#1384).
			await screenCountedArrival(
				ctx,
				{ ...args, source: { kind: 'mail', id: args.source.id } },
				admitted.deletionEpoch
			);
		}
		if (admitted.kind !== 'go') return admissionAnswer(admitted);
	}
	// D10: earlier deferred mail of the thread first, under the caller's deadline (defer.ts).
	const deadlineAt = args.root?.deadlineAt;
	// Each is read in full: a deferred one as today, an upgradeable one (read on
	// arrival as gist or count) because this source needs the whole thread.
	const readFirst = (source: InterpretationSource) =>
		runInterpretation(ctx, {
			source,
			predecessors: 'already_read',
			parentSource: args.source,
			depth: 'full',
			...predecessorRoot(source, deadlineAt),
		});
	const pending = await runDeferredPredecessors(ctx, args.source, readFirst, args);
	if (pending) return predecessorsPending(pending);
	let reason: Restart['restart'] = 'sourceChanged';
	for (let attempt = 0; attempt < MAX_RUN_ATTEMPTS; attempt++) {
		const out = await runOnce(ctx, args);
		if (!('restart' in out)) return out;
		reason = out.restart;
	}
	return recordRestartFailure(ctx, args, reason);
}

/** The schedulable entry point (wiring: delivery, outbound lifecycle, team pipeline). */
export const interpretMessage = internalAction({
	args: {
		source: interpretationSourceValidator,
		// Accepted for older callers and ignored (see InterpretArgs).
		mode: v.optional(interpretModeValidator),
		isLive: v.optional(v.boolean()),
		precedence: v.optional(v.string()),
		listId: v.optional(v.string()),
		root: v.optional(llmRootContextValidator),
		depth: v.optional(depthValidator),
		isUpgrade: v.optional(v.boolean()),
	},
	handler: async (ctx, args): Promise<InterpretRunResult> => runInterpretation(ctx, args),
});
