import { describe, it, expect } from 'vitest';
import { ENGAGEMENT_BAND_CUTS } from '@owlat/shared/engagementBands';
import type { ContactActivityType } from '../../contactActivities/catalog';
import { toEngagementActivity } from '../engagementActivity';
import {
	ENGAGEMENT_WEIGHTS,
	computeEngagementScore,
	engagementBand,
	engagementPercentile,
	type EngagementActivity,
	type EngagementActivityKind,
	type EngagementBand,
	type EngagementScoreInputs,
	type EngagementScoreResult,
} from '../engagementScore';

/**
 * The band-distribution fixture matrix for the contact engagement score
 * (deliverability plan P0-2).
 *
 * The point of this file is NOT that the arithmetic runs — it is that eight
 * REALISTIC contact timelines land in FOUR DIFFERENT bands. A scoring function
 * that maps every real contact into one band passes every "score is a number"
 * unit test and still makes the MTA's 80/50/20 priority bands useless, so each
 * row asserts its band AND the matrix as a whole asserts that all four bands are
 * occupied.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 27, 12, 0, 0);

/** `n` activities of one kind, at the given ages in days. */
function at(kind: EngagementActivityKind, ...agesInDays: number[]): EngagementActivity[] {
	return agesInDays.map((days) => ({ kind, occurredAt: NOW - days * DAY }));
}

/** Monthly activity for `count` months, the most recent `firstAgeDays` ago. */
function monthly(
	kind: EngagementActivityKind,
	count: number,
	firstAgeDays: number
): EngagementActivity[] {
	return at(kind, ...Array.from({ length: count }, (_, i) => firstAgeDays + i * 30));
}

type Fixture = {
	name: string;
	activities: EngagementActivity[];
	tenureDays: number;
	band: EngagementBand;
};

const FIXTURES: Fixture[] = [
	{
		// Clicked three times and opened five times in the last three weeks.
		name: 'recent-clicker',
		activities: [...at('click', 2, 6, 11), ...at('open', 1, 3, 9, 12, 20)],
		tenureDays: 400,
		band: 'high',
	},
	{
		// Opens, never clicks. The bread-and-butter engaged reader.
		name: 'recent-opener',
		activities: at('open', 5, 9),
		tenureDays: 400,
		band: 'medium',
	},
	{
		// Twenty opens — but the newest is five months old. Frequency without
		// recency must not buy the top band.
		name: 'frequent-but-old',
		activities: at('open', ...Array.from({ length: 20 }, (_, i) => 150 + i * 3)),
		tenureDays: 500,
		band: 'low',
	},
	{
		// A single open, over six months ago. This is the "200-day-silent contact
		// scores COLD" acceptance criterion.
		name: 'one-off-old',
		activities: at('open', 200),
		tenureDays: 400,
		band: 'cold',
	},
	{
		// Signed up two days ago, nothing sent to them yet. UNMEASURED, not cold —
		// new subscribers are the best-performing cohort, and dumping them in the
		// bottom band would deprioritize their welcome mail.
		name: 'brand-new-no-activity',
		activities: [],
		tenureDays: 2,
		band: 'low',
	},
	{
		// Opens roughly monthly for a year, most recently five days ago.
		name: 'long-tenured-steady',
		activities: monthly('open', 12, 5),
		tenureDays: 400,
		band: 'medium',
	},
	{
		// One soft bounce (full mailbox) three months ago, engaged since. The
		// penalty decays — a transient failure must not permanently demote.
		name: 'bounced-then-recovered',
		activities: [...at('soft_bounce', 90), ...at('click', 10), ...at('open', 8, 20, 30)],
		tenureDays: 300,
		band: 'high',
	},
	{
		// Hard bounce after a healthy history. Terminal: the address is gone.
		name: 'hard-bounced',
		activities: [...at('open', 5, 12), ...at('click', 3), ...at('hard_bounce', 2)],
		tenureDays: 200,
		band: 'cold',
	},
];

function scoreOf(fixture: Fixture): EngagementScoreResult {
	return computeEngagementScore({
		activities: fixture.activities,
		tenureStartedAt: NOW - fixture.tenureDays * DAY,
		now: NOW,
	});
}

