/** Provider-facing FBL spam-rate derivation (complaints / delivered volume). */

import { PROVIDER_SPAM_RATE_POLICY } from '@owlat/shared/reputation';
import type { Doc } from '../_generated/dataModel';
import type { DatabaseReader } from '../_generated/server';
import {
	startOfDayUtc,
	type DomainReputationBucketGroups,
	type ReputationScope,
} from './sendingReputation';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 30 * DAY_MS;

export const SPAM_RATE_TARGET = PROVIDER_SPAM_RATE_POLICY.target;
export const SPAM_RATE_HARD_THRESHOLD = PROVIDER_SPAM_RATE_POLICY.hardThreshold;
export const SPAM_RATE_RECOVERY_DAYS = PROVIDER_SPAM_RATE_POLICY.recoveryDays;

export interface SpamRateSummary {
	spamRate: number | null;
	totalDelivered: number;
	totalComplaints: number;
	status: 'no_data' | 'on_target' | 'elevated' | 'hard_limit';
	cleanDaysBelowHardThreshold: number;
	recoveryEligible: boolean;
}

type ReputationBucket = Doc<'sendingReputation'>;

/**
 * This view deliberately does not change the sent-denominator breaker. The
 * breaker remains a conservative Owlat stop; this is the provider-facing rate.
 */
export function deriveSpamRateSummary(
	buckets: readonly ReputationBucket[],
	now: number
): SpamRateSummary {
	const cutoff = now - WINDOW_MS;
	let totalDelivered = 0;
	let totalComplaints = 0;
	const daily = new Map<number, { delivered: number; complaints: number }>();
	for (const bucket of buckets) {
		if (bucket.periodStart < cutoff) continue;
		totalDelivered += bucket.totalDelivered;
		totalComplaints += bucket.totalComplaints;
		const value = daily.get(bucket.periodStart) ?? { delivered: 0, complaints: 0 };
		value.delivered += bucket.totalDelivered;
		value.complaints += bucket.totalComplaints;
		daily.set(bucket.periodStart, value);
	}

	const spamRate = totalDelivered > 0 ? totalComplaints / totalDelivered : null;
	const status =
		spamRate === null
			? 'no_data'
			: spamRate >= SPAM_RATE_HARD_THRESHOLD
				? 'hard_limit'
				: spamRate >= SPAM_RATE_TARGET
					? 'elevated'
					: 'on_target';

	let cleanDaysBelowHardThreshold = 0;
	const today = startOfDayUtc(now);
	for (let daysAgo = 1; daysAgo <= SPAM_RATE_RECOVERY_DAYS; daysAgo++) {
		const day = daily.get(today - daysAgo * DAY_MS);
		if (!day || day.delivered === 0) break;
		if (day.complaints / day.delivered >= SPAM_RATE_HARD_THRESHOLD) break;
		cleanDaysBelowHardThreshold++;
	}

	return {
		spamRate,
		totalDelivered,
		totalComplaints,
		status,
		cleanDaysBelowHardThreshold,
		recoveryEligible: cleanDaysBelowHardThreshold >= SPAM_RATE_RECOVERY_DAYS,
	};
}

function scopedBuckets(db: DatabaseReader, scope: ReputationScope) {
	return db
		.query('sendingReputation')
		.withIndex('by_scope_domain_period_shard', (q) =>
			scope.kind === 'org'
				? q.eq('scope', 'org')
				: q.eq('scope', 'domain').eq('domain', scope.domain)
		);
}

export async function summarizeSpamRate(
	db: DatabaseReader,
	scope: ReputationScope,
	now = Date.now()
): Promise<SpamRateSummary> {
	const buckets = await scopedBuckets(db, scope).collect(); // bounded: one scope's ≤60-day × shard buckets (cron-pruned)
	return deriveSpamRateSummary(buckets, now);
}

export function summarizeDomainSpamRateGroups(
	groups: DomainReputationBucketGroups,
	now = Date.now()
): Array<SpamRateSummary & { domain: string }> {
	return [...groups.entries()].map(([domain, buckets]) => ({
		domain,
		...deriveSpamRateSummary(buckets, now),
	}));
}
