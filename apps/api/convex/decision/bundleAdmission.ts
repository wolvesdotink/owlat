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
 * Until the admission lane is merged into this branch, this seam admits
 * NOTHING: no paid bundle call can run without a reservation. Every switch is
 * off by default, so that changes nothing today.
 */

import type { ActionCtx } from '../_generated/server';
import type { LlmSpendTarget } from '../analytics/meteredSpend';
import type { RunDecisionOptions } from '../lib/decision/contract';
import type { LlmRootContext } from '../lib/llm/requestMeter';
import type { QuestionSet } from '../lib/decision/questions';
import type { BundleMode } from '../lib/decision/routing';
import type { DecisionBundleTask } from '../lib/decision/bundles';

/** What `runDecision` takes from admission: the usage recorder (and, merged, the port). */
export type AdmittedDecisionOptions = Pick<RunDecisionOptions<QuestionSet>, 'recordUsage'>;

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
			readonly why: 'not_shadowed' | 'not_sampled' | 'no_allowance' | 'admission_unavailable';
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
	_ctx: ActionCtx,
	_request: BundleAdmissionRequest
): Promise<BundleAdmission> {
	return { isAdmitted: false, why: 'admission_unavailable' };
}
