/**
 * THE ONE CRON-LEVEL FIXTURE for the ramp controller.
 *
 * Every suite that drives `runRampController` needs the same three rows, and
 * they are not interchangeable: the POOL row (`provider: 'all'`) is where the
 * MTA files pool-wide blocklist and quarantine verdicts, the stream-less
 * PROVIDER row is the snapshot's own slice, and the MANAGED per-stream row is
 * the only one the controller writes. Two suites hand-rolling that shape had
 * already drifted apart in their seed signatures; a widening of
 * `deliverabilityRouteStates` would have left one of them behind.
 *
 * The org id is a parameter rather than a constant here because each suite
 * mocks `getSingletonOrganizationId` with its own tenant.
 */

import type { TestConvex } from 'convex-test';
import type { Doc } from '../../_generated/dataModel';
import type schema from '../../schema';
import { createTestInstanceSettings } from '../../__tests__/factories';
import { MS_PER_DAY } from '../../lib/constants';

/** The default share on the managed cell when a suite does not name one. */
export const RAMP_FIXTURE_SHARE = 0.5;

/**
 * The convex-test runner PARAMETERIZED by this app's schema — DEFINED ONCE for
 * every ramp fixture and suite. The unbound `ReturnType<typeof convexTest>`
 * hands `t.run` a database handle with no schema behind it, so a document read
 * back out of it has no fields and `.withIndex(...)` stops typechecking.
 */
export type Harness = TestConvex<typeof schema>;

/**
 * DERIVED FROM THE SCHEMA, never hand-copied: a new member of
 * `DELIVERABILITY_SIGNAL_SOURCES` must not be able to leave this fixture behind.
 */
export type RampFixtureSignal = Doc<'deliverabilityRouteStates'>['signals'][number];

export interface SeedRampCellOptions {
	/** The tenant every seeded row belongs to; must match the suite's org mock. */
	readonly organizationId: string;
	/** Signals on the POOL row (`provider: 'all'`) — where the MTA files them. */
	readonly poolSignals?: readonly RampFixtureSignal[];
	/** Signals on the cell's own provider slice. */
	readonly providerSignals?: readonly RampFixtureSignal[];
	readonly abuseStatus?: 'clean' | 'suspended';
	/** The global controller kill switch, as stored on `instanceSettings`. */
	readonly isPaused?: boolean;
	/** The share stored on the managed cell's row, degenerate values included. */
	readonly ownShare?: number;
	/**
	 * How long ago the POOL row was last written. The shipped router stops acting
	 * on a route state it has not heard from within
	 * `DELIVERABILITY_SIGNAL_MAX_AGE_MS`, and the controller must agree with it.
	 */
	readonly poolAgeMs?: number;
	/** The clean streak stored on the managed cell's row. */
	readonly cleanStreak?: number;
	readonly phaseCeiling?: number;
	readonly mixVersion?: number;
	/** The derived boolean view of the share (plan D1). */
	readonly isFallbackActive?: boolean;
	/** A freeze expiry already on the row — expired instants included. */
	readonly frozenUntil?: number;
	/** Which rung stamped that expiry. Absent models a row frozen before it was recorded. */
	readonly freezeReason?: 'gate_breach' | 'breaker' | 'dnsbl';
	/** The cooldown ladder rung already on the row. */
	readonly cooldownMs?: number;
	/** The graduation pin already on the row — the cell has PINNED at full share. */
	readonly graduatedAt?: number;
}

/** Seeds instance settings plus the pool / provider / managed row triple. */
export async function seedRampCell(t: Harness, options: SeedRampCellOptions): Promise<void> {
	const now = Date.now();
	const base = {
		organizationId: options.organizationId,
		isFallbackActive: false,
		signals: [],
		snapshotGeneratedAt: now,
		expiresAt: now + MS_PER_DAY,
		updatedAt: now,
	};
	await t.run(async (ctx) => {
		await ctx.db.insert(
			'instanceSettings',
			createTestInstanceSettings({
				abuseStatus: options.abuseStatus ?? 'clean',
				isRampControllerPaused: options.isPaused ?? false,
			})
		);
		// The pool-wide slice the MTA writes its blocklist verdicts to.
		await ctx.db.insert('deliverabilityRouteStates', {
			...base,
			destinationProvider: 'all' as const,
			updatedAt: now - (options.poolAgeMs ?? 0),
			signals: [...(options.poolSignals ?? [])],
		});
		// The provider slice (stream-less: the snapshot's own row).
		await ctx.db.insert('deliverabilityRouteStates', {
			...base,
			destinationProvider: 'gmail' as const,
			signals: [...(options.providerSignals ?? [])],
		});
		// The MANAGED cell: the controller's own per-stream row.
		await ctx.db.insert('deliverabilityRouteStates', {
			...base,
			destinationProvider: 'gmail' as const,
			stream: 'campaign' as const,
			isFallbackActive: options.isFallbackActive ?? false,
			ownShare: options.ownShare ?? RAMP_FIXTURE_SHARE,
			phaseCeiling: options.phaseCeiling ?? 1,
			cleanStreak: options.cleanStreak ?? 3,
			mixVersion: options.mixVersion ?? 2,
			...(options.frozenUntil === undefined ? {} : { frozenUntil: options.frozenUntil }),
			...(options.freezeReason === undefined ? {} : { freezeReason: options.freezeReason }),
			...(options.cooldownMs === undefined ? {} : { cooldownMs: options.cooldownMs }),
			...(options.graduatedAt === undefined ? {} : { graduatedAt: options.graduatedAt }),
		});
	});
}

/**
 * The managed cell as it stands now. A whole-table read rather than an index
 * scan: the harness ctx is untyped for named indexes, and the table holds three
 * rows in this fixture.
 */
export async function readManagedCell(
	t: Harness
): Promise<Doc<'deliverabilityRouteStates'> | undefined> {
	const rows = await t.run(
		async (ctx) => await ctx.db.query('deliverabilityRouteStates').collect()
	);
	return rows.find((row) => row.stream === 'campaign');
}