describe('computeEngagementScore — band fixture matrix', () => {
	it.each(FIXTURES.map((f): [string, Fixture] => [f.name, f]))(
		'%s lands in its band',
		(_name, fixture) => {
			const { score } = scoreOf(fixture);
			expect(score).toBeGreaterThanOrEqual(0);
			expect(score).toBeLessThanOrEqual(100);
			expect(engagementBand(score)).toBe(fixture.band);
		}
	);

	it('populates ALL FOUR bands (the distribution, not just the arithmetic)', () => {
		const bands = new Set(FIXTURES.map((f) => engagementBand(scoreOf(f).score)));
		expect([...bands].sort()).toEqual(['cold', 'high', 'low', 'medium']);
	});

	it('orders the fixtures the way an operator would rank them', () => {
		const by = Object.fromEntries(FIXTURES.map((f) => [f.name, scoreOf(f).score]));
		const clicker = by['recent-clicker'] ?? -1;
		const opener = by['recent-opener'] ?? -1;
		const old = by['frequent-but-old'] ?? -1;
		const oneOff = by['one-off-old'] ?? -1;
		expect(clicker).toBeGreaterThan(opener);
		expect(opener).toBeGreaterThan(old);
		expect(old).toBeGreaterThan(oneOff);
	});

	it('scores a hard bounce and a complaint at exactly 0', () => {
		for (const kind of ['hard_bounce', 'complaint'] as const) {
			const { score, state } = computeEngagementScore({
				activities: [...at('click', 1, 2, 3), ...at(kind, 1)],
				tenureStartedAt: NOW - 30 * DAY,
				now: NOW,
			});
			expect(score).toBe(0);
			expect(state.isSuppressed).toBe(true);
		}
	});
});

describe('computeEngagementScore — weighting', () => {
	it('weighs a click above an open and a reply above a click', () => {
		expect(ENGAGEMENT_WEIGHTS.click).toBeGreaterThan(ENGAGEMENT_WEIGHTS.open);
		expect(ENGAGEMENT_WEIGHTS.reply).toBeGreaterThan(ENGAGEMENT_WEIGHTS.click);

		const score = (kind: EngagementActivityKind) =>
			computeEngagementScore({
				activities: at(kind, 3),
				tenureStartedAt: NOW - 400 * DAY,
				now: NOW,
			}).score;

		expect(score('click')).toBeGreaterThan(score('open'));
		expect(score('reply')).toBeGreaterThan(score('click'));
	});

	it('weighs a recent activity above the identical older one', () => {
		const recent = computeEngagementScore({
			activities: at('open', 3),
			tenureStartedAt: NOW - 400 * DAY,
			now: NOW,
		});
		const old = computeEngagementScore({
			activities: at('open', 120),
			tenureStartedAt: NOW - 400 * DAY,
			now: NOW,
		});
		expect(recent.score).toBeGreaterThan(old.score);
	});

	it('depresses the score for a bounce history relative to the same engagement', () => {
		const clean = computeEngagementScore({
			activities: at('open', 5, 15, 25),
			tenureStartedAt: NOW - 300 * DAY,
			now: NOW,
		});
		const bounced = computeEngagementScore({
			activities: [...at('open', 5, 15, 25), ...at('soft_bounce', 4, 10)],
			tenureStartedAt: NOW - 300 * DAY,
			now: NOW,
		});
		expect(bounced.score).toBeLessThan(clean.score);
		expect(bounced.inputs.penalty).toBeLessThan(1);
	});

	it('reports the gate inputs it scored on', () => {
		const { inputs } = scoreOf(FIXTURES[0] as Fixture);
		const expected: Array<keyof EngagementScoreInputs> = [
			'openCount',
			'clickCount',
			'replyCount',
			'softBounceCount',
			'hardBounceCount',
			'complaintCount',
			'discardedCount',
			'tenureDays',
			'decayedEngagement',
			'decayedSoftBounce',
			'tenurePrior',
			'penalty',
			'raw',
		];
		for (const key of expected) expect(inputs[key]).toBeTypeOf('number');
		expect(inputs.isSuppressed).toBeTypeOf('boolean');
		expect(inputs.clickCount).toBe(3);
		expect(inputs.openCount).toBe(5);
	});

	it('reports the real penalty for a suppressed contact, not a zero', () => {
		// A hard-bounced contact and a maximally soft-bounced one both score 0; the
		// inputs blob an operator reads has to tell them apart.
		const suppressed = computeEngagementScore({
			activities: [...at('open', 5), ...at('soft_bounce', 6, 7), ...at('hard_bounce', 2)],
			tenureStartedAt: NOW - 300 * DAY,
			now: NOW,
		});
		expect(suppressed.score).toBe(0);
		expect(suppressed.inputs.isSuppressed).toBe(true);
		expect(suppressed.inputs.penalty).toBeLessThan(1);
		expect(suppressed.inputs.penalty).toBeGreaterThan(0);
		expect(suppressed.inputs.raw).toBeGreaterThan(0);

		const notSuppressed = computeEngagementScore({
			activities: at('open', 5),
			tenureStartedAt: NOW - 300 * DAY,
			now: NOW,
		});
		expect(notSuppressed.inputs.isSuppressed).toBe(false);
	});
});

