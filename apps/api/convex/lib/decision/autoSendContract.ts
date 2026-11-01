/**
 * How a decision verdict may feed the auto-send score. Pure and isolate-safe.
 *
 * The route step compares one number with the auto-approve threshold:
 * `resolveAutoApproveScore` (`agent/steps/route/index.ts`), today the draft's
 * self-check score. A decision verdict may enter that number only through
 * this module, and only to LOWER it:
 *
 *   1. Its task is registered as feeding auto-send (`AUTO_SEND_VERDICT_TASKS`,
 *      `./calibration.ts`). The list is EMPTY: nothing feeds the score today.
 *   2. Item coverage is enforced (`agentConfig.isItemCoverageEnforced`). That
 *      is the plan's prerequisite for any decision-driven autonomous input,
 *      so without it the verdict is refused here, the `decision_verdict` gate
 *      holds every send ({@link decisionAutonomyProblem}), and the setting
 *      cannot be switched off while a task feeds (`agent/configMutations.ts`).
 *   3. It passes the decisions lane's block-only rule (`verdictBlockReason`):
 *      a complete, unexpired, uninvalidated advisory answer under the current
 *      policy, from the decision plane configured now (compatible
 *      provenance), from a calibrated adapter, with the checked-in
 *      calibration revision for its task and the message's language.
 *   4. Its score is a probability in [0, 1].
 *
 * {@link admitVerdictScore} is the only way to make an
 * {@link AdmittedVerdictScore}, and {@link restrictedAutoApproveScore} takes
 * the minimum, so a verdict can hold a draft back and can never push one over
 * the threshold. The `decision_verdict` gate re-checks every verdict of a
 * feeding task at send time, whatever reached the score.
 */

import type { AiTaskName } from '@owlat/shared/aiRouting';
import {
	AUTO_SEND_VERDICT_TASKS,
	verdictBlockReason,
	type StoredVerdict,
	type VerdictContext,
} from './calibration';

declare const ADMITTED: unique symbol;

/** A verdict's score the contract accepted. Only {@link admitVerdictScore} makes one. */
export type AdmittedVerdictScore = Readonly<{
	task: AiTaskName;
	score: number;
	[ADMITTED]: true;
}>;

/** What the contract checks a verdict against at route time. */
export interface AutoSendContractContext extends VerdictContext {
	/** `agentConfig.isItemCoverageEnforced`. */
	readonly isItemCoverageEnforced: boolean;
	/** The tasks that feed auto-send. Defaults to the checked-in (empty) list. */
	readonly verdictTasks?: readonly AiTaskName[];
}

/**
 * Why decision-driven autonomous input may not run, or null. Any task that
 * feeds auto-send needs item coverage enforced first (the plan's
 * prerequisite rule).
 */
export function decisionAutonomyProblem(opts: {
	readonly verdictTasks: readonly AiTaskName[];
	readonly isItemCoverageEnforced: boolean;
}): string | null {
	if (opts.verdictTasks.length === 0 || opts.isItemCoverageEnforced) return null;
	return 'Decision verdicts feed auto-send only while item coverage is enforced';
}

/**
 * The verdict's score, admitted for the auto-approve comparison, or null when
 * the contract refuses it (see the module comment, rules 1 to 4).
 */
export function admitVerdictScore(
	verdict: StoredVerdict,
	score: number,
	context: AutoSendContractContext
): AdmittedVerdictScore | null {
	const verdictTasks = context.verdictTasks ?? AUTO_SEND_VERDICT_TASKS;
	if (!verdictTasks.includes(verdict.task)) return null;
	const { isItemCoverageEnforced } = context;
	if (decisionAutonomyProblem({ verdictTasks, isItemCoverageEnforced })) return null;
	if (verdictBlockReason(verdict, context) !== null) return null;
	if (!Number.isFinite(score) || score < 0 || score > 1) return null;
	return { task: verdict.task, score } as AdmittedVerdictScore;
}

/** The auto-approve score with admitted verdicts applied: never above `draftScore`. */
export function restrictedAutoApproveScore(
	draftScore: number,
	verdicts: readonly AdmittedVerdictScore[]
): number {
	return verdicts.reduce((lowest, verdict) => Math.min(lowest, verdict.score), draftScore);
}
