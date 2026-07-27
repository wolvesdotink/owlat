/**
 * P4-1 (b): gate 3 for the Microsoft cell consumes the BAND.
 *
 * SNDS publishes a complaint BAND, not a rate. The load-bearing property under
 * test is negative: nowhere between the feed and the verdict does a band
 * become a percentage. A fabricated rate would look like evidence to a
 * controller that compares numbers, and Microsoft never published it.
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { SNDS_COMPLAINT_BANDS } from '../sndsFeed';
import {
	buildSndsGateInput,
	DEFAULT_SNDS_GATE_THRESHOLDS,
	evaluateSndsGate,
	type SndsGateObservation,
} from '../sndsGate';

const rootGlob = import.meta.glob('../../**/*.*s');
const deliveryGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, module]) => [
		path.replace(/^\.\.\//, '../../delivery/'),
		module,
	])
);
const modules = { ...rootGlob, ...deliveryGlob };

const DAY_MS = 24 * 60 * 60 * 1_000;

afterEach(() => {
	delete process.env['SNDS_DATA_FEED_URLS'];
});

function observation(overrides: Partial<SndsGateObservation> = {}): SndsGateObservation {
	return {
		ip: '203.0.113.10',
		periodStart: Date.UTC(2026, 6, 20),
		complaintBand: 'lt_0_1',
		filterResult: 'green',
		trapHits: 0,
		...overrides,
	};
}

function gateInput(observations: SndsGateObservation[]) {
	return buildSndsGateInput({ enrolled: true, windowDays: 7, observations });
}

/** A percentage the feed never published, e.g. `0.15%` or `0.0015`. */
const FABRICATED_RATE_RE = /\d+\.\d+\s*%|0\.00\d+/;

describe('SNDS gate input', () => {
	it('folds the window to the worst band, worst filter result and total traps', () => {
		const input = gateInput([
			observation({ complaintBand: 'lt_0_1', filterResult: 'green', trapHits: 0 }),
			observation({
				ip: '203.0.113.11',
				periodStart: Date.UTC(2026, 6, 21),
				complaintBand: '0_2_to_0_3',
				filterResult: 'yellow',
				trapHits: 3,
			}),
			observation({ periodStart: Date.UTC(2026, 6, 21), complaintBand: 'unknown' }),
		]);

		expect(input.available).toBe(true);
		if (!input.available) return;
		expect(input.signal.worstComplaintBand).toBe('0_2_to_0_3');
		expect(input.signal.worstFilterResult).toBe('yellow');
		expect(input.signal.trapHits).toBe(3);
		expect(input.signal.observedIps).toBe(2);
		expect(input.signal.observedDays).toBe(2);
		expect(input.signal.confidence).toBe('high');
	});

	it('reports low confidence when Microsoft banded nothing, however many rows arrive', () => {
		const input = gateInput(
			Array.from({ length: 50 }, (_, index) =>
				observation({
					complaintBand: 'unknown',
					periodStart: Date.UTC(2026, 6, 1) + index * DAY_MS,
				})
			)
		);
		expect(input.available).toBe(true);
		if (!input.available) return;
		expect(input.signal.worstComplaintBand).toBe('unknown');
		expect(input.signal.confidence).toBe('low');
	});
});

describe('SNDS gate verdict', () => {
	it('breaches at or above the breach band and names the BAND, never a rate', () => {
		for (const band of ['0_3_to_0_4', '0_5_to_0_6', 'gte_0_9'] as const) {
			const verdict = evaluateSndsGate(gateInput([observation({ complaintBand: band })]));
			expect(verdict.verdict, band).toBe('breach');
			if (verdict.verdict !== 'breach') continue;
			expect(verdict.failedSignal).toBe('complaint_band');
			expect(verdict.reason).toContain(band);
			expect(verdict.reason).not.toMatch(FABRICATED_RATE_RE);
		}
	});

	it('passes below the breach band', () => {
		for (const band of ['lt_0_1', '0_1_to_0_2', '0_2_to_0_3'] as const) {
			const verdict = evaluateSndsGate(gateInput([observation({ complaintBand: band })]));
			expect(verdict.verdict, band).toBe('pass');
			expect(verdict.reason).toContain(band);
		}
	});

	it('never derives a percentage from a band, for ANY band', () => {
		for (const band of SNDS_COMPLAINT_BANDS) {
			const verdict = evaluateSndsGate(gateInput([observation({ complaintBand: band })]));
			expect(verdict.reason, band).not.toMatch(FABRICATED_RATE_RE);
		}
	});

	it('breaches on a red filter result but not on yellow by default', () => {
		const red = evaluateSndsGate(gateInput([observation({ filterResult: 'red' })]));
		expect(red.verdict).toBe('breach');
		expect(red.verdict === 'breach' && red.failedSignal).toBe('filter_result');

		const yellow = evaluateSndsGate(gateInput([observation({ filterResult: 'yellow' })]));
		expect(yellow.verdict).toBe('pass');

		const strict = evaluateSndsGate(gateInput([observation({ filterResult: 'yellow' })]), {
			...DEFAULT_SNDS_GATE_THRESHOLDS,
			breachOnYellow: true,
		});
		expect(strict.verdict).toBe('breach');
	});

	it('breaches on a spam-trap hit, ahead of every other signal', () => {
		const verdict = evaluateSndsGate(
			gateInput([observation({ trapHits: 1, complaintBand: 'lt_0_1', filterResult: 'green' })])
		);
		expect(verdict.verdict).toBe('breach');
		expect(verdict.verdict === 'breach' && verdict.failedSignal).toBe('spam_traps');
	});

	it('HOLDS on an unbanded window: insufficient_data, never a decrease (D10)', () => {
		const verdict = evaluateSndsGate(gateInput([observation({ complaintBand: 'unknown' })]));
		expect(verdict.verdict).toBe('insufficient_data');
		expect(verdict.verdict === 'insufficient_data' && verdict.substitution.dwellMultiplier).toBe(2);
	});
});

describe('getMicrosoftGateInput', () => {
	it('reads the stored bands straight out of the table', async () => {
		const t = convexTest(schema, modules);
		process.env['SNDS_DATA_FEED_URLS'] = 'https://snds.example.test/feed';
		const now = Date.now();
		await t.run(async (ctx) => {
			await ctx.db.insert('sndsIpDailyStats', {
				ip: '203.0.113.10',
				periodStart: Math.floor((now - DAY_MS) / DAY_MS) * DAY_MS,
				complaintBand: '0_4_to_0_5',
				filterResult: 'green',
				trapHits: 0,
				messageRecipients: 100,
				rcptCommands: 100,
				dataCommands: 100,
				fetchedAt: now,
				ingestedAt: now,
			});
			// Outside the window — must not reach the gate.
			await ctx.db.insert('sndsIpDailyStats', {
				ip: '203.0.113.10',
				periodStart: Math.floor((now - 30 * DAY_MS) / DAY_MS) * DAY_MS,
				complaintBand: 'gte_0_9',
				filterResult: 'red',
				trapHits: 9,
				messageRecipients: 100,
				rcptCommands: 100,
				dataCommands: 100,
				fetchedAt: now,
				ingestedAt: now,
			});
		});

		const input = await t.query(internal.delivery.snds.getMicrosoftGateInput, { windowDays: 7 });
		expect(input.available).toBe(true);
		if (!input.available) return;
		expect(input.signal.worstComplaintBand).toBe('0_4_to_0_5');
		expect(input.signal.trapHits).toBe(0);
		expect(evaluateSndsGate(input).verdict).toBe('breach');
	});
});
