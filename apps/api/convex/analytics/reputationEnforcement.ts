/**
 * The reputation enforcement DECISION: which abuse status the deployment's
 * sending evidence calls for, and the reason the operator reads.
 *
 * Two kinds of evidence feed it, and nothing else decides:
 *   - the internal rolling window (`sendingReputation.ts`): bounces and the ARF
 *     complaints mailbox providers send back;
 *   - Gmail's user-reported spam rate from Google Postmaster Tools. Gmail sends
 *     no ARF reports, so without this a Gmail breach never shows in the window.
 *     Only a fresh reading counts (`isPostmasterReadingFresh`), and Google
 *     reports the rate only for a domain with enough daily volume, so a missing
 *     or old reading never enforces anything.
 *
 * The strongest call wins: a suspension over a warning; among equals the
 * internal window first (bounces, then complaints), then the worst Gmail
 * reading. Each call names its trigger, the metric that crossed the line, so a
 * suspension can later lift when that metric clears (`reputationResume.ts`).
 *
 * PURE: `now` and every reading are parameters (scripts/purity-roots.txt).
 */

import {
	PROVIDER_SPAM_RATE_POLICY,
	REPUTATION_MIN_SAMPLE_SIZE,
	REPUTATION_THRESHOLDS,
} from '@owlat/shared/reputation';
import { utcDayKey } from '../lib/clock';
import { isPostmasterReadingFresh } from '../delivery/signals/postmaster';

/** One domain's latest Postmaster spam-rate reading. */
export interface GmailSpamReading {
	readonly domain: string;
	readonly userReportedSpamRatio: number;
	readonly periodStart: number;
	readonly fetchedAt: number;
}

export type ReputationTriggerCode = 'bounce_rate' | 'complaint_rate' | 'gmail_spam_rate';

/**
 * The metric a call was made on. Gmail readings are judged per domain, so a
 * `gmail_spam_rate` trigger carries the domain; the internal rates carry none.
 */
export interface ReputationTrigger {
	readonly code: ReputationTriggerCode;
	readonly domain?: string;
}

/** The internal window's rates, as `summarize` derives them. */
export interface OrgRates {
	readonly totalSent: number;
	readonly bounceRate: number;
	readonly complaintRate: number;
}

/**
 * What a platform admin's lift put on hold: the triggers over the suspension
 * line at the lift, which do not suspend again before `until`.
 */
export interface ReputationCheckHold {
	readonly until: number;
	readonly triggers: readonly ReputationTrigger[];
}

export interface EnforcementDecision {
	readonly riskLevel: 'high' | 'critical';
	readonly reason: string;
	readonly trigger: ReputationTrigger;
}

export function isSameTrigger(a: ReputationTrigger, b: ReputationTrigger): boolean {
	return a.code === b.code && a.domain === b.domain;
}

/** Shipped copy for the internal window; the audit trail already carries it. */
const INTERNAL_REASON = {
	critical: 'Auto-suspended: complaint rate or bounce rate exceeded critical thresholds',
	high: 'Auto-warned: complaint rate or bounce rate exceeding safe thresholds',
} as const;

function percent(ratio: number): string {
	return `${(ratio * 100).toFixed(2)}%`;
}

/** One internal rate's call. Below the sample size nothing is judged. */
function internalDecision(
	code: 'bounce_rate' | 'complaint_rate',
	org: OrgRates
): EnforcementDecision | null {
	if (org.totalSent < REPUTATION_MIN_SAMPLE_SIZE) return null;
	const rate = code === 'bounce_rate' ? org.bounceRate : org.complaintRate;
	const limits =
		code === 'bounce_rate' ? REPUTATION_THRESHOLDS.bounce : REPUTATION_THRESHOLDS.complaint;
	const riskLevel = rate >= limits.critical ? 'critical' : rate >= limits.high ? 'high' : null;
	return riskLevel ? { riskLevel, reason: INTERNAL_REASON[riskLevel], trigger: { code } } : null;
}

function gmailDecision(reading: GmailSpamReading): EnforcementDecision | null {
	const ratio = reading.userReportedSpamRatio;
	const where = `for ${reading.domain} on ${utcDayKey(reading.periodStart)}`;
	const trigger = { code: 'gmail_spam_rate', domain: reading.domain } as const;
	if (ratio >= PROVIDER_SPAM_RATE_POLICY.hardThreshold) {
		return {
			riskLevel: 'critical',
			reason: `Auto-suspended: Gmail reports a spam rate of ${percent(ratio)} ${where}, at or above Google's ${percent(PROVIDER_SPAM_RATE_POLICY.hardThreshold)} limit`,
			trigger,
		};
	}
	if (ratio >= PROVIDER_SPAM_RATE_POLICY.target) {
		return {
			riskLevel: 'high',
			reason: `Auto-warned: Gmail reports a spam rate of ${percent(ratio)} ${where}, above Google's ${percent(PROVIDER_SPAM_RATE_POLICY.target)} guidance`,
			trigger,
		};
	}
	return null;
}

/** Every call the evidence supports, strongest first by the order above. */
function enforcementCandidates(input: {
	readonly org: OrgRates;
	readonly gmail: readonly GmailSpamReading[];
	readonly now: number;
}): EnforcementDecision[] {
	const fresh = input.gmail
		.filter((reading) => isPostmasterReadingFresh(reading, input.now))
		.sort((a, b) => b.userReportedSpamRatio - a.userReportedSpamRatio);
	return [
		internalDecision('bounce_rate', input.org),
		internalDecision('complaint_rate', input.org),
		...fresh.map(gmailDecision),
	].filter((candidate): candidate is EnforcementDecision => candidate !== null);
}

/** The triggers over the suspension line right now: what a manual lift holds. */
export function suspendingTriggers(input: {
	readonly org: OrgRates;
	readonly gmail: readonly GmailSpamReading[];
	readonly now: number;
}): ReputationTrigger[] {
	return enforcementCandidates(input)
		.filter((candidate) => candidate.riskLevel === 'critical')
		.map((candidate) => candidate.trigger);
}

/**
 * The call the evidence makes. A trigger a platform admin's lift put on hold
 * makes no call (neither a warning nor a suspension) until the hold ends; any
 * other trigger still does.
 */
export function decideReputationEnforcement(input: {
	readonly org: OrgRates;
	readonly gmail: readonly GmailSpamReading[];
	readonly now: number;
	readonly hold?: ReputationCheckHold | null;
}): EnforcementDecision | null {
	const hold = input.hold && input.now < input.hold.until ? input.hold.triggers : [];
	const candidates = enforcementCandidates(input).filter(
		(candidate) => !hold.some((held) => isSameTrigger(held, candidate.trigger))
	);
	return (
		candidates.find((candidate) => candidate.riskLevel === 'critical') ??
		candidates.find((candidate) => candidate.riskLevel === 'high') ??
		null
	);
}
