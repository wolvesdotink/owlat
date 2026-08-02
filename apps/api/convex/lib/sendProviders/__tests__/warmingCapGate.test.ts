/**
 * THE BINDING VERDICT UNDER `adaptive_mix` — the strategy that SPLITS one
 * audience across both arms.
 *
 * The gate answers for a whole campaign, so it has no recipient, so
 * `adaptiveMixStrategy` has no mix context to decide from and returns null: the
 * resolver then falls through to the `EMAIL_PROVIDER` env default, and a verdict
 * read off that base route is a verdict read off an env var that has nothing to
 * do with where this campaign's recipients go. Both directions of that mistake
 * are real damage — a mixed campaign whose own-arm tail silently expires
 * (`EMAIL_PROVIDER=ses`), and a multi-day refusal quoted to a campaign that is
 * 95% relayed (`EMAIL_PROVIDER=mta`) — so every case here pins the verdict
 * against the MIX and proves the env var is not what decided it.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestConvex } from 'convex-test';
import schema from '../../../schema';
import { modules } from '../../../__tests__/testModules';
import {
	DESTINATION_PROVIDER_KEYS,
	type DeliverabilitySignalProvider,
	type DeliverabilityStream,
	type DestinationProviderKey,
} from '@owlat/shared/deliverabilityRouting';
import { campaignWarmingCapBinds, type WarmingCapVerdict } from '../warmingCapGate';

const singletonOrg = vi.hoisted(() => ({
	/**
	 * The tenant the seeded route states belong to. `null` makes the lookup throw
	 * the REAL "no organization configured" error — a `forbidden` ConvexError,
	 * which is the only throw the gate is allowed to read as "no tenant".
	 */
	id: 'org_warming_cap' as string | null,
	/** A lookup failure that is NOT "no organization": a component read that broke. */
	failure: null as Error | null,
}));

vi.mock('../../sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../sessionOrganization')>();
	const { ConvexError } = await import('convex/values');
	return {
		...actual,
		getSingletonOrganizationId: vi.fn(async () => {
			if (singletonOrg.failure !== null) throw singletonOrg.failure;
			if (singletonOrg.id === null) {
				throw new ConvexError({
					category: 'forbidden',
					message: 'No organization configured on this Owlat instance',
				});
			}
			return singletonOrg.id;
		}),
	};
});

type Harness = TestConvex<typeof schema>;

const NOW = Date.UTC(2026, 6, 27, 12, 0, 0);
const FROM = 'sender@warming.example.com';

beforeEach(() => {
	singletonOrg.id = 'org_warming_cap';
	singletonOrg.failure = null;
	process.env['EMAIL_PROVIDER'] = 'mta';
	process.env['MTA_API_URL'] = 'http://mta:3100';
	process.env['MTA_API_KEY'] = 'test-key';
});

afterEach(() => {
	for (const key of [
		'EMAIL_PROVIDER',
		'MTA_API_URL',
		'MTA_API_KEY',
		'AWS_SES_REGION',
		'AWS_SES_ACCESS_KEY_ID',
		'AWS_SES_SECRET_ACCESS_KEY',
	]) {
		delete process.env[key];
	}
});

/** Credentials, so an enabled SES route entry is a READY one. */
function configureSesEnv(): void {
	process.env['AWS_SES_REGION'] = 'us-east-1';
	process.env['AWS_SES_ACCESS_KEY_ID'] = 'test-access-key-id';
	process.env['AWS_SES_SECRET_ACCESS_KEY'] = 'test-secret-access-key';
}

async function seedRoute(
	t: Harness,
	config: {
		strategy: 'single' | 'priority_failover' | 'workload_split' | 'adaptive_mix';
		providers: Array<{ providerType: string; isEnabled: boolean }>;
	}
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('providerRoutes', {
			messageType: 'campaign',
			strategy: config.strategy,
			providers: config.providers,
			createdAt: NOW,
			updatedAt: NOW,
		});
	});
}

/**
 * One `deliverabilityRouteStates` row. A `stream` is the ramp controller's
 * per-stream row (the one that carries a share); omitting it writes the MTA
 * snapshot's stream-less row, whose `isFallbackActive` is the legacy share
 * expression. `destinationProvider: 'all'` is the pool-wide infrastructure
 * slice, which is not a ramp cell at all.
 */
async function seedRouteState(
	t: Harness,
	row: {
		destinationProvider: DeliverabilitySignalProvider;
		stream?: DeliverabilityStream;
		ownShare?: number;
		isFallbackActive?: boolean;
	}
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('deliverabilityRouteStates', {
			organizationId: 'org_warming_cap',
			destinationProvider: row.destinationProvider,
			...(row.stream === undefined ? {} : { stream: row.stream }),
			...(row.ownShare === undefined ? {} : { ownShare: row.ownShare }),
			isFallbackActive: row.isFallbackActive ?? false,
			signals: [],
			snapshotGeneratedAt: NOW,
			expiresAt: NOW + 86_400_000,
			updatedAt: NOW,
		});
	});
}