describe('engagementBand', () => {
	it('cuts exactly where the MTA priority bands cut', () => {
		// The ONE definition, imported by the MTA's `mapToPriority` too — not a
		// hand-copied literal that lets the two sides drift apart.
		expect(ENGAGEMENT_BAND_CUTS).toEqual({ high: 80, medium: 50, low: 20 });
		expect(engagementBand(100)).toBe('high');
		expect(engagementBand(80)).toBe('high');
		expect(engagementBand(79)).toBe('medium');
		expect(engagementBand(50)).toBe('medium');
		expect(engagementBand(49)).toBe('low');
		expect(engagementBand(20)).toBe('low');
		expect(engagementBand(19)).toBe('cold');
		expect(engagementBand(0)).toBe('cold');
	});
});

describe('engagementPercentile (the P2-5 stratification seam)', () => {
	const cohort = [0, 5, 12, 40, 55, 70, 88, 95];

	it('returns the fraction of the cohort at or below the score', () => {
		expect(engagementPercentile(cohort, 95)).toBe(1);
		expect(engagementPercentile(cohort, 0)).toBe(1 / 8);
		expect(engagementPercentile(cohort, 55)).toBe(5 / 8);
		expect(engagementPercentile(cohort, -1)).toBe(0);
	});

	it('interpolates a score not present in the cohort', () => {
		expect(engagementPercentile(cohort, 41)).toBe(4 / 8);
	});

	it('returns a neutral 0.5 for an empty cohort rather than an extreme', () => {
		expect(engagementPercentile([], 42)).toBe(0.5);
	});

	it('handles duplicate cohort values', () => {
		expect(engagementPercentile([10, 10, 10, 10], 10)).toBe(1);
		expect(engagementPercentile([10, 10, 10, 10], 9)).toBe(0);
	});
});

describe('toEngagementActivity', () => {
	it('maps the activity types the score reacts to', () => {
		expect(toEngagementActivity({ activityType: 'email_opened', occurredAt: 1 })?.kind).toBe(
			'open'
		);
		expect(toEngagementActivity({ activityType: 'email_clicked', occurredAt: 1 })?.kind).toBe(
			'click'
		);
		expect(toEngagementActivity({ activityType: 'inbound_replied', occurredAt: 1 })?.kind).toBe(
			'reply'
		);
		expect(toEngagementActivity({ activityType: 'email_complained', occurredAt: 1 })?.kind).toBe(
			'complaint'
		);
	});

	it('splits a bounce on bounceType, defaulting an unknown label to soft', () => {
		const bounce = (bounceType?: string) =>
			toEngagementActivity({ activityType: 'email_bounced', occurredAt: 1, bounceType })?.kind;
		expect(bounce('hard')).toBe('hard_bounce');
		expect(bounce('HARD')).toBe('hard_bounce');
		expect(bounce('soft')).toBe('soft_bounce');
		expect(bounce('transient-ish')).toBe('soft_bounce');
		expect(bounce(undefined)).toBe('soft_bounce');
	});

	it('ignores activity types that are not contact engagement', () => {
		const ignored: ContactActivityType[] = [
			'email_sent',
			'created',
			'property_updated',
			'topic_subscribed',
			'topic_unsubscribed',
			'topic_confirmed',
			'doi_attested',
			'inbound_received',
		];
		for (const activityType of ignored) {
			expect(toEngagementActivity({ activityType, occurredAt: 1 })).toBeNull();
		}
	});

	it('ignores a literal that is not in the catalog at all', () => {
		// `activityType` is the catalog union, so a rename breaks the BUILD rather
		// than silently stopping the score reacting. Reaching the runtime default
		// therefore needs a deliberate cast at the call site.
		const nonsense = 'nonsense' as ContactActivityType;
		expect(toEngagementActivity({ activityType: nonsense, occurredAt: 1 })).toBeNull();
	});
});
