'use node';

/**
 * Spend admission for a Phase 2 bundle call: the thin
 * seam between the decisions lane and the admission lane.
 *
 * A bundle call is paid traffic on the inbound path, so it may run only under
 * admission:
 *
 * - `shadow`: inside the shadow allowance, through the admission lane's
 *   `analytics/shadowAdmission.ts` `admitShadow` (the task's switch at
 *   `shadow`, the counted message share, the shadow money limit, background
 *   priority, budget class `shadow`).
 * - `advisory`: an ordinary reservation at background priority on the task's
 *   own budget class, through `analytics/admissionPorts.ts`
 *   `dispatchAdmissionPort`.
 *
 * Either way the language rung meters `target`, and the decision rung passes
 * `decision` (the admission port and the usage recorder) to `runDecision`.
 *
 * A refusal later, at the dispatch (another call took the headroom first), is
 * an `AdmissionRefusedError` from the call: the run fails the artifact lease
 * and no request was sent.
 */

import type { ActionCtx } from '../_generated/server';
import type { LlmSpendTarget } from '../analytics/meteredSpend';
import { admitShadow } from '../analytics/shadowAdmission';
import { dispatchAdmissionPort } from '../analytics/admissionPorts';
import { decisionUsageRecorder } from '../lib/decision/ports';
import type { RunDecisionOptions } from '../lib/decision/contract';
import type { LlmRootContext } from '../lib/llm/requestMeter';
import type { LlmUsagePlane } from '../lib/llmUsageTags';
import type { QuestionSet } from '../lib/decision/questions';
import type { BundleMode } from '../lib/decision/routing';
import type { DecisionBundleTask } from '../lib/decision/bundles';
import type { AdmissionPriority } from '../lib/validators/aiRouting';

/** What `runDecision` takes from admission: the usage recorder and the admission port. */
export type AdmittedDecisionOptions = Pick<
	RunDecisionOptions<QuestionSet>,
	'recordUsage' | 'admission' | 'requestId'
>;

export type BundleAdmission =
	| {
			readonly isAdmitted: true;
			/** The meter target of a language-rung call. */
			readonly target: LlmSpendTarget;
			/** Spread into `runDecision` on the decision rung. */
			readonly decision: AdmittedDecisionOptions;
	  }
	| {
			readonly isAdmitted: false;
			readonly why: 'not_shadowed' | 'not_sampled' | 'no_allowance';
	  };

export interface BundleAdmissionRequest {
	readonly task: DecisionBundleTask;
	readonly mode: BundleMode;
	/** The message the call judges (its id): the shadow sample is keyed on it. */
	readonly subjectKey: string;
	readonly feature: string;
	readonly root: LlmRootContext;
	readonly policyVersion: number;
	/**
	 * The selected rung's plane: `decision` on the decision rung, `language` on
	 * the language rung. Headroom, holds, caps and ledger rows all use it (Sol r7 F1).
	 */
	readonly plane: LlmUsagePlane;
	/**
	 * The priority an advisory call is held at: background unless the caller
	 * waits on it (Answer mode's necessity judgment is `interactive`).
	 */
	readonly priority?: AdmissionPriority;
}

/**
 * A caller's own hold, sized before it bought anything for the calls this
 * bundle will make (an interpretation run's hold covers its claim checks):
 * the call carries the hold's id and its pre-assigned request id, reserves
 * nothing of its own and so cannot be refused halfway, and reports every
 * provider request it makes so the hold settles against them (`count`).
 */
export interface OuterHold {
	readonly reservationId: string;
	readonly requestId: string;
	count(requests: number): void;
}

/** An advisory call under the caller's {@link OuterHold}: admitted, nothing more reserved. */
export function admitUnderOuterHold(
	ctx: ActionCtx,
	request: Omit<BundleAdmissionRequest, 'mode' | 'subjectKey' | 'priority'>,
	hold: OuterHold
): Extract<BundleAdmission, { isAdmitted: true }> {
	const recorder = decisionUsageRecorder(ctx, { reservationId: hold.reservationId });
	// Each provider request counts ONCE: a batch whose write failed stays
	// pending on the dispatch and is sent again with the next attempt's, so the
	// same (request, attempt) can reach the recorder twice (Sol r4 F3).
	const counted = new Set<string>();
	return {
		isAdmitted: true,
		target: {
			feature: request.feature,
			task: request.task,
			root: request.root,
			policyVersion: request.policyVersion,
			plane: request.plane,
			reservationId: hold.reservationId,
			requestId: hold.requestId,
		},
		decision: {
			requestId: hold.requestId,
			recordUsage: async (record) => {
				let fresh = 0;
				for (const request of record.requests) {
					const key = `${record.requestId}:${request.attempt}`;
					if (counted.has(key)) continue;
					counted.add(key);
					fresh += 1;
				}
				if (fresh > 0) hold.count(fresh);
				await recorder(record);
			},
		},
	};
}

export async function admitBundle(
	ctx: ActionCtx,
	request: BundleAdmissionRequest
): Promise<BundleAdmission> {
	if (request.mode === 'shadow') {
		// The switch, the counted message quota, the shadow allowance.
		const shadow = await admitShadow(ctx, {
			task: request.task,
			subjectKey: request.subjectKey,
			feature: request.feature,
			root: request.root,
			plane: request.plane,
		});
		if (!shadow.isAdmitted) return { isAdmitted: false, why: shadow.why };
		return {
			isAdmitted: true,
			target: shadow.target,
			decision: {
				...(shadow.admission ? { admission: shadow.admission } : {}),
				recordUsage: decisionUsageRecorder(ctx, { budgetClass: 'shadow' }),
			},
		};
	}
	// Advisory: an ordinary hold on the task's own class, at background priority
	// unless the caller waits on it (Answer mode's necessity judgment).
	const shape = {
		root: request.root,
		priority: request.priority ?? ('background' as const),
		plane: request.plane,
	};
	const admission = dispatchAdmissionPort(ctx, shape, request.task, request.root.deadlineAt);
	return {
		isAdmitted: true,
		target: {
			feature: request.feature,
			task: request.task,
			policyVersion: request.policyVersion,
			...shape,
		},
		decision: {
			...(admission ? { admission } : {}),
			recordUsage: decisionUsageRecorder(ctx),
		},
	};
}
