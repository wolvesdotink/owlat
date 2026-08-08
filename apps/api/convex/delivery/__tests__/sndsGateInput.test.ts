/**
 * P4-1 (b): gate 3 for the Microsoft cell consumes the BAND.
 *
 * SNDS publishes a complaint BAND, not a rate. The load-bearing property under
 * test is negative: nowhere between the feed and the verdict does a band
 * become a percentage. A fabricated rate would look like evidence to a
 * controller that compares numbers, and Microsoft never published it.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { DAY_MS, SNDS_COMPLAINT_BANDS } from '../sndsFeed';
import {
	buildSndsGateInput,
	DEFAULT_SNDS_GATE_THRESHOLDS,
	evaluateSndsGate,
	sndsPromotionPass,
	type SndsGateObservation,
} from '../signals/snds';
import { SNDS_GATE_MAX_ROWS } from '../snds';

import { modules } from './helpers/convexModules';

/**
 * A fixed, mid-day simulated instant. The Convex fixtures below seed rows
 * relative to "today" while the query derives its cutoff from `Date.now()`;
 * on the real clock those two reads can land on opposite sides of UTC midnight
 * and shift the cutoff relative to the seeded days.
 */
const NOW = Date.UTC(2026, 6, 22, 12, 0, 0);

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
	delete process.env['SNDS_DATA_FEED_URLS'];
	delete process.env['MTA_IP_POOLS'];
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

function gateInput(
	observations: SndsGateObservation[],
	flags: { truncated?: boolean; attributed?: boolean } = {}
) {
	return buildSndsGateInput({
		enrolled: true,
		windowDays: 7,
		observations,
		truncated: flags.truncated ?? false,
		attributed: flags.attributed ?? true,
	});
}

/**
 * A percentage the feed never published, e.g. `0.15%`, `1 %` or `0.0015`.
 *
 * The fractional part is OPTIONAL on purpose: `above 1%` is just as fabricated a
 * precision as `above 0.15%`, and a regex that only caught decimals would let
 * the next reason string say exactly the thing this test forbids.
 */
