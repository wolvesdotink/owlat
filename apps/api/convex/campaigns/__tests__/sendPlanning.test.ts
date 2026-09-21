/**
 * THE CAMPAIGN SEND ORCHESTRATOR'S DECISIONS.
 *
 * `campaigns/send.ts` owns the I/O; every rule it applies between those calls
 * lives in `sendPlanning.ts`. Before the split each of these was only
 * reachable by driving a whole convex-test send, which is why the fire-time
 * guards and the A/B partition were pinned by one integration path each. This
 * suite pins them directly: what makes a hop a no-op, what a content verdict
 * does to the campaign, what a hop checkpoints, and how a page is split
 * between the two A/B phases.
 */

import { describe, expect, it } from 'vitest';
import type { ContentFlag } from '@owlat/email-scanner';
import {
	bucketPageRecipients,
	buildPlanCheckpoint,
	buildSendPlanState,
	classifyContentScan,
	classifyStartSendSkip,
	combineContentScan,
	isEmptyAudienceComplete,
	isPlannedTotalCounted,
	isTimezoneScheduled,
	makeVariantBucketer,
	pageSizeForSlice,
	resolveParkInstant,
	type SendPlanCapacity,
	type SendPlanJobRow,
} from '../sendPlanning';
import { planTodaysSlice, type SendPlanState } from '../multiDaySendPlan';
import { testFractionForSplit } from '../sendVariantSplit';
import { nextUtcDayStart, utcDayKey } from '../../lib/utcDay';

const NOW = 1_800_000_000_000;

describe('classifyStartSendSkip', () => {
	it('no-ops a hop whose campaign left the sendable states', () => {
		expect(classifyStartSendSkip({ status: 'cancelled' }, NOW)).toBe('Campaign was cancelled');
		expect(classifyStartSendSkip({ status: 'draft' }, NOW)).toBe('Campaign was unscheduled');
		expect(classifyStartSendSkip({ status: 'sent' }, NOW)).toBe('Campaign was already sent');
	});

	it('lets a `sending` campaign through — the lifecycle owns that race', () => {
		expect(classifyStartSendSkip({ status: 'sending' }, NOW)).toBeUndefined();
		// Even with a stale future scheduledAt still on the row: the lifecycle
		// already flipped the status, so this hop IS the send.
		expect(classifyStartSendSkip({ status: 'sending', scheduledAt: NOW + 60_000 }, NOW)).toBe(
			undefined
		);
	});

	it('skips the stale hop a reschedule left behind, and runs the due one', () => {
		expect(classifyStartSendSkip({ status: 'scheduled', scheduledAt: NOW + 1 }, NOW)).toBe(
			'Not yet due (rescheduled)'
		);
		expect(classifyStartSendSkip({ status: 'scheduled', scheduledAt: NOW }, NOW)).toBeUndefined();
		expect(classifyStartSendSkip({ status: 'scheduled' }, NOW)).toBeUndefined();
	});
});

describe('content scan verdict', () => {
	const flag = (severity: ContentFlag['severity'], description: string): ContentFlag => ({
		type: 'malicious_url',
		severity,
		description,
	});

	it('weighs URL findings by severity and caps the combined score at 100', () => {
		const verdict = combineContentScan({ flags: [flag('low', 'base')], score: 10 }, [
			flag('high', 'malware'),
			flag('medium', 'phish'),
			flag('low', 'shortener'),
		]);
		expect(verdict.score).toBe(10 + 20 + 10 + 3);
		expect(verdict.flags).toHaveLength(4);

		expect(combineContentScan({ flags: [], score: 95 }, [flag('high', 'malware')]).score).toBe(100);
	});

	it('blocks with every flag description in the reason, and holds a suspicious one', () => {
		const verdict = combineContentScan({ flags: [], score: 40 }, [
			flag('high', 'known malware host'),
			flag('medium', 'lookalike domain'),
		]);
		const blocked = classifyContentScan('blocked', verdict);
		expect(blocked.kind).toBe('blocked');
		if (blocked.kind !== 'blocked') throw new Error('unreachable');
		expect(blocked.contentBlockReason).toBe(
			'Content blocked: known malware host; lookalike domain'
		);
		expect(blocked.reason).toContain(`${verdict.score}/100`);

		expect(classifyContentScan('suspicious', verdict)).toEqual({
			kind: 'held',
			reason: `Content flagged for review (score: ${verdict.score}/100)`,
		});
		expect(classifyContentScan('clean', verdict)).toEqual({ kind: 'proceed' });
	});
});

