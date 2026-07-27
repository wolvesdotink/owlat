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
import { DAY_MS, SNDS_COMPLAINT_BANDS } from '../sndsFeed';
import {
	buildSndsGateInput,
	DEFAULT_SNDS_GATE_THRESHOLDS,
	evaluateSndsGate,
	sndsPromotionPass,
	type SndsGateObservation,
} from '../sndsGate';
import { SNDS_GATE_MAX_ROWS } from '../snds';

import { modules } from './helpers/convexModules';

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
	it('fails at or above the breach band and names the BAND, never a rate', () => {
		for (const band of ['0_1_to_0_2', '0_3_to_0_4', '0_5_to_0_6', 'gte_0_9'] as const) {
			const verdict = evaluateSndsGate(gateInput([observation({ complaintBand: band })]));
			expect(verdict.verdict, band).toBe('fail');
			if (verdict.verdict !== 'fail') continue;
			expect(verdict.failedGate).toBe('complaint_band');
			expect(verdict.reason).toContain(band);
			expect(verdict.reason).not.toMatch(FABRICATED_RATE_RE);
		}
	});

	it('passes below the breach band', () => {
		for (const band of ['lt_0_1'] as const) {
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

	it('fails on a red filter result but not on yellow by default', () => {
		const red = evaluateSndsGate(gateInput([observation({ filterResult: 'red' })]));
		expect(red.verdict).toBe('fail');
		expect(red.verdict === 'fail' && red.failedGate).toBe('filter_result');

		const yellow = evaluateSndsGate(gateInput([observation({ filterResult: 'yellow' })]));
		expect(yellow.verdict).toBe('pass');

		const strict = evaluateSndsGate(gateInput([observation({ filterResult: 'yellow' })]), {
			...DEFAULT_SNDS_GATE_THRESHOLDS,
			breachOnYellow: true,
		});
		expect(strict.verdict).toBe('fail');
	});

	it('fails on a spam-trap hit, ahead of every other signal', () => {
		const verdict = evaluateSndsGate(
			gateInput([observation({ trapHits: 1, complaintBand: 'lt_0_1', filterResult: 'green' })])
		);
		expect(verdict.verdict).toBe('fail');
		expect(verdict.verdict === 'fail' && verdict.failedGate).toBe('spam_traps');
	});

	it('is a low-confidence signal when the read was truncated, and never promotes', () => {
		const clean = [
			observation({ complaintBand: 'lt_0_1', periodStart: Date.UTC(2026, 6, 20) }),
			observation({ complaintBand: 'lt_0_1', periodStart: Date.UTC(2026, 6, 21) }),
		];
		const whole = buildSndsGateInput({ enrolled: true, windowDays: 7, observations: clean });
		const cut = buildSndsGateInput({
			enrolled: true,
			windowDays: 7,
			observations: clean,
			truncated: true,
		});
		expect(whole.available && cut.available).toBe(true);
		if (!whole.available || !cut.available) return;
		// Same rows, and the only difference is that the read was cut short.
		expect(whole.signal.truncated).toBe(false);
		expect(whole.signal.confidence).toBe('high');
		expect(sndsPromotionPass(whole)).toBe(true);
		expect(cut.signal.truncated).toBe(true);
		expect(cut.signal.confidence).toBe('low');
		// A truncated window is still allowed to REPORT a pass — it just cannot be
		// the positive evidence a promotion needs.
		expect(evaluateSndsGate(cut).verdict).toBe('pass');
		expect(sndsPromotionPass(cut)).toBe(false);
	});

	it('promotes only on a banded, multi-day, whole window below the breach band', () => {
		// One fixture row per band: exactly the cleanest band may promote.
		for (const band of SNDS_COMPLAINT_BANDS) {
			const input = gateInput([
				observation({ complaintBand: band, periodStart: Date.UTC(2026, 6, 20) }),
				observation({ complaintBand: band, periodStart: Date.UTC(2026, 6, 21) }),
			]);
			expect(sndsPromotionPass(input), band).toBe(band === 'lt_0_1');
		}
		// A single clean day is a pass, but not yet positive evidence.
		expect(evaluateSndsGate(gateInput([observation({ complaintBand: 'lt_0_1' })])).verdict).toBe(
			'pass'
		);
		expect(sndsPromotionPass(gateInput([observation({ complaintBand: 'lt_0_1' })]))).toBe(false);
		// Absence never promotes — and never demotes either (D2/D10).
		expect(
			sndsPromotionPass(buildSndsGateInput({ enrolled: false, windowDays: 7, observations: [] }))
		).toBe(false);
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
		expect(evaluateSndsGate(input).verdict).toBe('fail');
		expect(input.signal.truncated).toBe(false);
	});

	it('reads the NEWEST days first, so a same-day breach survives the row cap', async () => {
		const t = convexTest(schema, modules);
		process.env['SNDS_DATA_FEED_URLS'] = 'https://snds.example.test/feed';
		const now = Date.now();
		const today = Math.floor(now / DAY_MS) * DAY_MS;
		// More rows than one read may return, with the BREACH on the newest day.
		// An ascending scan would spend the cap on the oldest days and answer
		// `pass` from a window that no longer contains the breach.
		await t.run(async (ctx) => {
			for (let index = 0; index <= SNDS_GATE_MAX_ROWS; index += 1) {
				const newest = index === SNDS_GATE_MAX_ROWS;
				await ctx.db.insert('sndsIpDailyStats', {
					ip: `203.0.113.${index % 250}`,
					// Oldest rows first in insertion order; the newest day is last.
					periodStart: newest ? today : today - (1 + (index % 6)) * DAY_MS,
					complaintBand: newest ? 'gte_0_9' : 'lt_0_1',
					filterResult: newest ? 'red' : 'green',
					trapHits: 0,
					messageRecipients: 10,
					rcptCommands: 10,
					dataCommands: 10,
					fetchedAt: now,
					ingestedAt: now,
				});
			}
		});

		const input = await t.query(internal.delivery.snds.getMicrosoftGateInput, { windowDays: 7 });
		expect(input.available).toBe(true);
		if (!input.available) return;
		expect(input.signal.worstFilterResult).toBe('red');
		expect(input.signal.worstComplaintBand).toBe('gte_0_9');
		expect(evaluateSndsGate(input).verdict).toBe('fail');
		// The window is a subset, so it can never justify an increase.
		expect(input.signal.truncated).toBe(true);
		expect(input.signal.confidence).toBe('low');
		expect(sndsPromotionPass(input)).toBe(false);
	});
});
