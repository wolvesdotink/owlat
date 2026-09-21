import { POLICY_V1 } from '@owlat/ostr-core';
import { describe, expect, it } from 'vitest';
import {
	MAX_BOUNCE_RATE_BUCKET,
	MAX_UNIQUE_RECIPIENTS_BUCKET,
	bounceRateBucket,
	logScaleBucket,
} from '../buckets.js';
import { DEFAULT_K_THRESHOLDS, resolveKThresholds } from '../thresholds.js';
import { TrafficAccumulator, type MessageObservation } from '../traffic.js';
import type { TrafficAccumulatorState } from '../trafficState.js';

const WINDOW = { windowFrom: '2026-08-19T00:00:00Z', windowTo: '2026-08-20T00:00:00Z' };
// Floors below the §7.4 defaults are only reachable through the named unsafe
// opt-out, so tests that want to publish two messages have to say so.
const OPEN = {
	minMessages: 1,
	minRecipients: 1,
	minReports: 1,
	unsafeAllowBelowDefaultFloors: true,
} as const;

function observation(overrides: Partial<MessageObservation> = {}): MessageObservation {
	return {
		signingDomain: 'example.com',
		ip: '192.0.2.7',
		spfPass: true,
		dkimPass: true,
		dmarcPass: true,
		tls: true,
		recipientCount: 1,
		bounced: false,
		recipients: ['mbx-1'],
		...overrides,
	};
}

function feed(
	accumulator: TrafficAccumulator,
	count: number,
	overrides: Partial<MessageObservation> = {}
) {
	for (let i = 0; i < count; i++) {
		accumulator.observe(observation({ recipients: [`mbx-${i % 10}`], ...overrides }));
	}
}

describe('log-scale bucketing (§7.4, spec 02 §2.3.1)', () => {
	it('publishes the power-of-ten exponent, with 0 covering everything under ten', () => {
		expect(logScaleBucket(0)).toBe(0);
		expect(logScaleBucket(1)).toBe(0);
		expect(logScaleBucket(9)).toBe(0);
		expect(logScaleBucket(10)).toBe(1);
		expect(logScaleBucket(99)).toBe(1);
		expect(logScaleBucket(100)).toBe(2);
		expect(logScaleBucket(999)).toBe(2);
		expect(logScaleBucket(1000)).toBe(3);
	});

	// The whole point of the exponent encoding: what a consumer reads back is
	// 10^bucket, so a digit-count producer would inflate every count tenfold.
	it('round-trips as the order of magnitude a consumer reads', () => {
		for (const count of [10, 500, 1234, 10 ** 6]) {
			const magnitude = 10 ** logScaleBucket(count);
			expect(magnitude).toBeLessThanOrEqual(count);
			expect(count).toBeLessThan(magnitude * 10);
		}
	});

	it('caps at the maximum bucket the core publishes', () => {
		expect(logScaleBucket(10 ** 25)).toBe(MAX_UNIQUE_RECIPIENTS_BUCKET);
		expect(logScaleBucket(Number.MAX_SAFE_INTEGER)).toBe(15);
		expect(logScaleBucket(Number.POSITIVE_INFINITY)).toBe(0);
		expect(logScaleBucket(-5)).toBe(0);
	});

	it('buckets bounce rate by percent decade, not by whole percent', () => {
		expect(bounceRateBucket(0, 100)).toBe(0);
		// 0.9% is under the first band edge; 1% is on it.
		expect(bounceRateBucket(9, 1000)).toBe(0);
		expect(bounceRateBucket(1, 100)).toBe(1);
		expect(bounceRateBucket(9, 100)).toBe(1);
		// 33% and 100% are both "10% and above" — the top band is the last one.
		expect(bounceRateBucket(1, 3)).toBe(2);
		expect(bounceRateBucket(100, 100)).toBe(2);
		expect(bounceRateBucket(500, 100)).toBe(2);
		expect(bounceRateBucket(3, 0)).toBe(0);
	});

	// The encoding is only worth anything if the scorer reads it the same way.
	// If core ever redefines the bands, this fails here rather than in a
	// mis-scored subject a year of log entries later.
	it('agrees with the scoring policy about what the bands mean', () => {
		const { freeBucket, saturationBucket } = POLICY_V1.bounce;
		expect(bounceRateBucket(0, 1000)).toBe(freeBucket);
		expect(bounceRateBucket(1000, 1000)).toBe(saturationBucket);
		// Nothing this side publishes can land outside the range scoring clamps
		// to, so no honest reading is ever silently pulled to the worst one.
		for (const [bounced, messages] of [
			[0, 1],
			[1, 1000],
			[1, 100],
			[5, 100],
			[50, 100],
			[1, 1],
		] as const) {
			const bucket = bounceRateBucket(bounced, messages);
			expect(bucket).toBeGreaterThanOrEqual(freeBucket);
			expect(bucket).toBeLessThanOrEqual(saturationBucket);
			expect(bucket).toBeLessThanOrEqual(MAX_BOUNCE_RATE_BUCKET);
		}
	});
});