describe('the multi-day plan checkpoint', () => {
	const JOB: SendPlanJobRow = {
		planDayKey: '2027-01-14',
		enqueuedToday: 120,
		planDayIndex: 1,
		planTotalDays: 4,
		isPlanTruncated: false,
		plannedTotal: 5_000,
		isPlannedTotalLowerBound: true,
	};

	it('keeps the row denominator on a hop that did not count', () => {
		const capacity: SendPlanCapacity = { plannedTotal: null, isPlannedTotalCounted: false };
		const state = buildSendPlanState(JOB, capacity);
		expect(state.plannedTotal).toBe(5_000);
		expect(state.isPlannedTotalLowerBound).toBe(true);
	});

	it('replaces it — flag and number together — on the hop that counted', () => {
		const capacity: SendPlanCapacity = {
			plannedTotal: 4_200,
			isPlannedTotalLowerBound: false,
			isPlannedTotalCounted: true,
		};
		const state = buildSendPlanState(JOB, capacity);
		expect(state.plannedTotal).toBe(4_200);
		expect(state.isPlannedTotalLowerBound).toBe(false);
	});

	it('remembers the count was attempted even when it produced no total', () => {
		// The verdict "counted, but the answer is unusable" writes no total by
		// design; without the sticky flag every later hop would pay for it again.
		expect(isPlannedTotalCounted(JOB, { plannedTotal: null, isPlannedTotalCounted: true })).toBe(
			true
		);
		expect(
			isPlannedTotalCounted(
				{ ...JOB, isPlannedTotalCountAttempted: true },
				{ plannedTotal: null, isPlannedTotalCounted: false }
			)
		).toBe(true);
		expect(isPlannedTotalCounted(JOB, { plannedTotal: null, isPlannedTotalCounted: false })).toBe(
			false
		);
	});

	it('omits the denominator from the checkpoint when the walk has none', () => {
		const noTotal: SendPlanState = {
			planDayKey: undefined,
			enqueuedToday: undefined,
			planDayIndex: undefined,
			planTotalDays: undefined,
			isPlanTruncated: undefined,
			plannedTotal: undefined,
			isPlannedTotalLowerBound: undefined,
		};
		const slice = planTodaysSlice({
			state: noTotal,
			remaining: { kind: 'unknown' },
			capacityByDay: [],
			now: NOW,
		});
		const checkpoint = buildPlanCheckpoint(noTotal, slice, false);
		expect(checkpoint).not.toHaveProperty('plannedTotal');
		expect(checkpoint).not.toHaveProperty('isPlannedTotalLowerBound');
		expect(checkpoint).not.toHaveProperty('isPlannedTotalCountAttempted');
		expect(checkpoint.planDayKey).toBe(slice.dayKey);
	});
});

describe('the day budget', () => {
	const sliceFor = (capacityByDay: number[], enqueuedToday: number, plannedTotal: number) =>
		planTodaysSlice({
			state: {
				planDayKey: utcDayKey(NOW),
				enqueuedToday,
				planDayIndex: undefined,
				planTotalDays: undefined,
				isPlanTruncated: undefined,
				plannedTotal,
				isPlannedTotalLowerBound: false,
			},
			remaining: { kind: 'exact', count: plannedTotal },
			capacityByDay,
			now: NOW,
		});

	it('imposes no budget without a projection, so the read is a full page', () => {
		const slice = sliceFor([], 0, 1_000);
		expect(resolveParkInstant(slice, NOW)).toBeUndefined();
		expect(pageSizeForSlice(slice, 200)).toBeUndefined();
	});

	it('narrows the read to what is left of today, never past the page size', () => {
		expect(pageSizeForSlice(sliceFor([50], 0, 1_000), 200)).toBe(50);
		expect(pageSizeForSlice(sliceFor([5_000], 0, 1_000), 200)).toBe(200);
	});

	it('parks a spent day at the planner instant, falling back to the next UTC day', () => {
		const spent = sliceFor([50], 50, 1_000);
		expect(spent.isDayExhausted).toBe(true);
		expect(spent.resumeAt).toBeDefined();
		expect(resolveParkInstant(spent, NOW)).toBe(spent.resumeAt);
		// A planner instant that is NOT the next UTC day start proves it wins over the fallback.
		const plannerInstant = NOW + 3_600_000;
		expect(resolveParkInstant({ ...spent, resumeAt: plannerInstant }, NOW)).toBe(plannerInstant);
		expect(resolveParkInstant({ ...spent, resumeAt: undefined }, NOW)).toBe(nextUtcDayStart(NOW));
	});
});