/**
 * Every campaign cell of the stream at one share, except the cells named in
 * `perCell`. Exactly one row per cell, so a heterogeneous mix is expressed by
 * the row that is written rather than by which of two rows for the same cell
 * the scan happens to return last.
 */
async function seedEveryCellShare(
	t: Harness,
	ownShare: number,
	perCell: Partial<Record<DestinationProviderKey, number>> = {}
): Promise<void> {
	for (const destinationProvider of DESTINATION_PROVIDER_KEYS) {
		await seedRouteState(t, {
			destinationProvider,
			stream: 'campaign',
			ownShare: perCell[destinationProvider] ?? ownShare,
		});
	}
}

async function verdictFor(t: Harness): Promise<WarmingCapVerdict> {
	return await t.run(
		async (ctx) => await campaignWarmingCapBinds(ctx, { fromEmail: FROM, now: NOW })
	);
}

/** Both arms enabled: the configuration the mix is actually expressed over. */
const MIXED_ROUTE: Parameters<typeof seedRoute>[1] = {
	strategy: 'adaptive_mix',
	providers: [
		{ providerType: 'mta', isEnabled: true },
		{ providerType: 'ses', isEnabled: true },
	],
};

describe('adaptive_mix — the verdict comes from the MIX, not from EMAIL_PROVIDER', () => {
	it('binds on the whole audience when no cell has a controller share yet', async () => {
		const t = convexTest(schema, modules);
		configureSesEnv();
		// The env default names the RELAY, which is exactly the reading that used
		// to turn this gate off for a deployment sending everything on its own MTA.
		process.env['EMAIL_PROVIDER'] = 'ses';
		await seedRoute(t, MIXED_ROUTE);

		expect(await verdictFor(t)).toEqual({ binds: true, ownArmShare: { floor: 1, peak: 1 } });
	});

	it('carries BOTH bounds when the controller has split the cells unevenly', async () => {
		const t = convexTest(schema, modules);
		configureSesEnv();
		process.env['EMAIL_PROVIDER'] = 'ses';
		await seedRoute(t, MIXED_ROUTE);
		// Neither number answers for the audience on its own: one of unknown
		// composition puts at least 25% and at most 60% of itself on the own MTA,
		// and the caller needs both — the floor to refuse with, the peak to
		// approve with.
		await seedEveryCellShare(t, 0.6, { gmail: 0.25 });

		expect(await verdictFor(t)).toEqual({
			binds: true,
			ownArmShare: { floor: 0.25, peak: 0.6 },
		});
	});

	it('reads the per-stream share over the stream-less row for the same cell', async () => {
		const t = convexTest(schema, modules);
		configureSesEnv();
		await seedRoute(t, MIXED_ROUTE);
		await seedEveryCellShare(t, 0.4);
		// The MTA snapshot says the relay is engaged for gmail; the controller's
		// own row is the share, and `perStream ?? streamless` must prefer it.
		await seedRouteState(t, { destinationProvider: 'gmail', isFallbackActive: true });

		expect(await verdictFor(t)).toEqual({ binds: true, ownArmShare: { floor: 0.4, peak: 0.4 } });
	});

	/**
	 * ONE STREAM'S CELLS, AND NOTHING ELSE. The controller writes a row per
	 * (stream, provider), so the same provider carries a transactional share and a
	 * campaign share at once — reading the wrong one answers the campaign verdict
	 * off transactional mail's ramp. The pool-wide `'all'` slice is infrastructure
	 * rather than a cell and must not enter the extremes either.
	 */
	it('ignores another stream’s controller row and the pool-wide slice', async () => {
		const t = convexTest(schema, modules);
		configureSesEnv();
		await seedRoute(t, MIXED_ROUTE);
		await seedEveryCellShare(t, 0.4);
		// Transactional mail is much further up its ramp than campaign mail, and
		// the infrastructure slice says the relay is engaged pool-wide.
		await seedRouteState(t, {
			destinationProvider: 'gmail',
			stream: 'transactional',
			ownShare: 0.9,
		});
		await seedRouteState(t, { destinationProvider: 'all', isFallbackActive: true });

		expect(await verdictFor(t)).toEqual({ binds: true, ownArmShare: { floor: 0.4, peak: 0.4 } });
	});

	it('does not bind when NO cell dispatches on the own MTA', async () => {
		const t = convexTest(schema, modules);
		configureSesEnv();
		await seedRoute(t, MIXED_ROUTE);
		await seedEveryCellShare(t, 0);

		expect(await verdictFor(t)).toEqual({ binds: false, why: 'not_own_mta' });
	});

	it('binds with a ZERO FLOOR when one cell is fully relayed beside un-migrated ones', async () => {
		const t = convexTest(schema, modules);
		configureSesEnv();
		await seedRoute(t, MIXED_ROUTE);
		// One cell fully on the relay, the rest un-migrated. How much of THIS
		// audience meets the cap depends on a composition nobody has counted, so
		// the floor says nothing (a lower bound of zero refuses nothing) while the
		// peak still says "at most all of it" — which is what lets the caller tell
		// a campaign that provably fits from one it cannot measure.
		await seedRouteState(t, { destinationProvider: 'gmail', stream: 'campaign', ownShare: 0 });

		expect(await verdictFor(t)).toEqual({ binds: true, ownArmShare: { floor: 0, peak: 1 } });
	});

	it('binds on the WHOLE audience when no reference transport is configured', async () => {
		const t = convexTest(schema, modules);
		// Deliberately no SES credentials: the entry is enabled but not ready, so
		// the strategy's additive-only rule puts every recipient — reference-arm
		// decisions included — on the own MTA whatever the stored share says.
		await seedRoute(t, MIXED_ROUTE);
		await seedEveryCellShare(t, 0.1);

		expect(await verdictFor(t)).toEqual({ binds: true, ownArmShare: { floor: 1, peak: 1 } });
	});

	it('does not bind when the own MTA is not an enabled+ready entry at all', async () => {
		const t = convexTest(schema, modules);
		configureSesEnv();
		await seedRoute(t, {
			strategy: 'adaptive_mix',
			providers: [
				{ providerType: 'ses', isEnabled: true },
				{ providerType: 'mta', isEnabled: false },
			],
		});
		await seedEveryCellShare(t, 1);

		expect(await verdictFor(t)).toEqual({ binds: false, why: 'not_own_mta' });
	});
});

