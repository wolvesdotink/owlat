import { v, type Infer } from 'convex/values';

/**
 * Why a cancelled automation run ended, when the reason is a health problem
 * the automations list reports (`automations/health.ts`):
 *   - `step_failed`: a step failed on its own (its retries ran out, it was
 *     interrupted past recovery, or the run hit the step-execution cap);
 *   - `stalled`: the stalled-run sweep found the run with no active step and
 *     ended it.
 * Absent on every other run, including runs cancelled because the automation
 * was paused, the contact was deleted or a step was removed: those are not
 * failures of the automation.
 */
export const automationRunEndReasonValidator = v.union(
	v.literal('step_failed'),
	v.literal('stalled')
);

export type AutomationRunEndReason = Infer<typeof automationRunEndReasonValidator>;
