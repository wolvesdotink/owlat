/**
 * The reputation check (module) — the hourly step that enforces sending
 * reputation and lifts its own suspensions. The decisions are pure
 * (`reputationEnforcement.ts`, `reputationResume.ts`); this shell loads the
 * evidence, calls them and hands the outcome to the **Abuse status (module)**.
 */

import { internal } from '../_generated/api';
import { internalMutation } from '../lib/writeFence';
import { decideReputationEnforcement } from './reputationEnforcement';
import { decideAutoResume, resumeReason } from './reputationResume';
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
 * The same step lifts a suspension the check imposed once its trigger has
 * cleared (`reputationResume.ts` holds the rule), unless the instance requires
 * a platform admin to lift it.
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
		const trigger = settings?.abuseStatusTrigger;
		const condition = trigger ? await readResumeCondition(ctx.db, trigger, org, now) : null;
		const isResuming = decideAutoResume({
			status: settings?.abuseStatus,
			trigger,
			isManualResumeRequired: settings?.isSendingResumeManual === true,
			isStillCritical: decision?.riskLevel === 'critical',
			condition,
		});
		if (isResuming && trigger && condition) {
			await ctx.runMutation(internal.workspaces.abuseStatus.transition, {
				input: {
					to: 'clean',
					at: now,
					reason: resumeReason(condition),
					changedBy: 'system',
					trigger,
				},
			});
		}
		// A suspension stays on its trigger until that one clears: handing it to
		// another metric first could lift it while the first is still over its
		// clear line.
		const keepsTrigger =
			settings?.abuseStatus === 'suspended' && condition !== null && !condition.isClear;
		if (decision) {
			await ctx.scheduler.runAfter(0, internal.analytics.sendingReputation.autoEnforceReputation, {
				...(keepsTrigger ? { riskLevel: decision.riskLevel, reason: decision.reason } : decision),
				decidedAt: now,
			});
		}
		return { riskLevel: org.riskLevel };
	},
});