const FABRICATED_RATE_RE = /\d+(?:\.\d+)?\s*%|0\.00\d+/;

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
			expect(verdict.failedSignal).toBe('complaint_band');
			// Every SNDS breach reports under the ONE shipped complaint gate id (D12).
			expect(verdict.gate).toBe('complaint');
			expect(verdict.reason).toContain(band);
			expect(verdict.reason).not.toMatch(FABRICATED_RATE_RE);
		}
	});

	it('passes below the breach band, and only below it', () => {
		for (const band of SNDS_COMPLAINT_BANDS) {
			const verdict = evaluateSndsGate(gateInput([observation({ complaintBand: band })]));
			const expected =
				band === 'unknown' ? 'insufficient_data' : band === 'lt_0_1' ? 'pass' : 'fail';
			expect(verdict.verdict, band).toBe(expected);
		}
		const clean = evaluateSndsGate(gateInput([observation({ complaintBand: 'lt_0_1' })]));
		expect(clean.reason).toContain('lt_0_1');
	});

	it('never derives a percentage from a band, for ANY band', () => {
		for (const band of SNDS_COMPLAINT_BANDS) {
			const verdict = evaluateSndsGate(gateInput([observation({ complaintBand: band })]));
			expect(verdict.reason, band).not.toMatch(FABRICATED_RATE_RE);
		}
	});

	it('fails on a red filter result, never on yellow', () => {
		const red = evaluateSndsGate(gateInput([observation({ filterResult: 'red' })]));
		expect(red.verdict).toBe('fail');
		expect(red.verdict === 'fail' && red.failedSignal).toBe('filter_result');

		// Yellow moves often; on its own it would make the ramp chatter, so `red` is
		// the only breaching filter result and there is no knob that changes that.
		const yellow = evaluateSndsGate(gateInput([observation({ filterResult: 'yellow' })]));
		expect(yellow.verdict).toBe('pass');
	});

	it('a stricter breach band tightens the gate without a second code path', () => {
		const clean = gateInput([observation({ complaintBand: 'lt_0_1' })]);
		expect(evaluateSndsGate(clean).verdict).toBe('pass');
		expect(
			evaluateSndsGate(clean, { ...DEFAULT_SNDS_GATE_THRESHOLDS, breachBand: 'lt_0_1' }).verdict
		).toBe('fail');
	});

	it('fails on a spam-trap hit, ahead of every other signal', () => {
		const verdict = evaluateSndsGate(
			gateInput([observation({ trapHits: 1, complaintBand: 'lt_0_1', filterResult: 'green' })])
		);
		expect(verdict.verdict).toBe('fail');
		expect(verdict.verdict === 'fail' && verdict.failedSignal).toBe('spam_traps');
	});

	it('HOLDS on trap hits it cannot attribute, and says so in the reason', () => {
		// No declared pool: the window folds every address in the SNDS key's
		// registered range, so a trap hit may be a neighbour's. Unattributable
		// evidence must not move the share in EITHER direction (D10).
		const traps = evaluateSndsGate(
			gateInput([observation({ trapHits: 2 })], { attributed: false })
		);
		expect(traps.verdict).toBe('insufficient_data');
		expect(traps.reason).toContain('MTA_IP_POOLS');

		// Corroborated by a banded breach, the same window fails — the trap count
		// is no longer the only breaching evidence.
		const corroborated = evaluateSndsGate(
			gateInput([observation({ trapHits: 2, complaintBand: 'gte_0_9' })], { attributed: false })
		);
		expect(corroborated.verdict).toBe('fail');
		expect(corroborated.verdict === 'fail' && corroborated.failedSignal).toBe('spam_traps');
		expect(corroborated.reason).toContain('MTA_IP_POOLS');

		// Attributed to a declared address, one trap hit fails outright.
		const attributed = evaluateSndsGate(gateInput([observation({ trapHits: 2 })]));
		expect(attributed.verdict).toBe('fail');
		expect(attributed.reason).not.toContain('MTA_IP_POOLS');
	});

	it('carries the attribution caveat on every unattributed verdict (D12/D14)', () => {
		for (const observed of [
			observation({ complaintBand: 'lt_0_1' }),
			observation({ complaintBand: 'gte_0_9' }),
			observation({ filterResult: 'red' }),
		]) {
			const verdict = evaluateSndsGate(gateInput([observed], { attributed: false }));
			expect(verdict.reason, verdict.reason).toContain('MTA_IP_POOLS');
			// The caveat names a remedy, never a fabricated rate.
			expect(verdict.reason).not.toMatch(FABRICATED_RATE_RE);
		}
	});

	it('is a low-confidence signal when the read was truncated, and never promotes', () => {
		const clean = [
			observation({ complaintBand: 'lt_0_1', periodStart: Date.UTC(2026, 6, 20) }),
			observation({ complaintBand: 'lt_0_1', periodStart: Date.UTC(2026, 6, 21) }),
		];
		const whole = gateInput(clean);
		const cut = gateInput(clean, { truncated: true });
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
			sndsPromotionPass(
				buildSndsGateInput({
					enrolled: false,
					windowDays: 7,
					observations: [],
					truncated: false,
					attributed: false,
				})
			)
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
		const now = NOW;
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
		const now = NOW;
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

describe('getMicrosoftGateInput — attribution', () => {
	/**
	 * The setup that makes attribution load-bearing: an SNDS key covers a
	 * REGISTERED RANGE, so the table can hold days for a neighbouring sender. Ours
	 * is unbanded (the normal state early in a ramp); theirs is clean on two days.
	 */
	async function seedNeighbourEvidence(t: TestConvex<typeof schema>): Promise<void> {
		const now = NOW;
		const today = Math.floor(now / DAY_MS) * DAY_MS;
		await t.run(async (ctx) => {
			for (const [ip, band] of [
				['203.0.113.10', 'unknown'],
				['198.51.100.7', 'lt_0_1'],
			] as const) {
				for (const dayOffset of [1, 2]) {
					await ctx.db.insert('sndsIpDailyStats', {
						ip,
						periodStart: today - dayOffset * DAY_MS,
						complaintBand: band,
						filterResult: 'green',
						trapHits: 0,
						messageRecipients: 100,
						rcptCommands: 100,
						dataCommands: 100,
						fetchedAt: now,
						ingestedAt: now,
					});
				}
			}
		});
	}

	it('reads ONLY the declared pool, so a neighbour cannot supply our evidence', async () => {
		const t = convexTest(schema, modules);
		process.env['SNDS_DATA_FEED_URLS'] = 'https://snds.example.test/feed';
		process.env['MTA_IP_POOLS'] = '203.0.113.10';
		await seedNeighbourEvidence(t);

		const input = await t.query(internal.delivery.snds.getMicrosoftGateInput, { windowDays: 7 });
		expect(input.available).toBe(true);
		if (!input.available) return;
		// The neighbour's two clean days are not in the window at all.
		expect(input.signal.observedIps).toBe(1);
		expect(input.signal.worstComplaintBand).toBe('unknown');
		expect(input.signal.attributed).toBe(true);
		// Our own IP is simply unbanded, which HOLDS (D10) — it never promotes.
		expect(evaluateSndsGate(input).verdict).toBe('insufficient_data');
		expect(sndsPromotionPass(input)).toBe(false);
		// A pool-scoped read is bounded by the pool, not by the table.
		expect(input.signal.truncated).toBe(false);
	});

	it('marks an undeclared-pool read UNATTRIBUTED, so it can never promote', async () => {
		const t = convexTest(schema, modules);
		process.env['SNDS_DATA_FEED_URLS'] = 'https://snds.example.test/feed';
		await seedNeighbourEvidence(t);

		const input = await t.query(internal.delivery.snds.getMicrosoftGateInput, { windowDays: 7 });
		expect(input.available).toBe(true);
		if (!input.available) return;
		// Without a declared pool the rows ARE read — pass/fail keeps working and can
		// still slow the ramp — but nothing about them can be attributed to us.
		expect(input.signal.observedIps).toBe(2);
		expect(input.signal.attributed).toBe(false);
		expect(input.signal.confidence).toBe('low');
		expect(sndsPromotionPass(input)).toBe(false);
		// THE UP DIRECTION IS CLOSED. `pass` is the verdict `aggregateRampGates`
		// grows `cleanStreak` on, and D9 increases the share after K_CLEAN clean
		// windows — so a clean band that may belong to a neighbour in the same
		// registered range must not be able to buy an increase. `insufficient_data`
		// HOLDS: no increase, and no decrease either (D10).
		const verdict = evaluateSndsGate(input);
		expect(verdict.verdict).toBe('insufficient_data');
		// The reason still names the band AND says why it is not ours (D12/D14).
		expect(verdict.reason).toContain('registered range');
		expect(verdict.reason).toContain('MTA_IP_POOLS');
	});

	it('still FAILS on an unattributed breach — only the up direction is closed', async () => {
		const t = convexTest(schema, modules);
		process.env['SNDS_DATA_FEED_URLS'] = 'https://snds.example.test/feed';
		// No `MTA_IP_POOLS`: the window covers the whole registered range.
		const now = NOW;
		await t.run(async (ctx) => {
			await ctx.db.insert('sndsIpDailyStats', {
				ip: '198.51.100.7',
				periodStart: Math.floor(now / DAY_MS) * DAY_MS - DAY_MS,
				complaintBand: 'gte_0_9',
				filterResult: 'red',
				trapHits: 0,
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
		expect(input.signal.attributed).toBe(false);
		// Evidence we cannot attribute is still enough to SLOW the ramp: a red
		// filter result inside our own registered range is our problem to answer.
		const verdict = evaluateSndsGate(input);
		expect(verdict.verdict).toBe('fail');
		if (verdict.verdict !== 'fail') return;
		expect(verdict.gate).toBe('complaint');
		expect(verdict.failedSignal).toBe('filter_result');
		expect(verdict.reason).toContain('registered range');
	});

	it('still fails on a breach recorded against a declared address', async () => {
		const t = convexTest(schema, modules);
		process.env['SNDS_DATA_FEED_URLS'] = 'https://snds.example.test/feed';
		process.env['MTA_IP_POOLS'] = '203.0.113.10, 198.51.100.7';
		const now = NOW;
		await t.run(async (ctx) => {
			await ctx.db.insert('sndsIpDailyStats', {
				ip: '198.51.100.7',
				periodStart: Math.floor(now / DAY_MS) * DAY_MS - DAY_MS,
				complaintBand: 'gte_0_9',
				filterResult: 'red',
				trapHits: 0,
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
		expect(input.signal.worstComplaintBand).toBe('gte_0_9');
		expect(evaluateSndsGate(input).verdict).toBe('fail');
	});
});
