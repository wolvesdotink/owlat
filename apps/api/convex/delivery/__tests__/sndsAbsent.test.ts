/**
 * P4-1 (d): the D2 proof.
 *
 * SNDS enrollment is free, but it is still an account. A deployment that never
 * enrolled must send, poll and render exactly as cleanly as one that did — the
 * only difference being lower measurement confidence and a slower Microsoft
 * ramp. This suite asserts that literally on the INGEST side: no network call,
 * no write, no throw, no error state.
 *
 * The gate half of this proof went with the gate. `evaluateSndsGate` and
 * `snds.getMicrosoftGateInput` were a parallel route no controller ever
 * consumed, removed under D20 (issue #515); the substitution they described is
 * the `microsoft_snds` row of the degradation matrix, which the controller DOES
 * fold, and `ramp/__tests__/degradationMatrix.test.ts` asserts its D2 posture.
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { parseSndsFeedUrls } from '../sndsConfig';

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

		const summary = await t.action(internal.delivery.sndsPoll.poll, {});

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
		const again = await t.action(internal.delivery.sndsPoll.poll, {});
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