describe('the A/B partition', () => {
	const CAMPAIGN_ID = 'campaign_ab_partition';
	const CONTACTS = Array.from({ length: 400 }, (_, i) => `contact_${i}`);
	const testFraction = testFractionForSplit(20); // 20% per arm ⇒ 40% cohort

	it('never tags a plain send', () => {
		const bucketFor = makeVariantBucketer({
			variantMode: 'plain',
			campaignId: CAMPAIGN_ID,
			testFraction: 0,
		});
		expect(CONTACTS.every((id) => bucketFor(id) === undefined)).toBe(true);
	});

	it('partitions the audience disjointly between the test and winner phases', () => {
		const test = makeVariantBucketer({
			variantMode: 'ab_test',
			campaignId: CAMPAIGN_ID,
			testFraction,
		});
		const winner = makeVariantBucketer({
			variantMode: 'ab_winner',
			campaignId: CAMPAIGN_ID,
			testFraction,
			winningVariant: 'B',
		});
		let cohort = 0;
		let remainder = 0;
		for (const id of CONTACTS) {
			const inTest = test(id) !== null;
			const inWinner = winner(id) !== null;
			// Exactly one phase sends to each contact — no gap, no double send.
			expect(inTest).toBe(!inWinner);
			if (inTest) cohort++;
			else {
				remainder++;
				expect(winner(id)).toBe('B');
			}
		}
		expect(cohort + remainder).toBe(CONTACTS.length);
		// 40% of the audience, within sampling noise of the hash.
		expect(cohort / CONTACTS.length).toBeGreaterThan(0.3);
		expect(cohort / CONTACTS.length).toBeLessThan(0.5);
	});

	it('falls back to variant A when the winner was not recorded', () => {
		const winner = makeVariantBucketer({
			variantMode: 'ab_winner',
			campaignId: CAMPAIGN_ID,
			testFraction: 0,
		});
		expect(CONTACTS.every((id) => winner(id) === 'A')).toBe(true);
	});
});

describe('bucketPageRecipients', () => {
	it('groups by language and variant, skipping the other phase', () => {
		const page = [
			{ _id: 'a', language: 'de', engagementScore: 10 },
			{ _id: 'b', engagementScore: 90 },
			{ _id: 'c', language: 'de', engagementScore: 50 },
			{ _id: 'd', language: 'fr', engagementScore: 1 },
		];
		const buckets = bucketPageRecipients(
			page,
			(id) => (id === 'd' ? null : id === 'b' ? 'B' : undefined),
			'en'
		);
		expect(buckets.map((b) => [b.language, b.variant, b.recipients.map((r) => r._id)])).toEqual([
			['en', 'B', ['b']],
			['de', undefined, ['c', 'a']],
		]);
	});

	it('orders each bucket by engagement, best first', () => {
		const page = [
			{ _id: 'low', engagementScore: 1 },
			{ _id: 'none' },
			{ _id: 'high', engagementScore: 99 },
		];
		const [bucket] = bucketPageRecipients(page, () => undefined, 'en');
		expect(bucket?.recipients.map((r) => r._id)).toEqual(['high', 'low', 'none']);
	});
});

describe('completion and scheduling rules', () => {
	it('honours the send hour for plain and test sends but not the winner send', () => {
		const scheduled = { useRecipientTimezone: true, scheduledHour: 9, scheduledMinute: 30 };
		expect(isTimezoneScheduled(scheduled, 'plain')).toBe(true);
		expect(isTimezoneScheduled(scheduled, 'ab_test')).toBe(true);
		expect(isTimezoneScheduled(scheduled, 'ab_winner')).toBe(false);
		expect(isTimezoneScheduled({ useRecipientTimezone: true }, 'plain')).toBe(false);
	});

	it('completes an empty audience, but not an A/B walk that only missed the cohort', () => {
		expect(isEmptyAudienceComplete('plain', { totalCandidates: 0, enqueuedCount: 0 })).toBe(true);
		expect(isEmptyAudienceComplete('plain', { totalCandidates: 9, enqueuedCount: 3 })).toBe(false);
		// Non-empty audience, nobody in the test cohort: the winner phase still
		// has a remainder to send, so the campaign stays in flight.
		expect(isEmptyAudienceComplete('ab_test', { totalCandidates: 9, enqueuedCount: 0 })).toBe(
			false
		);
		expect(isEmptyAudienceComplete('ab_test', { totalCandidates: 0, enqueuedCount: 0 })).toBe(true);
		expect(isEmptyAudienceComplete('ab_winner', { totalCandidates: 9, enqueuedCount: 0 })).toBe(
			true
		);
		expect(isEmptyAudienceComplete('plain', null)).toBe(false);
	});
});
