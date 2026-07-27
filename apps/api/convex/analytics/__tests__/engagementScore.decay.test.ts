import { describe, it, expect } from 'vitest';
import type { Doc } from '../../_generated/dataModel';
import type { ContactActivityType } from '../../contactActivities/catalog';
import {
	ENGAGEMENT_HALF_LIFE_DAYS,
	computeEngagementScore,
	decayState,
	engagementBand,
	scoreFromState,
	type EngagementActivity,
	type EngagementScoreState,
} from '../engagementScore';
import { engagementPatchForActivity } from '../engagementScoreSync';

/**
 * Decay properties of the engagement score (deliverability plan P0-2).
 *
 * Three invariants the controller and the MTA priority bands depend on:
 *  - MONOTONICITY: with no new activity, time only ever lowers the score.
 *  - DETERMINISM: identical inputs give a byte-identical result.
 *  - NO DAY-BOUNDARY CLIFF: decay is continuous, so nobody changes band because
 *    a UTC day rolled over. (A step-function decay would make the MTA's
 *    priority assignment jitter at midnight for the whole book at once.)
 */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 27, 12, 0, 0);

const TIMELINE: EngagementActivity[] = [
	{ kind: 'click', occurredAt: NOW - 4 * DAY },
	{ kind: 'open', occurredAt: NOW - 2 * DAY },
	{ kind: 'open', occurredAt: NOW - 18 * DAY },
	{ kind: 'soft_bounce', occurredAt: NOW - 40 * DAY },
];

const TENURE_STARTED_AT = NOW - 300 * DAY;

function scoreAt(now: number): number {
	return computeEngagementScore({
		activities: TIMELINE,
		tenureStartedAt: TENURE_STARTED_AT,
		now,
	}).score;
}

describe('monotonicity', () => {
	it('is non-increasing as `now` advances with no new activity', () => {
		let previous = Number.POSITIVE_INFINITY;
		for (let day = 0; day <= 365; day += 1) {
			const score = scoreAt(NOW + day * DAY);
			expect(score).toBeLessThanOrEqual(previous);
			previous = score;
		}
		expect(previous).toBeLessThan(20);
	});

	it('is non-increasing at hour granularity too (no local bumps)', () => {
		let previous = Number.POSITIVE_INFINITY;
		for (let hour = 0; hour <= 24 * 30; hour += 1) {
			const score = scoreAt(NOW + hour * HOUR);
			expect(score).toBeLessThanOrEqual(previous);
			previous = score;
		}
	});

	it('halves the accumulator over exactly one half-life', () => {
		const state: EngagementScoreState = { raw: 64, softBounceRaw: 8, isSuppressed: false };
		const decayed = decayState(state, NOW, NOW + ENGAGEMENT_HALF_LIFE_DAYS * DAY);
		expect(decayed.raw).toBeCloseTo(32, 9);
		expect(decayed.softBounceRaw).toBeCloseTo(4, 9);
	});

	it('never lets a suppressed contact recover through decay alone', () => {
		const suppressedState: EngagementScoreState = {
			raw: 40,
			softBounceRaw: 0,
			isSuppressed: true,
		};
		for (const days of [0, 30, 400, 5000]) {
			const projected = scoreFromState({
				state: suppressedState,
				stateAt: NOW,
				tenureStartedAt: TENURE_STARTED_AT,
				now: NOW + days * DAY,
			});
			expect(projected.score).toBe(0);
			expect(projected.state.isSuppressed).toBe(true);
		}
	});
});

describe('determinism', () => {
	it('gives an identical result for identical inputs', () => {
		const a = computeEngagementScore({
			activities: TIMELINE,
			tenureStartedAt: TENURE_STARTED_AT,
			now: NOW,
		});
		const b = computeEngagementScore({
			activities: TIMELINE,
			tenureStartedAt: TENURE_STARTED_AT,
			now: NOW,
		});
		expect(a).toEqual(b);
	});

	it('does not depend on the order the activities arrive in', () => {
		const forward = computeEngagementScore({
			activities: TIMELINE,
			tenureStartedAt: TENURE_STARTED_AT,
			now: NOW,
		});
		const reversed = computeEngagementScore({
			activities: [...TIMELINE].reverse(),
			tenureStartedAt: TENURE_STARTED_AT,
			now: NOW,
		});
		expect(reversed.score).toBe(forward.score);
		expect(reversed.state.raw).toBeCloseTo(forward.state.raw, 9);
	});
});

describe('no UTC-day-boundary cliff', () => {
	const boundary = Date.UTC(2026, 6, 28, 0, 0, 0);

	it('moves by at most a point across midnight, and never changes band', () => {
		const singleOpen: EngagementActivity[] = [{ kind: 'open', occurredAt: NOW - 9 * DAY }];
		for (const timeline of [TIMELINE, singleOpen]) {
			const before = computeEngagementScore({
				activities: timeline,
				tenureStartedAt: TENURE_STARTED_AT,
				now: boundary - 1000,
			}).score;
			const after = computeEngagementScore({
				activities: timeline,
				tenureStartedAt: TENURE_STARTED_AT,
				now: boundary + 1000,
			}).score;
			expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
			expect(engagementBand(after)).toBe(engagementBand(before));
		}
	});

	it('holds for a brand-new contact, whose tenure prior decays fastest', () => {
		const born = boundary - 2 * DAY;
		const before = computeEngagementScore({
			activities: [],
			tenureStartedAt: born,
			now: boundary - 1000,
		}).score;
		const after = computeEngagementScore({
			activities: [],
			tenureStartedAt: born,
			now: boundary + 1000,
		}).score;
		expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
		expect(engagementBand(after)).toBe(engagementBand(before));
	});
});

