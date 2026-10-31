/**
 * What one warming sync writes from one `/ip-reputation` read: the warming
 * snapshot row and the MTA's routing snapshot onto the route states.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import betterAuthSchema from '../../betterAuth/schema';
import { components, internal } from '../../_generated/api';
import { modules } from './helpers/convexModules';

vi.mock('../../lib/runtimeLog', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	logError: vi.fn(),
	logWarn: vi.fn(),
}));

const betterAuthModules = import.meta.glob('../../betterAuth/**/*.*s');
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

const reputation = (routing?: unknown) => ({
	date: '2026-10-01',
	ips: [
		{
			ip: '203.0.113.10',
			sent: 10,
			bounced: 0,
			deferred: 0,
			warmingPhase: 'graduated',
			warmingDay: 30,
			pool: 'campaign',
			active: true,
		},
	],
	...(routing === undefined ? {} : { routing }),
});

const breakerOpen = (generatedAt: number) => ({
	generatedAt,
	signals: [
		{ provider: 'gmail', source: 'breaker_open', severity: 'critical', observedAt: generatedAt },
	],
});

const fetchMock = vi.fn();

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	vi.stubEnv('MTA_INTERNAL_URL', 'http://mta.test');
	vi.stubEnv('MTA_API_KEY', 'mta-key');
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function harness(): Promise<{ t: TestConvex<typeof schema>; organizationId: string }> {
	const t = convexTest(schema, modules);
	t.registerComponent('betterAuth', betterAuthSchema, betterAuthModules);
	const org = (await t.mutation(components.betterAuth.adapter.create, {
		input: { model: 'organization', data: { name: 'Owlat', slug: 'owlat', createdAt: NOW } },
	} as never)) as { _id: string };
	return { t, organizationId: org._id };
}

const warmingRows = (t: TestConvex<typeof schema>) =>
	t.run((ctx) => ctx.db.query('warmingState').collect());

const routeState = (t: TestConvex<typeof schema>, organizationId: string, provider: string) =>
	t.run((ctx) =>
		ctx.db
			.query('deliverabilityRouteStates')
			.withIndex('by_org_provider', (q) =>
				q.eq('organizationId', organizationId).eq('destinationProvider', provider as never)
			)
			.first()
	);

describe('syncWarmingState writes', () => {
	it('stores the warming snapshot and applies the routing snapshot', async () => {
		const { t, organizationId } = await harness();
		fetchMock.mockImplementation(async () => Response.json(reputation(breakerOpen(NOW - 1_000))));

		await t.action(internal.delivery.warmingSync.syncWarmingState, {});

		const [row, ...others] = await warmingRows(t);
		expect(others).toEqual([]);
		expect(row).toMatchObject({ phase: 'graduated', ipCount: 1, syncedAt: NOW });
		expect(row?.ips[0]).toMatchObject({ ip: '203.0.113.10', pool: 'campaign' });
		expect(await routeState(t, organizationId, 'gmail')).toMatchObject({
			isFallbackActive: true,
			snapshotGeneratedAt: NOW - 1_000,
			signals: [{ source: 'breaker_open' }],
		});
		expect(await routeState(t, organizationId, 'microsoft')).toMatchObject({
			isFallbackActive: false,
		});
	});

	it('stores the warming snapshot and leaves routing alone when the routing snapshot is stale', async () => {
		const { t, organizationId } = await harness();
		fetchMock.mockImplementation(async () =>
			Response.json(reputation(breakerOpen(NOW - 24 * 60 * 60_000)))
		);

		await t.action(internal.delivery.warmingSync.syncWarmingState, {});

		expect(await warmingRows(t)).toHaveLength(1);
		expect(await routeState(t, organizationId, 'gmail')).toBeNull();
	});

	it('replaces the stored snapshot on the next sync', async () => {
		const { t } = await harness();
		fetchMock.mockImplementation(async () => Response.json(reputation()));
		await t.action(internal.delivery.warmingSync.syncWarmingState, {});

		vi.setSystemTime(NOW + 5 * 60_000);
		await t.action(internal.delivery.warmingSync.syncWarmingState, {});

		const rows = await warmingRows(t);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.syncedAt).toBe(NOW + 5 * 60_000);
	});

	it('writes nothing when the MTA rejects the read', async () => {
		const { t, organizationId } = await harness();
		fetchMock.mockImplementation(async () => new Response('nope', { status: 503 }));

		await t.action(internal.delivery.warmingSync.syncWarmingState, {});

		expect(await warmingRows(t)).toEqual([]);
		expect(await routeState(t, organizationId, 'gmail')).toBeNull();
	});
});
