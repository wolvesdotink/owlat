/**
 * Advisory DNSBL signals are recorded, never routed on.
 *
 * "We could not measure this address" and "part of the pool is ejected" must
 * reach the state row so the ramp controller and the dashboard can read them,
 * while relay failover keeps triggering only on the shipped actionable sources.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';

const rootGlob = import.meta.glob('../../**/*.*s');
const deliveryGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, module]) => [
		path.replace(/^\.\.\//, '../../delivery/'),
		module,
	])
);
const modules = { ...rootGlob, ...deliveryGlob };

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return { ...actual, getSingletonOrganizationId: vi.fn().mockResolvedValue('org-a') };
});

async function stateFor(t: TestConvex<typeof schema>, destinationProvider: 'all' | 'gmail') {
	return await t.run(async (ctx) =>
		ctx.db
			.query('deliverabilityRouteStates')
			.withIndex('by_org_provider', (q) =>
				q.eq('organizationId', 'org-a').eq('destinationProvider', destinationProvider)
			)
			.first()
	);
}

describe('advisory deliverability signals', () => {
	it.each(['dnsbl_unknown', 'dnsbl_partial'] as const)(
		'records %s without activating the relay fallback',
		async (source) => {
			const t = convexTest(schema, modules);
			await t.mutation(internal.delivery.deliverabilityRouting.applySnapshot, {
				organizationId: 'org-a',
				generatedAt: 1,
				appliedAt: 1,
				signals: [
					{
						provider: 'all',
						source,
						severity: source === 'dnsbl_partial' ? 'critical' : 'warning',
						observedAt: 1,
					},
				],
			});

			expect(await stateFor(t, 'all')).toMatchObject({
				isFallbackActive: false,
				signals: [{ source }],
			});
		}
	);

	it('keeps the actionable trigger and refreshes advisory readings during hysteresis', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.delivery.deliverabilityRouting.applySnapshot, {
			organizationId: 'org-a',
			generatedAt: 1,
			appliedAt: 1,
			signals: [{ provider: 'gmail', source: 'dnsbl_listed', severity: 'critical', observedAt: 1 }],
		});
		expect(await stateFor(t, 'gmail')).toMatchObject({
			isFallbackActive: true,
			signals: [{ source: 'dnsbl_listed' }],
		});

		// An advisory-only snapshot must not end the fallback early, and must not
		// erase the reason that started it.
		await t.mutation(internal.delivery.deliverabilityRouting.applySnapshot, {
			organizationId: 'org-a',
			generatedAt: 2,
			appliedAt: 2 * 60 * 1000,
			signals: [{ provider: 'gmail', source: 'dnsbl_unknown', severity: 'warning', observedAt: 2 }],
		});
		const held = await stateFor(t, 'gmail');
		expect(held).toMatchObject({ isFallbackActive: true });
		expect(held?.signals.map((signal) => signal.source).sort()).toEqual([
			'dnsbl_listed',
			'dnsbl_unknown',
		]);

		// Once the hysteresis window elapses on advisory-only snapshots, failback
		// happens exactly as it does today and the advisory reading survives.
		await t.mutation(internal.delivery.deliverabilityRouting.applySnapshot, {
			organizationId: 'org-a',
			generatedAt: 3,
			appliedAt: 40 * 60 * 1000,
			signals: [{ provider: 'gmail', source: 'dnsbl_unknown', severity: 'warning', observedAt: 3 }],
		});
		expect(await stateFor(t, 'gmail')).toMatchObject({
			isFallbackActive: false,
			signals: [{ source: 'dnsbl_unknown' }],
		});
	});
});