/**
 * The divergence that actually matters is between the SYNC LAYER's hot path and
 * the pure core's full recompute — not between the core and a re-implementation
 * of its own loop. So this drives `engagementPatchForActivity`, the real
 * function `contactActivities/writer.ts` calls, over the same timeline and
 * compares the contact document it produces against `computeEngagementScore`.
 * `engagementPatchForActivity` is pure, so a plain contact stub is enough.
 */
describe('fold/increment equivalence — sync hot path vs full recompute', () => {
	type ContactFields = {
		createdAt: number;
		deletedAt?: number | undefined;
		engagementScore?: number | undefined;
		engagementScoreUpdatedAt?: number | undefined;
		engagementScoreState?: EngagementScoreState | undefined;
	};

	const asContact = (fields: ContactFields): Doc<'contacts'> =>
		fields as unknown as Doc<'contacts'>;

	/** The activity literal + bounce label the writer would pass for each kind. */
	const WRITER_ARGS: Record<
		EngagementActivity['kind'],
		{ activityType: ContactActivityType; bounceType?: string }
	> = {
		open: { activityType: 'email_opened' },
		click: { activityType: 'email_clicked' },
		reply: { activityType: 'inbound_replied' },
		soft_bounce: { activityType: 'email_bounced', bounceType: 'soft' },
		hard_bounce: { activityType: 'email_bounced', bounceType: 'hard' },
		complaint: { activityType: 'email_complained' },
	};

	/**
	 * Replay a timeline through the sync layer in `arrival` order, each activity
	 * observed at `observedAt` (never before it happened), and return the contact
	 * as the writer would have left it.
	 */
	function replayThroughSyncLayer(arrival: readonly EngagementActivity[]): ContactFields {
		let contact: ContactFields = { createdAt: TENURE_STARTED_AT };
		let clock = arrival[0]?.occurredAt ?? NOW;

		for (const activity of arrival) {
			clock = Math.max(clock, activity.occurredAt);
			const writerArgs = WRITER_ARGS[activity.kind];
			const patch = engagementPatchForActivity({
				contact: asContact(contact),
				activityType: writerArgs.activityType,
				occurredAt: activity.occurredAt,
				bounceType: writerArgs.bounceType,
				now: clock,
			});
			if (patch === null) continue;
			contact = { ...contact, ...patch };
		}
		return contact;
	}

	function projectToNow(contact: ContactFields) {
		return scoreFromState({
			state: contact.engagementScoreState ?? { raw: 0, softBounceRaw: 0, isSuppressed: false },
			stateAt: contact.engagementScoreUpdatedAt ?? NOW,
			tenureStartedAt: TENURE_STARTED_AT,
			now: NOW,
		});
	}

	const full = computeEngagementScore({
		activities: TIMELINE,
		tenureStartedAt: TENURE_STARTED_AT,
		now: NOW,
	});

	it('agrees with a full recompute when activities arrive in order', () => {
		const chronological = [...TIMELINE].sort((a, b) => a.occurredAt - b.occurredAt);
		const projected = projectToNow(replayThroughSyncLayer(chronological));

		expect(projected.score).toBe(full.score);
		expect(projected.state.raw).toBeCloseTo(full.state.raw, 9);
		expect(projected.state.softBounceRaw).toBeCloseTo(full.state.softBounceRaw, 9);
	});

	it('agrees with a full recompute when activities arrive out of order', () => {
		// Newest first: every later fold is a LATE-ARRIVING activity, the case the
		// hot path handles by folding forward to the accumulator's instant.
		const newestFirst = [...TIMELINE].sort((a, b) => b.occurredAt - a.occurredAt);
		const projected = projectToNow(replayThroughSyncLayer(newestFirst));

		expect(projected.score).toBe(full.score);
		expect(projected.state.raw).toBeCloseTo(full.state.raw, 9);
	});

	it('agrees with a full recompute after a redelivered webhook', () => {
		const chronological = [...TIMELINE].sort((a, b) => a.occurredAt - b.occurredAt);
		const withRedelivery: EngagementActivity[] = [];
		for (const activity of chronological) {
			withRedelivery.push(activity, { ...activity });
		}
		const projected = projectToNow(replayThroughSyncLayer(withRedelivery));

		expect(projected.score).toBe(full.score);
		expect(projected.state.raw).toBeCloseTo(full.state.raw, 9);
	});

	it('suppresses through the hot path exactly as the recompute does', () => {
		const timeline: EngagementActivity[] = [
			{ kind: 'click', occurredAt: NOW - 3 * DAY },
			{ kind: 'hard_bounce', occurredAt: NOW - DAY },
		];
		const contact = replayThroughSyncLayer(timeline);
		const recomputed = computeEngagementScore({
			activities: timeline,
			tenureStartedAt: TENURE_STARTED_AT,
			now: NOW,
		});

		expect(contact.engagementScore).toBe(0);
		expect(contact.engagementScoreState?.isSuppressed).toBe(true);
		expect(contact.engagementScoreState?.suppressedAt).toBe(NOW - DAY);
		expect(recomputed.score).toBe(0);
		expect(recomputed.state.suppressedAt).toBe(NOW - DAY);
	});
});
