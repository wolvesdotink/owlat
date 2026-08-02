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
	type DeliverabilitySignalSource,
	type DeliverabilityStream,
	type DestinationProviderKey,
} from '@owlat/shared/deliverabilityRouting';
import { DELIVERABILITY_SIGNAL_MAX_AGE_MS } from '../../../delivery/deliverabilityRouting';
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
		deliverabilityFallback?: {
			isEnabled: boolean;
			relayProviderType: string;
			isWarmupOverflowEnabled: boolean;
		};
	}
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('providerRoutes', {
			messageType: 'campaign',
			strategy: config.strategy,
			providers: config.providers,
			...(config.deliverabilityFallback
				? { deliverabilityFallback: config.deliverabilityFallback }
				: {}),
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
 *
 * `signals` defaults to none. A row with no signals can never carry a routing
 * REASON however degraded its share reads, so a fixture that means "the shipped
 * router is relaying this cell" has to write one.
 */
async function seedRouteState(
	t: Harness,
	row: {
		destinationProvider: DeliverabilitySignalProvider;
		stream?: DeliverabilityStream;
		ownShare?: number;
		isFallbackActive?: boolean;
		signals?: Array<{
			source: DeliverabilitySignalSource;
			severity: 'warning' | 'critical';
		}>;
		updatedAt?: number;
	}
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('deliverabilityRouteStates', {
			organizationId: 'org_warming_cap',
			destinationProvider: row.destinationProvider,
			...(row.stream === undefined ? {} : { stream: row.stream }),
			...(row.ownShare === undefined ? {} : { ownShare: row.ownShare }),
			isFallbackActive: row.isFallbackActive ?? false,
			signals: (row.signals ?? []).map((signal) => ({
				...signal,
				observedAt: row.updatedAt ?? NOW,
			})),
			snapshotGeneratedAt: row.updatedAt ?? NOW,
			expiresAt: NOW + 86_400_000,
			updatedAt: row.updatedAt ?? NOW,
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

/**
 * THE FLOOR HAS TO ANSWER FOR WHAT THE ROUTER ACTUALLY DOES, not for what the
 * controller wrote.
 *
 * `resolveOwnShare` reads `perStream ?? streamless`, so a cell whose controller
 * row says 0.9 answers 0.9 even while the MTA snapshot's row for that cell
 * carries a fresh `dnsbl_listed`. The dispatch path does not split that cell 90
 * / 10: `cellRoute` hands the signal to `resolveRoute` as an active reason and
 * one active reason overrides the strategy outright, so with the escape hatch on
 * every recipient of the cell goes to the relay. A floor of 0.9 there
 * OVER-counts own-arm volume — and the floor is what licenses the refusal, so
 * the error lands as a multi-day refusal quoted to a campaign that dispatches to
 * SES. That is the false blocker D2 forbids, in the one configuration this
 * branch exists for: a ramped cell carrying a live infrastructure signal.
 */
describe('adaptive_mix — a relayed cell contributes nothing to the floor', () => {
	/** The escape hatch armed, with warm-up overflow off so the cap still binds. */
	const HATCH_ON: Parameters<typeof seedRoute>[1] = {
		...MIXED_ROUTE,
		deliverabilityFallback: {
			isEnabled: true,
			relayProviderType: 'ses',
			isWarmupOverflowEnabled: false,
		},
	};

	/**
	 * Every cell ramped to 0.9, and gmail's SNAPSHOT row carrying a real critical
	 * blocklist listing — the shape the reviewer's case names: a controller share
	 * beside an infrastructure verdict the controller has not seen yet.
	 */
	async function seedRampedGmailListing(
		t: Harness,
		overrides: {
			signals?: Array<{ source: DeliverabilitySignalSource; severity: 'warning' | 'critical' }>;
			updatedAt?: number;
		} = {}
	): Promise<void> {
		await seedEveryCellShare(t, 0.9);
		await seedRouteState(t, {
			destinationProvider: 'gmail',
			isFallbackActive: true,
			signals: overrides.signals ?? [{ source: 'dnsbl_listed', severity: 'critical' }],
			...(overrides.updatedAt === undefined ? {} : { updatedAt: overrides.updatedAt }),
		});
	}

	it('zeroes the floor for a cell the escape hatch relays whole', async () => {
		const t = convexTest(schema, modules);
		configureSesEnv();
		await seedRoute(t, HATCH_ON);
		await seedRampedGmailListing(t);

		// At most 90% of any audience meets the cap, and — since an all-gmail
		// audience meets none of it — at least none of it does.
		expect(await verdictFor(t)).toEqual({ binds: true, ownArmShare: { floor: 0, peak: 0.9 } });
	});

	/**
	 * WITHOUT THE HATCH THE REASON IS INERT. `resolveRoute` returns the
	 * strategy's own selection when `deliverabilityFallback` is off, so the
	 * controller's share really is the whole answer and zeroing the floor would
	 * throw away a refusal this deployment can still make.
	 */
	it('keeps the stored share when the escape hatch is off', async () => {
		const t = convexTest(schema, modules);
		configureSesEnv();
		await seedRoute(t, MIXED_ROUTE);
		await seedRampedGmailListing(t);

		expect(await verdictFor(t)).toEqual({ binds: true, ownArmShare: { floor: 0.9, peak: 0.9 } });
	});

	it('ignores a signal too old to be a routing reason', async () => {
		const t = convexTest(schema, modules);
		configureSesEnv();
		await seedRoute(t, HATCH_ON);
		// The dispatch path drops a stale row's reasons, so the cell dispatches on
		// its stored share again and the floor has to follow it back up.
		await seedRampedGmailListing(t, { updatedAt: NOW - DELIVERABILITY_SIGNAL_MAX_AGE_MS - 1 });

		expect(await verdictFor(t)).toEqual({ binds: true, ownArmShare: { floor: 0.9, peak: 0.9 } });
	});

	/**
	 * An ADVISORY reading ("the blocklist lookup did not complete") is recorded
	 * for measurement and never relays a cell. Reading "any signal" instead of the
	 * actionable set would surrender the refusal on a deployment whose resolver is
	 * merely rate-limited.
	 */
	it('ignores an advisory reading, which relays nothing', async () => {
		const t = convexTest(schema, modules);
		configureSesEnv();
		await seedRoute(t, HATCH_ON);
		await seedRampedGmailListing(t, {
			signals: [{ source: 'dnsbl_unknown', severity: 'warning' }],
		});

		expect(await verdictFor(t)).toEqual({ binds: true, ownArmShare: { floor: 0.9, peak: 0.9 } });
	});

	/**
	 * The pool-wide `'all'` row is not a cell, but a fresh breaker on it DEFERS
	 * every cell rather than relaying it: `cellRoute` short-circuits the whole
	 * resolver to null before `resolveRoute` is reached. A deferred message is not
	 * own-arm volume either, so no cell has a positive guaranteed share.
	 */
	async function seedFreshPoolWideBreaker(t: Harness): Promise<void> {
		await seedEveryCellShare(t, 0.9);
		await seedRouteState(t, {
			destinationProvider: 'all',
			isFallbackActive: true,
			signals: [{ source: 'breaker_open', severity: 'critical' }],
		});
	}

	it('zeroes every cell’s floor on a fresh pool-wide breaker', async () => {
		const t = convexTest(schema, modules);
		configureSesEnv();
		await seedRoute(t, HATCH_ON);
		await seedFreshPoolWideBreaker(t);

		expect(await verdictFor(t)).toEqual({ binds: true, ownArmShare: { floor: 0, peak: 0.9 } });
	});

	/**
	 * AND WITH THE HATCH OFF TOO, unlike every per-cell reason above. The circuit
	 * is read BEFORE `deliverabilityFallback` on both dispatch paths — `cellRoute`
	 * returns the null resolver, `resolveRoute` throws
	 * `GlobalDeliveryCircuitOpenError` on its first line — and `applySnapshot`
	 * writes the `'all'` row whatever the hatch says. Keeping the stored 0.9 here
	 * would license a multi-day refusal against a campaign that ships the moment
	 * the transient circuit closes: the same false blocker the per-cell correction
	 * removes.
	 */
	it('zeroes the floor on a pool-wide breaker with the escape hatch OFF', async () => {
		const t = convexTest(schema, modules);
		configureSesEnv();
		await seedRoute(t, MIXED_ROUTE);
		await seedFreshPoolWideBreaker(t);

		expect(await verdictFor(t)).toEqual({ binds: true, ownArmShare: { floor: 0, peak: 0.9 } });
	});

	/**
	 * A STALE breaker defers nothing: the dispatch path drops the row past
	 * `DELIVERABILITY_SIGNAL_MAX_AGE_MS`, so the stream dispatches on its stored
	 * shares again and the refusal this deployment can still make comes back.
	 */
	it('keeps the stored shares when the pool-wide breaker is stale', async () => {
		const t = convexTest(schema, modules);
		configureSesEnv();
		await seedRoute(t, MIXED_ROUTE);
		await seedEveryCellShare(t, 0.9);
		await seedRouteState(t, {
			destinationProvider: 'all',
			isFallbackActive: true,
			signals: [{ source: 'breaker_open', severity: 'critical' }],
			updatedAt: NOW - DELIVERABILITY_SIGNAL_MAX_AGE_MS - 1,
		});

		expect(await verdictFor(t)).toEqual({ binds: true, ownArmShare: { floor: 0.9, peak: 0.9 } });
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
