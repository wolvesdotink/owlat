'use node';

/**
 * Spend admission for a Phase 2 bundle call (ADR-0073 §2, D1, D4): the thin
 * seam between the decisions lane and the admission lane.
 *
 * A bundle call is paid traffic on the inbound path, so it may run only under
 * admission:
 *
 * - `shadow`: inside the D4 allowance, through the admission lane's
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
import type { QuestionSet } from '../lib/decision/questions';
import type { BundleMode } from '../lib/decision/routing';
import type { DecisionBundleTask } from '../lib/decision/bundles';

/** What `runDecision` takes from admission: the usage recorder and the admission port. */
export type AdmittedDecisionOptions = Pick<
	RunDecisionOptions<QuestionSet>,
	'recordUsage' | 'admission'
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
}

export async function admitBundle(
	ctx: ActionCtx,
	request: BundleAdmissionRequest
): Promise<BundleAdmission> {
	if (request.mode === 'shadow') {
		// D4: the switch, the counted message quota, the shadow allowance.
		const shadow = await admitShadow(ctx, {
			task: request.task,
			subjectKey: request.subjectKey,
			feature: request.feature,
			root: request.root,
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
	// Advisory: an ordinary hold, at background priority, on the task's own class.
	const shape = { root: request.root, priority: 'background' as const };
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
