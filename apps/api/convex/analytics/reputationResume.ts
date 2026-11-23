/**
 * When a suspension the reputation check imposed lifts by itself, and what the
 * operator is told about it.
 *
 * The rule, with hysteresis so a status does not flap: a suspension lifts once
 * the metric that triggered it is back under the WARNING line, not merely under
 * the line that suspends. Both lines come from `@owlat/shared/reputation`:
 *   - bounce rate: suspends at 10%, lifts under 5%;
 *   - complaint rate: suspends at 0.3%, lifts under 0.2%;
 *   - Gmail spam rate (per domain): suspends at Google's 0.3% limit, lifts once
 *     no reading for that domain inside the 30-day window is at or above
 *     Google's 0.1% guidance. Gmail reports a day only when enough mail was
 *     sent, so a suspended domain gets no new readings; the old bad day leaving
 *     the window is what clears it.
 * The internal rates are judged on whatever sends are left in the window, even
 * fewer than the minimum sample enforcement needs: a suspended instance sends
 * nothing new, so the window only shrinks. An empty window counts as clear,
 * because the evidence has aged out of it.
 *
 * Only a suspension that records its trigger lifts, so one a platform admin
 * imposed, a legacy row written before triggers were stored, and a ban never
 * do. An instance can require a platform admin to lift every suspension.
 *
 * PURE: every reading and `now` are parameters (scripts/purity-roots.txt).
 */

import { PROVIDER_SPAM_RATE_POLICY, REPUTATION_THRESHOLDS } from '@owlat/shared/reputation';
import { DAY_MS } from '../lib/constants';
import type { OrgRates, ReputationTrigger, ReputationTriggerCode } from './reputationEnforcement';

/** The rolling window the internal rates are summed over. */
export const REPUTATION_WINDOW_MS = 30 * DAY_MS;

/**
 * How long a platform admin's lift keeps the check from suspending again on
 * the triggers that were over the line at the lift. Short on purpose: if the
 * 30-day evidence is still over the line when it ends, sending is suspended
 * again (and then lifts by itself once the evidence clears).
 */
export const MANUAL_LIFT_HOLD_MS = 7 * DAY_MS;

/** One Gmail reading inside the window, for the resume rule. */
export interface GmailWindowReading {
	readonly domain: string;
	readonly userReportedSpamRatio: number;
	readonly periodStart: number;
}

export interface ResumeEvidence {
	readonly org: OrgRates;
	/** The trigger domain's readings inside the window (others are ignored). */
	readonly gmail: readonly GmailWindowReading[];
}

/** What has to be true for the suspension to lift, and where it stands. */
export interface ResumeCondition {
	readonly code: ReputationTriggerCode;
	readonly domain?: string;
	/** The metric lifts the suspension once it is under this. */
	readonly limit: number;
	/** The metric now; `null` when no evidence is left in the window. */
	readonly current: number | null;
	readonly isClear: boolean;
	/** When the evidence leaves the window by the clock alone, if known. */
	readonly clearsAt: number | null;
}

export function resumeCondition(
	trigger: ReputationTrigger,
	evidence: ResumeEvidence
): ResumeCondition {
	if (trigger.code === 'gmail_spam_rate') {
		const limit = PROVIDER_SPAM_RATE_POLICY.target;
		const over = evidence.gmail.filter(
			(reading) => reading.domain === trigger.domain && reading.userReportedSpamRatio >= limit
		);
		const worst = Math.max(0, ...over.map((reading) => reading.userReportedSpamRatio));
		const lastBad = Math.max(0, ...over.map((reading) => reading.periodStart));
		return {
			code: trigger.code,
			...(trigger.domain !== undefined ? { domain: trigger.domain } : {}),
			limit,
			current: over.length > 0 ? worst : null,
			isClear: over.length === 0,
			clearsAt: over.length > 0 ? lastBad + REPUTATION_WINDOW_MS : null,
		};
	}
	const limit =
		trigger.code === 'bounce_rate'
			? REPUTATION_THRESHOLDS.bounce.high
			: REPUTATION_THRESHOLDS.complaint.high;
	const rate =
		trigger.code === 'bounce_rate' ? evidence.org.bounceRate : evidence.org.complaintRate;
	const current = evidence.org.totalSent > 0 ? rate : null;
	return {
		code: trigger.code,
		limit,
		current,
		isClear: current === null || current < limit,
		clearsAt: null,
	};
}

/**
 * Whether the hourly check lifts the suspension now. `isStillCritical` is the
 * enforcement call on the current evidence: another trigger over the line
 * keeps sending suspended even when the stored one has cleared.
 */
export function decideAutoResume(input: {
	readonly status: string | undefined;
	readonly trigger: ReputationTrigger | undefined;
	readonly isManualResumeRequired: boolean;
	readonly isStillCritical: boolean;
	readonly condition: ResumeCondition | null;
}): boolean {
	return (
		input.status === 'suspended' &&
		input.trigger !== undefined &&
		!input.isManualResumeRequired &&
		!input.isStillCritical &&
		input.condition?.isClear === true
	);
}

function percent(ratio: number): string {
	return `${(ratio * 100).toFixed(2)}%`;
}

/** The English sentence stored with an automatic resume (the audit trail quotes it). */
export function resumeReason(condition: ResumeCondition): string {
	const limit = percent(condition.limit);
	switch (condition.code) {
		case 'bounce_rate':
			return `Resumed automatically: the bounce rate is back under ${limit}`;
		case 'complaint_rate':
			return `Resumed automatically: the complaint rate is back under ${limit}`;
		case 'gmail_spam_rate':
			return `Resumed automatically: Gmail reported no spam rate at or above ${limit} for ${condition.domain ?? 'the domain'} in the last 30 days`;
	}
}

/** How a blocked instance gets sending back, for the banner and the operator console. */
export type SuspensionLift =
	| ({ readonly mode: 'automatic' } & ResumeCondition)
	| { readonly mode: 'manual_setting' }
	| { readonly mode: 'admin' };

export function describeSuspensionLift(input: {
	readonly status: string | undefined;
	readonly trigger: ReputationTrigger | undefined;
	readonly isManualResumeRequired: boolean;
	readonly condition: ResumeCondition | null;
}): SuspensionLift | null {
	if (input.status !== 'suspended' && input.status !== 'banned') return null;
	if (input.status === 'banned' || input.trigger === undefined || input.condition === null) {
		return { mode: 'admin' };
	}
	if (input.isManualResumeRequired) return { mode: 'manual_setting' };
	return { mode: 'automatic', ...input.condition };
}