describe('TrafficAccumulator aggregation math', () => {
	it('counts per subject and credits both the domain and the IP', () => {
		const accumulator = new TrafficAccumulator();
		feed(accumulator, 40);
		accumulator.observe(
			observation({ spfPass: false, dmarcPass: false, tls: false, bounced: true })
		);

		const { emitted, held } = accumulator.emitTrafficSummaries({ ...WINDOW, kThresholds: OPEN });
		expect(held).toEqual([]);
		expect(emitted.map((draft) => draft.subject)).toEqual([
			{ domain: 'example.com' },
			{ ip: '192.0.2.7' },
		]);

		const [domainDraft] = emitted;
		expect(domainDraft?.kind).toBe('traffic-summary');
		expect(domainDraft?.window).toEqual({ from: WINDOW.windowFrom, to: WINDOW.windowTo });
		expect(domainDraft?.body).toEqual({
			messages: 41,
			spfPass: 40,
			dkimPass: 41,
			dmarcPass: 40,
			tlsInbound: 40,
			// Ten distinct mailbox tokens (mbx-0..mbx-9): the first decade.
			uniqueRecipientsBucket: 1,
			// One bounce in 41 messages is 2.4% — the 1%-to-10% band.
			bounceRateBucket: 1,
		});
	});

	it('never lets a pass count exceed the message count the log would reject', () => {
		const accumulator = new TrafficAccumulator();
		feed(accumulator, 30, { recipientCount: 5 });
		const [draft] = accumulator.emitTrafficSummaries({ ...WINDOW, kThresholds: OPEN }).emitted;
		const body = draft?.body;
		expect(body).toBeDefined();
		if (body === undefined) return;
		for (const field of ['spfPass', 'dkimPass', 'dmarcPass', 'tlsInbound'] as const) {
			expect(body[field]).toBeLessThanOrEqual(body.messages);
		}
	});

	it('scores unsigned mail under the IP alone', () => {
		const accumulator = new TrafficAccumulator();
		feed(accumulator, 5, { signingDomain: undefined, dkimPass: false });
		const { emitted } = accumulator.emitTrafficSummaries({ ...WINDOW, kThresholds: OPEN });
		expect(emitted.map((draft) => draft.subject)).toEqual([{ ip: '192.0.2.7' }]);
	});

	it('drops observations that name no usable subject', () => {
		const accumulator = new TrafficAccumulator();
		accumulator.observe(observation({ signingDomain: 'not a domain', ip: 'nonsense' }));
		expect(accumulator.dropped).toBe(1);
		expect(accumulator.size).toBe(0);
	});

	it('falls back to the accepted-recipient sum when no tokens are supplied', () => {
		const accumulator = new TrafficAccumulator();
		feed(accumulator, 3, { recipients: undefined, recipientCount: 4 });
		const [draft] = accumulator.emitTrafficSummaries({ ...WINDOW, kThresholds: OPEN }).emitted;
		expect(draft?.body.uniqueRecipientsBucket).toBe(logScaleBucket(12));
	});

	it('rejects a window it cannot order', () => {
		const accumulator = new TrafficAccumulator();
		expect(() =>
			accumulator.emitTrafficSummaries({
				windowFrom: '2026-08-20T00:00:00Z',
				windowTo: '2026-08-19T00:00:00Z',
			})
		).toThrow(RangeError);
		expect(() =>
			accumulator.emitTrafficSummaries({ windowFrom: 'yesterday', windowTo: 'today' })
		).toThrow(RangeError);
	});
});

