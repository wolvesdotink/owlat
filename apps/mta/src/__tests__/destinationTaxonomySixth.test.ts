/**
 * P4.2 / D8 — the sixth provider, injected for real.
 *
 * `destinationTaxonomy.test.ts` proves every consumer agrees on the key for
 * every domain. It cannot prove the OTHER half of D8 — that a provider added to
 * the one declaration reaches every consumer — because a consumer that re-forked
 * its own five-key list still agrees with a five-key taxonomy. A test that loops
 * over the shared constant and asserts the consumer round-trips each entry stays
 * green through exactly the regression D8 exists to prevent.
 *
 * So this suite widens the declaration itself: `DESTINATION_PROVIDER_KEYS` is
 * mocked to carry a sixth key, and the consumers that ENUMERATE the taxonomy
 * have to surface it. Re-introduce a local `['gmail', …] as const` in either
 * consumer and this file goes red; nothing else in the repo does.
 *
 * Scope note: only the enumerating consumers are asserted here. `record`'s
 * classifier and `isDestinationProviderKey` read the constant through the
 * module's own binding, which a spread-based module mock cannot rebind, so the
 * cells are written directly onto the dimension — which is also the shipped
 * MX-derived write path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';

/**
 * Not a real mailbox provider — deliberately absent from the shipped taxonomy.
 * Hoisted so the mock factory, which vitest lifts above every other statement,
 * can name it.
 */
const { SIXTH } = vi.hoisted(() => ({ SIXTH: 'proton' }));

vi.mock('../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@owlat/shared/deliverabilityRouting', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@owlat/shared/deliverabilityRouting')>();
	return {
		...actual,
		DESTINATION_PROVIDER_KEYS: [...actual.DESTINATION_PROVIDER_KEYS, SIXTH],
	};
});

import { DESTINATION_PROVIDER_KEYS } from '@owlat/shared/deliverabilityRouting';
import { record } from '../monitoring/collector.js';
import { createIpReputationRoutes } from '../routes/ipReputation.js';
import {
	evaluateProviderWarmingDay,
	recordProviderWarmingSend,
} from '../intelligence/warmingProviderStore.js';
import { createTestConfig } from './helpers/fixtures.js';

const IP = '10.0.0.9';
const NOW = Date.UTC(2026, 7, 8, 12, 0, 0);
const UTC_DATE = '2026-08-08';
const DEFERS = 6;
/** The mock only pays for itself if the sixth key is genuinely new. */
const sixth = SIXTH as DestinationProviderKey;

let redis: RealRedis;

beforeEach(async () => {
	redis = new Redis() as unknown as RealRedis;
	await redis.flushall();
});

afterEach(() => {
	vi.useRealTimers();
});

it('is a widened taxonomy, not the shipped one', () => {
	expect(DESTINATION_PROVIDER_KEYS).toContain(SIXTH);
	expect(DESTINATION_PROVIDER_KEYS).toHaveLength(6);
});

describe('a provider added to the ONE declaration reaches every enumerating consumer', () => {
	it('ipReputation.ts — the snapshot surfaces the new cell', async () => {
		vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
		try {
			for (let i = 0; i < DEFERS; i += 1) {
				await record(redis, 'unused.test', IP, 'campaign', 'deferred', undefined, SIXTH);
			}
			const app = createIpReputationRoutes(
				redis,
				createTestConfig({
					apiKey: 'taxonomy-sixth-key',
					ipPools: { transactional: [], campaign: [] },
				})
			);
			const res = await app.request('/', {
				headers: { Authorization: 'Bearer taxonomy-sixth-key' },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				routing: { signals: Array<{ provider: string; source: string }> };
			};
			expect(
				body.routing.signals.filter((signal) => signal.source === 'persistent_defers')
			).toEqual([
				{ provider: SIXTH, source: 'persistent_defers', severity: 'warning', observedAt: NOW },
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('warmingProviderStore.ts — the new cell gets a warming dimension', async () => {
		await recordProviderWarmingSend(
			redis,
			{ ip: IP, provider: sixth, utcDate: UTC_DATE },
			'campaign'
		);
		const evaluations = await evaluateProviderWarmingDay(redis, IP, UTC_DATE);
		expect(evaluations.map((evaluation) => evaluation.provider)).toEqual([SIXTH]);
	});
});
