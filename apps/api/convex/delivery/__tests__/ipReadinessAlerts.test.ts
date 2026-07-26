import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
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

const alert = {
	eventId: 'ipv6-readiness-v1:spf:2001:db8::10:7',
	ip: '2001:db8::10',
	readinessCheck: 'spf' as const,
	readinessReason: 'missing-ip6-mechanism',
	eligibilityGeneration: 7,
	observedAt: 1_700_000_000_000,
	message: 'IPv6 SPF regressed',
};

describe('MTA IP-readiness alerts', () => {
	it('persists racing/replayed event IDs exactly once and rejects collisions', async () => {
		const t = convexTest(schema, modules);
		const [first, replay] = await Promise.all([
			t.mutation(internal.delivery.ipReadinessAlerts.recordRegression, alert),
			t.mutation(internal.delivery.ipReadinessAlerts.recordRegression, alert),
		]);
		expect([first.duplicate, replay.duplicate].sort()).toEqual([false, true]);
		expect(await t.run(async (ctx) => ctx.db.query('mtaIpReadinessAlerts').collect())).toHaveLength(
			1
		);

		await expect(
			t.mutation(internal.delivery.ipReadinessAlerts.recordRegression, {
				...alert,
				message: 'different content',
			})
		).rejects.toThrow(/event-id collision/);
	});

	it('deletes expired incidents through the bounded retention mutation', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.delivery.ipReadinessAlerts.recordRegression, {
			...alert,
			observedAt: 1,
		});
		await t.mutation(internal.delivery.ipReadinessAlerts.cleanupExpired, {});
		expect(await t.run(async (ctx) => ctx.db.query('mtaIpReadinessAlerts').collect())).toEqual([]);
	});
});
