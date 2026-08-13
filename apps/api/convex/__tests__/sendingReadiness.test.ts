/**
 * SENDING READINESS — the ramp cap, read BEFORE the send rather than discovered
 * as a pre-flight refusal.
 *
 * The contract these tests hold: the readiness readout is derived from the SAME
 * paced projection and the SAME warming-cap verdict as the binding gate
 * (`campaigns/capacityPreflight.ts`), so the number quoted beside the send
 * button can never contradict the answer the send itself gets — and every
 * measurement fault answers "no cap to quote" rather than a number nobody can
 * stand behind (deliverability plan D2/D14).
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import { createTestDomain } from './factories';
import {
	configureSesEnv,
	DAY_MS,
	MIDNIGHT,
	seedCampaignRoute,
	seedVerifiedRelayIdentity,
	seedWarmingState,
	useMtaPreflightEnv,
} from './preflightFixtures';
import { summarizeProjectedCapacity } from '../campaigns/sendingReadiness';

vi.mock('../lib/sessionOrganization', async () => {
	const { sessionOrganizationMock } = await import('./sessionOrganizationMock');
	return await sessionOrganizationMock();
});

const modules = import.meta.glob('../**/*.*s');

useMtaPreflightEnv();

const FROM = 'sender@verified.example.com';

describe('getSendingReadiness — what can go out today', () => {
	it('quotes today and the day the cap next grows', async () => {
		const t = convexTest(schema, modules);
		// A day-1 IP with its 50-message cap untouched: 50 today, 100 tomorrow.
		await seedWarmingState(t, { totalSentToday: 0 });

		const readiness = await t.query(api.campaigns.sendingReadiness.getSendingReadiness, {
			fromEmail: FROM,
		});

		expect(readiness).toEqual({
			capped: true,
			today: 50,
			growsTo: 100,
			growsAt: MIDNIGHT + DAY_MS,
		});
	});

	it('reports a spent day as zero — with the growth that ends it', async () => {
		const t = convexTest(schema, modules);
		// The fixture default: the whole day-1 cap is already sent.
		await seedWarmingState(t);

		const readiness = await t.query(api.campaigns.sendingReadiness.getSendingReadiness, {
			fromEmail: FROM,
		});

		expect(readiness).toEqual({
			capped: true,
			today: 0,
			growsTo: 100,
			growsAt: MIDNIGHT + DAY_MS,
		});
	});

	it('quotes nothing when there is no warming state to measure', async () => {
		const t = convexTest(schema, modules);

		const readiness = await t.query(api.campaigns.sendingReadiness.getSendingReadiness, {
			fromEmail: FROM,
		});

		// Missing data never becomes "you can send to about 0 contacts today".
		expect(readiness).toEqual({ capped: false, reason: 'no_projection' });
	});

	it('answers without a From address, conservatively', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t, { totalSentToday: 0 });

		// The getting-started checklist has no sender to offer. Without one the
		// warm-up-overflow proof is unavailable, so the cap is quoted — which
		// under-promises rather than over-promises.
		const readiness = await t.query(api.campaigns.sendingReadiness.getSendingReadiness, {});

		expect(readiness).toMatchObject({ capped: true, today: 50 });
	});
});

describe('getSendingReadiness — no cap to quote', () => {
	it('quotes no cap when warm-up overflow to a VERIFIED relay absorbs the tail', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t, { totalSentToday: 0 });
		await t.run(async (ctx) => {
			await ctx.db.insert('domains', createTestDomain({ domain: 'verified.example.com' }));
		});
		configureSesEnv();
		await seedVerifiedRelayIdentity(t, 'verified.example.com');
		await seedCampaignRoute(t, {
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'ses', isEnabled: true },
			],
			deliverabilityFallback: {
				isEnabled: true,
				relayProviderType: 'ses',
				isWarmupOverflowEnabled: true,
			},
		});

		const readiness = await t.query(api.campaigns.sendingReadiness.getSendingReadiness, {
			fromEmail: FROM,
		});

		// The SAME verdict the binding gate reaches — a cap that does not bind must
		// not be advertised as a limit on this send.
		expect(readiness).toEqual({ capped: false, reason: 'warmup_overflow_absorbs' });
	});

	it('quotes no cap when campaigns do not dispatch through the own MTA', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t, { totalSentToday: 0 });
		configureSesEnv();
		await seedCampaignRoute(t, {
			strategy: 'workload_split',
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'ses', isEnabled: true },
			],
		});

		const readiness = await t.query(api.campaigns.sendingReadiness.getSendingReadiness, {
			fromEmail: FROM,
		});

		expect(readiness).toEqual({ capped: false, reason: 'not_own_mta' });
	});
});

describe('summarizeProjectedCapacity — the growth walk', () => {
	it('names the first day that carries more than what is left today', () => {
		// Today is nearly spent, so the growth is tomorrow; a plateau after that
		// is not a second announcement.
		expect(
			summarizeProjectedCapacity({ remainingToday: 10, byDay: [10, 200, 200] }, MIDNIGHT)
		).toEqual({ capped: true, today: 10, growsTo: 200, growsAt: MIDNIGHT + DAY_MS });
	});

	it('skips days that do not beat today, and reports the one that does', () => {
		expect(
			summarizeProjectedCapacity({ remainingToday: 300, byDay: [300, 100, 200, 700] }, MIDNIGHT)
		).toEqual({ capped: true, today: 300, growsTo: 700, growsAt: MIDNIGHT + 3 * DAY_MS });
	});

	it('promises no growth a plateaued projection does not have', () => {
		expect(
			summarizeProjectedCapacity({ remainingToday: 700, byDay: [700, 700, 700] }, MIDNIGHT)
		).toEqual({ capped: true, today: 700, growsTo: null, growsAt: null });
	});

	it('floors hostile numbers to zero rather than rendering NaN at a send button', () => {
		expect(
			summarizeProjectedCapacity({ remainingToday: Number.NaN, byDay: [Number.NaN, -5] }, MIDNIGHT)
		).toEqual({ capped: true, today: 0, growsTo: null, growsAt: null });
	});
});