describe('k-anonymity hold-back and window widening (§7.4)', () => {
	it('holds a subject below the thresholds instead of publishing it', () => {
		const accumulator = new TrafficAccumulator();
		feed(accumulator, 3);
		const { emitted, held } = accumulator.emitTrafficSummaries(WINDOW);
		expect(emitted).toEqual([]);
		expect(held).toHaveLength(2);
		expect(held[0]).toEqual({
			subject: { domain: 'example.com' },
			window: { from: WINDOW.windowFrom, to: WINDOW.windowTo },
			messages: 3,
			uniqueRecipients: 3,
			shortfall: {
				messages: DEFAULT_K_THRESHOLDS.minMessages - 3,
				recipients: DEFAULT_K_THRESHOLDS.minRecipients - 3,
			},
		});
	});

	it('widens the window automatically until the threshold is met', () => {
		const accumulator = new TrafficAccumulator();
		feed(accumulator, 12);
		const first = accumulator.emitTrafficSummaries(WINDOW);
		expect(first.emitted).toEqual([]);

		feed(accumulator, 12);
		const second = accumulator.emitTrafficSummaries({
			windowFrom: '2026-08-20T00:00:00Z',
			windowTo: '2026-08-21T00:00:00Z',
		});
		expect(second.held).toEqual([]);
		const [draft] = second.emitted;
		// The widened window spans both days, and no message is lost or double-counted.
		expect(draft?.window).toEqual({ from: '2026-08-19T00:00:00Z', to: '2026-08-21T00:00:00Z' });
		expect(draft?.body.messages).toBe(24);
	});

	it('consumes emitted subjects so a message is attested exactly once', () => {
		const accumulator = new TrafficAccumulator();
		feed(accumulator, 25);
		expect(accumulator.emitTrafficSummaries(WINDOW).emitted).toHaveLength(2);
		const next = accumulator.emitTrafficSummaries({
			windowFrom: '2026-08-20T00:00:00Z',
			windowTo: '2026-08-21T00:00:00Z',
		});
		expect(next.emitted).toEqual([]);
		expect(next.held).toEqual([]);
		expect(accumulator.size).toBe(0);
	});

	it('NEVER emits for a single-mailbox observer, at any volume or width', () => {
		const accumulator = new TrafficAccumulator();
		let from = '2026-08-19T00:00:00Z';
		for (let day = 0; day < 30; day++) {
			feed(accumulator, 500, { recipients: ['the-only-mailbox'], recipientCount: 1 });
			const to = `2026-09-${String(day + 1).padStart(2, '0')}T00:00:00Z`;
			const { emitted, held } = accumulator.emitTrafficSummaries({
				windowFrom: from,
				windowTo: to,
			});
			expect(emitted).toEqual([]);
			expect(held.some((entry) => entry.subject.domain === 'example.com')).toBe(true);
			expect(held[0]?.uniqueRecipients).toBe(1);
			// The held window keeps widening from the first unpublished start.
			expect(held[0]?.window.from).toBe('2026-08-19T00:00:00Z');
			from = to;
		}
	});

	it('honors a stricter operator threshold and ignores nonsense overrides', () => {
		expect(resolveKThresholds({ minMessages: 100 }).minMessages).toBe(100);
		expect(resolveKThresholds({ minRecipients: -1 })).toEqual(DEFAULT_K_THRESHOLDS);
		expect(resolveKThresholds()).toEqual(DEFAULT_K_THRESHOLDS);

		const accumulator = new TrafficAccumulator();
		feed(accumulator, 50);
		const { emitted, held } = accumulator.emitTrafficSummaries({
			...WINDOW,
			kThresholds: { minMessages: 1000 },
		});
		expect(emitted).toEqual([]);
		expect(held).toHaveLength(2);
	});

	it('clamps overrides that would lower a k-floor back up to the default', () => {
		expect(
			resolveKThresholds({
				minMessages: 1,
				minRecipients: 1,
				minReports: 1,
				minReporters: 1,
				minTrapHits: 1,
			})
		).toEqual(DEFAULT_K_THRESHOLDS);
		// Zero is the dangerous one: it disables the floor entirely.
		expect(resolveKThresholds({ minReporters: 0 }).minReporters).toBe(
			DEFAULT_K_THRESHOLDS.minReporters
		);
		// Raising one and lowering another keeps the raise and drops the lowering.
		expect(resolveKThresholds({ minMessages: 99, minTrapHits: 0 })).toEqual({
			...DEFAULT_K_THRESHOLDS,
			minMessages: 99,
		});
		// Only the named unsafe opt-out gets below the defaults.
		expect(
			resolveKThresholds({ minMessages: 2, unsafeAllowBelowDefaultFloors: true }).minMessages
		).toBe(2);
	});

	it('refuses to publish a sub-default subject when config asks it to', () => {
		const accumulator = new TrafficAccumulator();
		feed(accumulator, 4);
		const { emitted, held } = accumulator.emitTrafficSummaries({
			...WINDOW,
			kThresholds: { minMessages: 1, minRecipients: 1 },
		});
		expect(emitted).toEqual([]);
		expect(held).toHaveLength(2);
	});
});

