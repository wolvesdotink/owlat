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
 * internal window first, then the worst Gmail reading.
 *
 * PURE: `now` and every reading are parameters (scripts/purity-roots.txt).
 */

import { PROVIDER_SPAM_RATE_POLICY } from '@owlat/shared/reputation';
import { utcDayKey } from '../lib/clock';
import { isPostmasterReadingFresh } from '../delivery/signals/postmaster';
import type { RiskLevel } from './sendingReputation';

/** One domain's latest Postmaster spam-rate reading. */
export interface GmailSpamReading {
	readonly domain: string;
	readonly userReportedSpamRatio: number;
	readonly periodStart: number;
	readonly fetchedAt: number;
}

export interface EnforcementDecision {
	readonly riskLevel: 'high' | 'critical';
	readonly reason: string;
}

/** Shipped copy for the internal window; the audit trail already carries it. */
const INTERNAL_REASON = {
	critical: 'Auto-suspended: complaint rate or bounce rate exceeded critical thresholds',
	high: 'Auto-warned: complaint rate or bounce rate exceeding safe thresholds',
} as const;

function percent(ratio: number): string {
	return `${(ratio * 100).toFixed(2)}%`;
}

function gmailDecision(reading: GmailSpamReading): EnforcementDecision | null {
	const ratio = reading.userReportedSpamRatio;
	const where = `for ${reading.domain} on ${utcDayKey(reading.periodStart)}`;
	if (ratio >= PROVIDER_SPAM_RATE_POLICY.hardThreshold) {
		return {
			riskLevel: 'critical',
			reason: `Auto-suspended: Gmail reports a spam rate of ${percent(ratio)} ${where}, at or above Google's ${percent(PROVIDER_SPAM_RATE_POLICY.hardThreshold)} limit`,
		};
	}
	if (ratio >= PROVIDER_SPAM_RATE_POLICY.target) {
		return {
			riskLevel: 'high',
			reason: `Auto-warned: Gmail reports a spam rate of ${percent(ratio)} ${where}, above Google's ${percent(PROVIDER_SPAM_RATE_POLICY.target)} guidance`,
		};
	}
	return null;
}

export function decideReputationEnforcement(input: {
	readonly orgRiskLevel: RiskLevel;
	readonly gmail: readonly GmailSpamReading[];
	readonly now: number;
}): EnforcementDecision | null {
	const candidates: EnforcementDecision[] = [];
	if (input.orgRiskLevel === 'critical' || input.orgRiskLevel === 'high') {
		candidates.push({
			riskLevel: input.orgRiskLevel,
			reason: INTERNAL_REASON[input.orgRiskLevel],
		});
	}
	const fresh = input.gmail
		.filter((reading) => isPostmasterReadingFresh(reading, input.now))
		.sort((a, b) => b.userReportedSpamRatio - a.userReportedSpamRatio);
	for (const reading of fresh) {
		const decision = gmailDecision(reading);
		if (decision) candidates.push(decision);
	}
	return (
		candidates.find((candidate) => candidate.riskLevel === 'critical') ??
		candidates.find((candidate) => candidate.riskLevel === 'high') ??
		null
	);
}
