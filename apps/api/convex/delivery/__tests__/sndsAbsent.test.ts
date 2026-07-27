/**
 * P4-1 (d): the D2 proof.
 *
 * SNDS enrollment is free, but it is still an account. A deployment that never
 * enrolled must send, poll, evaluate and render exactly as cleanly as one that
 * did — the only difference being lower measurement confidence and a slower
 * Microsoft ramp. This suite asserts that literally: no network call, no
 * write, no throw, no error state, and the documented substitution in force.
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { parseSndsFeedUrls } from '../snds';
import { evaluateSndsGate, sndsPromotionPass, SNDS_ABSENT_SUBSTITUTION } from '../sndsGate';

import { modules } from './helpers/convexModules';

afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env['SNDS_DATA_FEED_URLS'];
});

describe('SNDS absent — the poller', () => {
	it('returns early: no fetch, no write, no throw', async () => {
		const t = convexTest(schema, modules);
		const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		const summary = await t.action(internal.delivery.snds.poll, {});

		// The invariant is "nothing happened", NOT an exhaustive summary shape:
		// asserting every key would make adding a diagnostic counter break the D2
		// proof, which is exactly the wrong thing for this test to be sensitive to.
		expect(summary).toMatchObject({ enrolled: false, feeds: 0, observations: 0, ingested: 0 });
		expect(summary.enrolled).toBe(false);
		expect(summary.ingested).toBe(0);
		// Not "a failed feed" — no feed was ever contacted.
		expect(summary.feedsFailed).toBe(0);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await t.run(async (ctx) => ctx.db.query('sndsIpDailyStats').collect())).toEqual([]);
		// Polling again reports the same zeros: the not-enrolled summary is a fresh
		// copy each time, so nothing a caller does to one poll's result can carry
		// into the next through the module-level constant.
		const again = await t.action(internal.delivery.snds.poll, {});
		expect(again).toEqual(summary);
	});

	it('treats an empty, blank or malformed configuration as not enrolled', () => {
		for (const raw of [undefined, '', '   ', ',,,', 'not-a-url', 'http://insecure.example/feed']) {
			expect(parseSndsFeedUrls(raw), String(raw)).toEqual([]);
		}
	});

	it('retains its 90-day sweep as a no-op when nothing was ever stored', async () => {
		const t = convexTest(schema, modules);
		await expect(t.mutation(internal.delivery.snds.cleanup, {})).resolves.toEqual({
			deleted: 0,
			continuationScheduled: false,
		});
	});
});

describe('SNDS absent — the gate', () => {
	it('reports the documented substitution rather than an error', async () => {
		const t = convexTest(schema, modules);
		const input = await t.query(internal.delivery.snds.getMicrosoftGateInput, {});

		expect(input.available).toBe(false);
		if (input.available) return;
		expect(input.reason).toBe('not_enrolled');
		// SMTP reply classification, dwell x2, ceiling one phase lower.
		expect(input.substitution).toEqual({
			signalSource: 'smtp_classification',
			dwellMultiplier: 2,
			ceilingPhaseDelta: -1,
			confidence: 'low',
		});
		expect(input.substitution).toEqual(SNDS_ABSENT_SUBSTITUTION);
	});

	it('HOLDS the ramp instead of breaching it, and says so in plain language', async () => {
		const t = convexTest(schema, modules);
		const input = await t.query(internal.delivery.snds.getMicrosoftGateInput, {});
		const verdict = evaluateSndsGate(input);

		expect(verdict.verdict).toBe('insufficient_data');
		if (verdict.verdict !== 'insufficient_data') return;
		expect(verdict.substitution).toEqual(SNDS_ABSENT_SUBSTITUTION);
		// The reason is an explanation, never a nag: no error, no failure, no
		// "setup incomplete", no instruction that the operator MUST do anything.
		expect(verdict.reason).toMatch(/SMTP reply classification/);
		expect(verdict.reason).not.toMatch(/error|failed|invalid|incomplete|required|must/i);
		// Absence never promotes — and, just as importantly, never demotes.
		expect(sndsPromotionPass(input)).toBe(false);
	});

	it('an enrolled deployment with no data yet takes the SAME substitution path', async () => {
		const t = convexTest(schema, modules);
		process.env['SNDS_DATA_FEED_URLS'] = 'https://snds.example.test/feed';
		const input = await t.query(internal.delivery.snds.getMicrosoftGateInput, {});

		expect(input.available).toBe(false);
		if (input.available) return;
		expect(input.reason).toBe('no_data');
		expect(input.substitution).toEqual(SNDS_ABSENT_SUBSTITUTION);
		expect(evaluateSndsGate(input).verdict).toBe('insufficient_data');
	});
});