describe('TrafficAccumulator persistence', () => {
	it('round-trips held state through serialize/restore', () => {
		const accumulator = new TrafficAccumulator();
		feed(accumulator, 12);
		accumulator.emitTrafficSummaries(WINDOW);

		const restored = TrafficAccumulator.restore(
			JSON.parse(JSON.stringify(accumulator.serialize()))
		);
		feed(restored, 12);
		const { emitted } = restored.emitTrafficSummaries({
			windowFrom: '2026-08-20T00:00:00Z',
			windowTo: '2026-08-21T00:00:00Z',
		});
		expect(emitted[0]?.window).toEqual({
			from: '2026-08-19T00:00:00Z',
			to: '2026-08-21T00:00:00Z',
		});
		expect(emitted[0]?.body.messages).toBe(24);
	});

	it('serializes deterministically', () => {
		const accumulator = new TrafficAccumulator();
		feed(accumulator, 4);
		expect(JSON.stringify(accumulator.serialize())).toBe(JSON.stringify(accumulator.serialize()));
		expect(accumulator.serialize().subjects.map((entry) => entry.subject)).toEqual([
			{ domain: 'example.com' },
			{ ip: '192.0.2.7' },
		]);
	});
});

describe('attribution requires a verified signature (§7.1)', () => {
	it('lands a forged d= under the connecting IP alone', () => {
		const accumulator = new TrafficAccumulator();
		feed(accumulator, 5, { signingDomain: 'victim.example', dkimPass: false, dmarcPass: false });
		const { emitted } = accumulator.emitTrafficSummaries({ ...WINDOW, kThresholds: OPEN });
		expect(emitted.map((draft) => draft.subject)).toEqual([{ ip: '192.0.2.7' }]);
		expect(accumulator.unverifiedAttributions).toBe(5);
		expect(accumulator.dropped).toBe(0);
	});

	it('drops an observation whose only subject was an unverified d=', () => {
		const accumulator = new TrafficAccumulator();
		accumulator.observe(
			observation({ signingDomain: 'victim.example', ip: 'nonsense', dkimPass: false })
		);
		expect(accumulator.size).toBe(0);
		expect(accumulator.dropped).toBe(1);
		expect(accumulator.unverifiedAttributions).toBe(1);
	});

	it('credits a verified but unaligned d= when the caller says so explicitly', () => {
		const accumulator = new TrafficAccumulator();
		feed(accumulator, 5, {
			dkimPass: false,
			dmarcPass: false,
			signingDomainVerified: true,
		});
		const { emitted } = accumulator.emitTrafficSummaries({ ...WINDOW, kThresholds: OPEN });
		expect(emitted.map((draft) => draft.subject)).toEqual([
			{ domain: 'example.com' },
			{ ip: '192.0.2.7' },
		]);
		expect(accumulator.unverifiedAttributions).toBe(0);
		// dkimPass still counts what the caller passed: the two are separate facts.
		expect(emitted[0]?.body.dkimPass).toBe(0);
	});

	it('counts an unusable recipient count instead of silently folding it to zero', () => {
		const accumulator = new TrafficAccumulator();
		accumulator.observe(observation({ recipientCount: -3 }));
		accumulator.observe(observation({ recipientCount: 1.5 }));
		accumulator.observe(observation({ recipientCount: 2 }));
		expect(accumulator.unattributedRecipients).toBe(2);
	});
});