describe('adaptive_mix — where the env fallback genuinely governs', () => {
	it('falls back to the env default when the strategy has nothing to select among', async () => {
		const t = convexTest(schema, modules);
		// One enabled but uncredentialed SES entry: `resolveRoute` never reaches
		// the strategy, so `EMAIL_PROVIDER` really is what carries the campaign.
		await seedRoute(t, {
			strategy: 'adaptive_mix',
			providers: [{ providerType: 'ses', isEnabled: true }],
		});
		await seedEveryCellShare(t, 0);

		expect(await verdictFor(t)).toEqual({ binds: true, ownArmShare: { floor: 1, peak: 1 } });
	});

	it('falls back to the env default when the deployment has NO organization', async () => {
		const t = convexTest(schema, modules);
		configureSesEnv();
		await seedRoute(t, MIXED_ROUTE);
		await seedEveryCellShare(t, 0);
		// No tenant means no mix context on the dispatch path either, so the same
		// env fallback carries the send and the gate must agree with it.
		singletonOrg.id = null;

		expect(await verdictFor(t)).toEqual({ binds: true, ownArmShare: { floor: 1, peak: 1 } });
	});

	/**
	 * A BROKEN TENANT READ IS NOT AN UNCONFIGURED DEPLOYMENT. Reading it as one
	 * hands the whole campaign verdict to `EMAIL_PROVIDER` — the reading this
	 * module exists to remove — and does it silently, on a deployment whose cells
	 * say something else entirely. It propagates instead; the pre-flight's
	 * fail-open turns it into `measurement_failed` (capacity unmeasured, send
	 * allowed), which is the same outcome said out loud.
	 */
	it('does not read a failed tenant lookup as "no tenant"', async () => {
		const t = convexTest(schema, modules);
		configureSesEnv();
		await seedRoute(t, MIXED_ROUTE);
		await seedEveryCellShare(t, 0);
		singletonOrg.failure = new Error('component read failed');

		await expect(verdictFor(t)).rejects.toThrow('component read failed');
	});
});

describe('the shipped strategies still answer over the whole audience', () => {
	it('ignores the controller shares under priority_failover', async () => {
		const t = convexTest(schema, modules);
		await seedRoute(t, {
			strategy: 'priority_failover',
			providers: [{ providerType: 'mta', isEnabled: true }],
		});
		// A stored share steers nothing while the org runs a shipped strategy.
		await seedEveryCellShare(t, 0.2);

		expect(await verdictFor(t)).toEqual({ binds: true, ownArmShare: { floor: 1, peak: 1 } });
	});

	it('still reads workload_split off the enabled+ready kind set', async () => {
		const t = convexTest(schema, modules);
		configureSesEnv();
		await seedRoute(t, { ...MIXED_ROUTE, strategy: 'workload_split' });
		await seedEveryCellShare(t, 1);

		expect(await verdictFor(t)).toEqual({ binds: false, why: 'not_own_mta' });
	});
});
