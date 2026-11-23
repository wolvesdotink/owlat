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

/**
 * Why a step run failed, from a closed set the runs panel turns into one
 * translated sentence and, where a page fixes it, a link. Stored next to the
 * step run's English `errorMessage`, which stays the detail.
 *
 * The first three are the non-campaign send intake's deployment gates, named
 * with the campaign pre-flight's codes for the same gate
 * (`campaigns/refusalCopy.ts`), so the web app's one map of fix pages serves
 * both:
 *   - `no_delivery_provider`: no transport is set up;
 *   - `domain_not_verified`: the default sender is not on a verified sending
 *     domain;
 *   - `sending_not_allowed`: sending is suspended on this instance.
 * The rest are the automation's own:
 *   - `no_default_sender`: the instance has no default sender address;
 *   - `template_missing` / `template_empty`: the email step names no email, a
 *     deleted one, or one without HTML;
 *   - `contact_no_email`: the contact has no email address;
 *   - `invalid_step_config`: the step's config does not parse;
 *   - `plugin_denied`: the plugin step's plugin is off or lacks its grant;
 *   - `plugin_failed`: the plugin step failed or is not in this build;
 *   - `interrupted`: the step kept dying past its recovery budget;
 *   - `step_limit`: the run hit the step-execution cap (a condition loop);
 *   - `unknown`: anything else, including every failed step run written
 *     before codes existed. The stored sentence is all it has.
 */
export const automationStepFailureReasonValidator = v.union(
	v.literal('no_delivery_provider'),
	v.literal('domain_not_verified'),
	v.literal('sending_not_allowed'),
	v.literal('no_default_sender'),
	v.literal('template_missing'),
	v.literal('template_empty'),
	v.literal('contact_no_email'),
	v.literal('invalid_step_config'),
	v.literal('plugin_denied'),
	v.literal('plugin_failed'),
	v.literal('interrupted'),
	v.literal('step_limit'),
	v.literal('unknown')
);

export type AutomationStepFailureReason = Infer<typeof automationStepFailureReasonValidator>;

/**
 * The failure reasons an email step waits out instead of failing
 * (`automations/configurationWait.ts`). Each is a fault of the instance's
 * sending setup that a person fixes on a settings page, outside the
 * automation, and that a later attempt of the same step passes unchanged once
 * it is fixed:
 *   - `no_delivery_provider`: a transport gets set up;
 *   - `domain_not_verified`: the default sender's domain finishes DNS
 *     verification, which often takes a while by itself;
 *   - `sending_not_allowed`: an operator lifts the suspension, a deliberate
 *     decision that sending may go on, and the send re-checks it;
 *   - `no_default_sender`: a default sender gets set.
 * Not waited out, because waiting fixes nothing without an edit to the
 * automation or the contact, and that edit is what restarts mail for the
 * contacts who enter afterwards: `template_missing`, `template_empty`,
 * `invalid_step_config`, `contact_no_email`. Neither are the plugin codes (a
 * plugin's failure is its own, not the instance's sending setup), `interrupted`
 * and `step_limit` (faults of the run itself) or `unknown`.
 */
export const automationStepWaitReasonValidator = v.union(
	v.literal('no_delivery_provider'),
	v.literal('domain_not_verified'),
	v.literal('sending_not_allowed'),
	v.literal('no_default_sender')
);

export type AutomationStepWaitReason = Infer<typeof automationStepWaitReasonValidator>;
