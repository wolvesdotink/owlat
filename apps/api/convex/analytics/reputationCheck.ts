/**
 * The reputation check (module) — the hourly step that enforces sending
 * reputation and lifts its own suspensions. The decisions are pure
 * (`reputationEnforcement.ts`, `reputationResume.ts`); this shell loads the
 * evidence, calls them and hands the outcome to the **Abuse status (module)**.
 */

import { internal } from '../_generated/api';
import { internalMutation } from '../lib/writeFence';
import { decideReputationEnforcement } from './reputationEnforcement';
import { decideAutoClear, resumeReason } from './reputationResume';
import { readEnforcementEvidence, readResumeCondition } from './reputationEvidence';

/**
 * The auto-enforce step, off the hot path. Runs on the reputation cron:
 * summarizes the org window once, reads each domain's latest Gmail spam rate
 * from Google Postmaster, and escalates the deployment's Abuse status on what
 * `decideReputationEnforcement` calls for. This is the one wide `.collect()` of
 * the org window per cron tick rather than per send-event — the move that
 * removes the read-amplification from `recordEvent`.
 *
 * Enforcement lives only here; `recordEvent` has no per-event trigger. It fires
 * while the evidence stays over the line; the Abuse status module dedupes the
 * transition idempotently, so the hourly check enforces the same policy a
 * per-event one would. A trigger a platform admin's lift put on hold is left
 * out until the hold ends.
 *
 * The same step clears a suspension or a warning the check set once its
 * trigger has cleared (`reputationResume.ts` holds the rule). A suspension
 * waits instead when the instance requires a platform admin to lift it.
 */
export const evaluateAutoEnforce = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const settings = await ctx.db.query('instanceSettings').first();
		const evidence = await readEnforcementEvidence(ctx.db, now);
		const org = evidence.org;
		const decision = decideReputationEnforcement({
			...evidence,
			hold: settings?.reputationCheckHold ?? null,
		});
		const status = settings?.abuseStatus;
		const checked = status === 'suspended' || status === 'warned' ? status : null;
		const trigger = settings?.abuseStatusTrigger;
		const condition =
			trigger && checked ? await readResumeCondition(ctx.db, trigger, org, now, checked) : null;
		const isClearing = decideAutoClear({
			status,
			trigger,
			isManualResumeRequired: settings?.isSendingResumeManual === true,
			call: decision?.riskLevel ?? null,
			condition,
		});
		if (isClearing && checked && trigger && condition) {
			await ctx.runMutation(internal.workspaces.abuseStatus.transition, {
				input: {
					to: 'clean',
					at: now,
					reason: resumeReason(condition, checked),
					changedBy: 'system',
					trigger,
				},
			});
		}
		// A status stays on its trigger until that one clears: handing it to
		// another metric first could clear it while the first is still over its
		// clear line. A warning that escalates takes the trigger that suspends.
		const keepsTrigger =
			condition !== null &&
			!condition.isClear &&
			(status === 'suspended' || (status === 'warned' && decision?.riskLevel === 'high'));
		// Applied in this mutation, not queued: the decision was made on the hold
		// read above, and a platform admin's lift committed in between would
		// otherwise be undone by it.
		if (decision) {
			await ctx.runMutation(internal.workspaces.abuseStatus.transition, {
				input: {
					to: decision.riskLevel === 'critical' ? 'suspended' : 'warned',
					at: now,
					reason: decision.reason,
					changedBy: 'system',
					...(keepsTrigger ? {} : { trigger: decision.trigger }),
				},
			});
		}
		return { riskLevel: org.riskLevel };
	},
});
