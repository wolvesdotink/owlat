import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';

// The re-check runs from an MTA event and resolves the one organization itself.
vi.mock('../../lib/sessionOrganization', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getSingletonOrganizationId: vi.fn(async () => 'org-ip-readiness'),
}));

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

function warmingRow(ips: string[]) {
	return {
		phase: 'ramp',
		totalDailyCap: 50,
		totalSentToday: 0,
		ipCount: ips.length,
		ips: ips.map((ip) => ({
			ip,
			phase: 'ramp',
			currentDay: 1,
			dailyCap: 50,
			sentToday: 0,
			bounceRate: 0,
			deferralRate: 0,
			pool: 'campaign',
			active: true,
		})),
		syncedAt: 1,
	};
}

type TestBackend = ReturnType<typeof convexTest>;

const scheduledJobs = (t: TestBackend) =>
	t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect()).map((job) => ({
			name: job.name,
			args: job.args[0] as Record<string, unknown>,
		}))
	);

afterEach(() => {
	vi.unstubAllEnvs();
});

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

	it('re-runs the IPv6 checks a new regression is about, so it can raise their alert', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.delivery.ipReadinessAlerts.recordRegression, alert);
		expect(await scheduledJobs(t)).toEqual([
			{
				name: 'delivery/ipReadinessAlerts:recheckAfterRegression',
				args: { readinessCheck: 'spf' },
			},
		]);
	});

	it('runs the checks that read the regressed readiness on a deployment sending over IPv6', async () => {
		vi.stubEnv('EMAIL_PROVIDER', 'mta');
		const t = convexTest(schema, modules);
		await t.run((ctx) =>
			ctx.db.insert('warmingState', warmingRow(['203.0.113.25', '2001:db8::10']))
		);

		const spf = await t.mutation(internal.delivery.ipReadinessAlerts.scheduleRegressedChecks, {
			readinessCheck: 'spf',
		});
		const fcrdns = await t.mutation(internal.delivery.ipReadinessAlerts.scheduleRegressedChecks, {
			readinessCheck: 'fcrdns',
		});

		expect(spf.scheduled).toEqual(['deployment.ipv6_spf', 'deployment.ipv6_pool']);
		expect(fcrdns.scheduled).toEqual([
			'deployment.ipv6_ptr',
			'deployment.ipv6_aaaa',
			'deployment.ipv6_pool',
		]);
		expect(await scheduledJobs(t)).toContainEqual({
			name: 'delivery/checklistVerification:sweep',
			args: { organizationId: 'org-ip-readiness', itemId: 'deployment.ipv6_spf' },
		});
	});

	it('runs nothing when mail does not leave through the built-in server', async () => {
		vi.stubEnv('EMAIL_PROVIDER', 'ses');
		const t = convexTest(schema, modules);
		await t.run((ctx) => ctx.db.insert('warmingState', warmingRow(['2001:db8::10'])));
		const result = await t.mutation(internal.delivery.ipReadinessAlerts.scheduleRegressedChecks, {
			readinessCheck: 'spf',
		});
		expect(result.scheduled).toEqual([]);
		expect(await scheduledJobs(t)).toEqual([]);
	});

	it('runs nothing while IPv6 is off', async () => {
		vi.stubEnv('EMAIL_PROVIDER', 'mta');
		const t = convexTest(schema, modules);
		await t.run((ctx) => ctx.db.insert('warmingState', warmingRow(['203.0.113.25'])));
		const result = await t.mutation(internal.delivery.ipReadinessAlerts.scheduleRegressedChecks, {
			readinessCheck: 'fcrdns',
		});
		expect(result.scheduled).toEqual([]);
	});
});