describe('held subjects are bounded (§7.2 retention, §7.4)', () => {
	function flood(accumulator: TrafficAccumulator, count: number): void {
		for (let i = 0; i < count; i++) {
			accumulator.observe({
				signingDomain: undefined,
				ip: `10.${(i >> 16) & 0xff}.${(i >> 8) & 0xff}.${i & 0xff}`,
				spfPass: false,
				dkimPass: false,
				dmarcPass: false,
				tls: false,
				recipientCount: 1,
				bounced: false,
				recipients: ['mbx-1'],
			});
		}
	}

	it('stays bounded under a flood of 100 000 distinct source addresses', () => {
		const accumulator = new TrafficAccumulator({ maxSubjects: 1000 });
		flood(accumulator, 100_000);
		expect(accumulator.size).toBeLessThanOrEqual(1000);
		expect(accumulator.evicted).toBeGreaterThan(90_000);
	});

	it('keeps the subjects closest to publishable and evicts the smallest', () => {
		const accumulator = new TrafficAccumulator({ maxSubjects: 4 });
		for (let i = 0; i < 20; i++) accumulator.observe(observation({ ip: '192.0.2.7' }));
		flood(accumulator, 50);
		const state = accumulator.serialize();
		expect(state.subjects.some((entry) => entry.subject.ip === '192.0.2.7')).toBe(true);
		expect(accumulator.size).toBeLessThanOrEqual(4);
	});

	it('prunes held state, and its recipient tokens, past the retention cutoff', () => {
		const accumulator = new TrafficAccumulator();
		feed(accumulator, 3);
		accumulator.emitTrafficSummaries(WINDOW);
		expect(accumulator.size).toBe(2);

		expect(accumulator.dropHeldBefore('2026-08-19T00:00:00Z')).toBe(0);
		expect(accumulator.dropHeldBefore('2026-11-19T00:00:00Z')).toBe(2);
		expect(accumulator.size).toBe(0);
		expect(JSON.stringify(accumulator.serialize())).not.toContain('mbx-');
	});

	it('leaves the window still being filled alone, and refuses an unorderable cutoff', () => {
		const accumulator = new TrafficAccumulator();
		feed(accumulator, 3);
		expect(accumulator.dropHeldBefore('2026-11-19T00:00:00Z')).toBe(0);
		expect(accumulator.size).toBe(2);
		expect(() => accumulator.dropHeldBefore('last tuesday')).toThrow(RangeError);
	});
});

describe('restoring persisted state is validated, not trusted', () => {
	const held = (): TrafficAccumulatorState => {
		const accumulator = new TrafficAccumulator();
		feed(accumulator, 3);
		accumulator.emitTrafficSummaries(WINDOW);
		return JSON.parse(JSON.stringify(accumulator.serialize())) as TrafficAccumulatorState;
	};

	it('refuses a blob from another version', () => {
		const state = { ...held(), v: 2 } as unknown as TrafficAccumulatorState;
		expect(() => TrafficAccumulator.restore(state)).toThrow(RangeError);
		expect(() =>
			TrafficAccumulator.restore({ v: 1 } as unknown as TrafficAccumulatorState)
		).toThrow(RangeError);
	});

	it('clamps corrupt counters instead of signing them', () => {
		const state = held();
		const [first] = state.subjects;
		if (first === undefined) throw new Error('expected a held subject');
		first.messages = -5;
		first.spfPass = 99;
		first.dkimPass = Number.NaN;
		first.recipientTotal = 1.5;
		const restored = TrafficAccumulator.restore(state);
		const [entry] = restored.serialize().subjects;
		expect(entry).toMatchObject({ messages: 0, spfPass: 0, dkimPass: 0, recipientTotal: 0 });
	});

	it('merges a duplicated subject key rather than dropping its traffic', () => {
		const state = held();
		const [first] = state.subjects;
		if (first === undefined) throw new Error('expected a held subject');
		state.subjects = [first, { ...first, messages: 7, heldFrom: '2026-08-01T00:00:00Z' }];
		const restored = TrafficAccumulator.restore(state);
		const subjects = restored.serialize().subjects;
		expect(subjects).toHaveLength(1);
		expect(subjects[0]?.messages).toBe(first.messages + 7);
		expect(subjects[0]?.heldFrom).toBe('2026-08-01T00:00:00Z');
	});

	it('skips an entry whose subject no longer names anyone', () => {
		const state = held();
		state.subjects.push({
			...(state.subjects[0] as (typeof state.subjects)[number]),
			subject: { domain: 'not a domain' },
		});
		expect(TrafficAccumulator.restore(state).serialize().subjects).toHaveLength(2);
	});
});
