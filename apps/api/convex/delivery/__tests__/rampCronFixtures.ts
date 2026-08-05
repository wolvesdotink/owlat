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

import {
	deliverabilityCellKey,
	type DestinationProviderKey,
} from '@owlat/shared/deliverabilityRouting';
import type { TestConvex } from 'convex-test';
import type { Doc } from '../../_generated/dataModel';
import type schema from '../../schema';
import { createTestInstanceSettings } from '../../__tests__/factories';
import { ZERO_TRANSPORT_OUTCOME_TOTALS } from '../../analytics/transportOutcomeSummary';
import { startOfDayUtc } from '../../lib/clock';
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
	 * Seed the pool and provider slices WITHOUT the managed per-stream row — the
	 * pre-enrolment state of every cell in every deployment (plan D1). The
	 * enrolment suite needs it, and hand-rolling it would be a fourth copy of the
	 * row triple this fixture exists to keep singular.
	 */
	readonly omitManagedCell?: boolean;
	/**
	 * How long ago the POOL row was last written. The shipped router stops acting
	 * on a route state it has not heard from within
	 * `DELIVERABILITY_SIGNAL_MAX_AGE_MS`, and the controller must agree with it.
	 */
	readonly poolAgeMs?: number;
	/** The clean streak stored on the managed cell's row. */
	readonly cleanStreak?: number;
	readonly phaseCeiling?: number;
	/**
	 * Seed the managed row with NO stored `phaseCeiling` at all. The column is
	 * `v.optional`, so absence is a representable state every guard that reads it
	 * has to answer for — and the fixture's default of 1 would hide it.
	 */
	readonly omitPhaseCeiling?: boolean;
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
	/**
	 * The GRADUATION CLOCK: when the cell last became continuously green. Fourteen
	 * days of it is what awards the pin, so a seeded value is how a suite says
	 * "this cell is most of the way to graduating".
	 */
	readonly greenSince?: number;
	/** The SECOND actuator's stored dial, degenerate values included. */
	readonly paceMultiplier?: number;
	readonly paceCleanStreak?: number;
	/** The pace dial's per-UTC-day idempotency anchor (`YYYY-MM-DD`). */
	readonly paceLastEvaluatedUtcDay?: string;
	/**
	 * A warming sync reading for the pace actuator's utilisation evidence.
	 * Omitted means NO warming state at all — the standalone deployment's normal
	 * starting point, and the reading the actuator must hold on (plan D10).
	 */
	readonly warming?: { readonly dailyCap: number; readonly sentToday: number };
	/**
	 * How long ago the warming sync last wrote. The utilisation reading has a
	 * MUCH tighter staleness bound than the capacity projection's, because
	 * `sentToday` / `dailyCap` reset at the UTC boundary and yesterday's counters
	 * describe a day that is over.
	 */
	readonly warmingAgeMs?: number;
	/** The composition interlock's anchor: when a pace increase was withheld. */
	readonly paceDeferredAt?: number;
	/** The operator's per-cell hold (P3-6), as `setCellPause` writes it. */
	readonly operatorPausedAt?: number;
	/** The operator's per-cell cap (P3-6), as `pinCellShare` writes it. */
	readonly operatorPinnedShare?: number;
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
		if (options.omitManagedCell !== true) {
			await ctx.db.insert('deliverabilityRouteStates', {
				...base,
				destinationProvider: 'gmail' as const,
				stream: 'campaign' as const,
				isFallbackActive: options.isFallbackActive ?? false,
				ownShare: options.ownShare ?? RAMP_FIXTURE_SHARE,
				...(options.omitPhaseCeiling === true ? {} : { phaseCeiling: options.phaseCeiling ?? 1 }),
				cleanStreak: options.cleanStreak ?? 3,
				mixVersion: options.mixVersion ?? 2,
				...(options.frozenUntil === undefined ? {} : { frozenUntil: options.frozenUntil }),
				...(options.freezeReason === undefined ? {} : { freezeReason: options.freezeReason }),
				...(options.cooldownMs === undefined ? {} : { cooldownMs: options.cooldownMs }),
				...(options.graduatedAt === undefined ? {} : { graduatedAt: options.graduatedAt }),
				...(options.greenSince === undefined ? {} : { greenSince: options.greenSince }),
				...(options.paceMultiplier === undefined ? {} : { paceMultiplier: options.paceMultiplier }),
				...(options.paceCleanStreak === undefined
					? {}
					: { paceCleanStreak: options.paceCleanStreak }),
				...(options.paceLastEvaluatedUtcDay === undefined
					? {}
					: { paceLastEvaluatedUtcDay: options.paceLastEvaluatedUtcDay }),
				...(options.paceDeferredAt === undefined ? {} : { paceDeferredAt: options.paceDeferredAt }),
				...(options.operatorPausedAt === undefined
					? {}
					: { operatorPausedAt: options.operatorPausedAt }),
				...(options.operatorPinnedShare === undefined
					? {}
					: { operatorPinnedShare: options.operatorPinnedShare }),
			});
		}
		if (options.warming !== undefined) {
			await ctx.db.insert('warmingState', {
				phase: 'ramp',
				totalDailyCap: options.warming.dailyCap,
				totalSentToday: options.warming.sentToday,
				ipCount: 1,
				ips: [
					{
						ip: '203.0.113.10',
						phase: 'ramp',
						currentDay: 1,
						dailyCap: options.warming.dailyCap,
						sentToday: options.warming.sentToday,
						bounceRate: 0,
						deferralRate: 0,
						pool: 'campaign',
						active: true,
					},
				],
				syncedAt: now - (options.warmingAgeMs ?? 0),
			});
		}
	});
}

/**
 * A CONFIGURED RELAY — the second sender, as the operator's doors read it.
 *
 * `configuredRelayKinds` answers off `providerRoutes` (plus the single-transport
 * `EMAIL_PROVIDER` env), and BOTH doors ask it: enrolment to choose the opening
 * share, the phase reset to decide whether a rung cuts one. A suite that means
 * to exercise a deployment with a relay has to say so with a row, and the two
 * suites that need it must not seed two different shapes of one.
 *
 * The default strategy is the SHIPPED one, deliberately. `adaptive_mix` is the
 * only strategy the router splits by the cell's share under, and nothing in
 * production selects it — so a relay connected on `priority_failover` is what a
 * real deployment looks like at the moment of enrolment.
 *
 * The relay KIND defaults to SES for the same reason: it is what every suite
 * written before a second relay kind existed meant. Arm attribution is
 * kind-agnostic by construction (`armForTransport` asks only whether the
 * transport is the own MTA), and the Mandrill migration fixtures name
 * `'mandrill'` here to say which relay the reference arm is.
 */
export async function connectRelay(
	t: Harness,
	strategy: 'priority_failover' | 'adaptive_mix' = 'priority_failover',
	relayKind = 'ses'
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('providerRoutes', {
			messageType: 'campaign' as const,
			strategy,
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: relayKind, isEnabled: true },
			],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

/**
 * TWO RELAY KINDS — campaign through SES, transactional through Resend.
 *
 * The configuration `referenceRelayTransportId` cannot name: there is a second
 * sender, and there is no SINGLE one to put in the screen's copy, so the
 * configuration reading says "none" while every cell is still measured against a
 * relay. A perfectly ordinary deployment, and the one the screen and the
 * controller used to grade with two different evaluators.
 */
export async function connectTwoRelays(t: Harness): Promise<void> {
	await connectRelay(t);
	await t.run(async (ctx) => {
		await ctx.db.insert('providerRoutes', {
			messageType: 'transactional' as const,
			strategy: 'priority_failover' as const,
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'resend', isEnabled: true },
			],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

/**
 * THE MANAGED CELL'S OUTCOME ROWS for one arm, in today's UTC bucket.
 *
 * WHY EVERY CRON SUITE NEEDS THIS NOW. The substitution table (P3-8) chooses the
 * evaluator from the presence map, and a cell's REFERENCE ARM is present exactly
 * when it has outcome rows: a fixture with none is a standalone deployment, and
 * the controller correctly runs the trailing-baseline twin over it. A suite that
 * means to exercise the reference-arm evaluator has to say so with data.
 *
 * Healthy by construction — everything sent was delivered — so seeding an arm
 * never fails a gate by accident; a suite that wants a breach names the counters.
 */
export async function seedArmOutcomes(
	t: Harness,
	args: {
		readonly organizationId: string;
		readonly arm: 'own' | 'reference';
		readonly sent: number;
		readonly stream?: 'campaign' | 'automation' | 'transactional';
		readonly destinationProvider?: DestinationProviderKey;
		readonly counters?: Partial<typeof ZERO_TRANSPORT_OUTCOME_TOTALS>;
		/** How long before now the bucket's day started. Default: today. */
		readonly dayOffset?: number;
	}
): Promise<void> {
	const now = Date.now();
	const periodStart = startOfDayUtc(now) - (args.dayOffset ?? 0) * MS_PER_DAY;
	const provider = args.destinationProvider ?? 'gmail';
	await t.run(async (ctx) => {
		await ctx.db.insert('transportOutcomes', {
			...ZERO_TRANSPORT_OUTCOME_TOTALS,
			organizationId: args.organizationId,
			cell: deliverabilityCellKey({
				stream: args.stream ?? 'campaign',
				destinationProvider: provider,
			}),
			arm: args.arm,
			periodStart,
			shardKey: 0,
			sent: args.sent,
			delivered: args.sent,
			...args.counters,
			lastRecordedAt: Math.min(now, periodStart + MS_PER_DAY - 1),
		});
	});
}

/**
 * A CELL WHOSE GATES ACTUALLY PASS — the only fixture from which the cron can be
 * observed taking an INCREASE.
 *
 * Every gate but the optional seed one has to be DECIDED for the aggregate to
 * read `pass`, and each is decided against a denominator: gate 1 and gate 3 are
 * ratios against the reference arm, gate 2 needs the deferral instrument to have
 * been observed at all, and gate 4 compares the CALIBRATION slice's engagement
 * between the arms. A fixture that sends clean traffic and records nothing else
 * holds on every one of them — which is correct, and is why "the cron never
 * increases anything" was true of every suite before this existed.
 *
 * So: both arms, over enough days to cover the 24h evaluation window and the
 * 7d/30d engagement windows, with the OWN arm exactly half the reference arm's
 * rates. Healthy by construction and green on every measured gate.
 */
export async function seedGreenWindows(
	t: Harness,
	args: { readonly organizationId: string; readonly sent?: number }
): Promise<void> {
	const sent = args.sent ?? 5_000;
	const counters = (factor: number) => ({
		delivered: sent - Math.round(sent * 0.01 * factor),
		hardBounced: Math.round(sent * 0.005 * factor),
		softBounced: Math.round(sent * 0.002 * factor),
		deferred: Math.round(sent * 0.01 * factor),
		complained: Math.round(sent * 0.0001 * factor),
		unsubscribed: Math.round(sent * 0.002 * factor),
		opened: Math.round(sent * 0.4),
		clicked: Math.round(sent * 0.05),
		// Gate 4 is measured on the RANDOM CALIBRATION SLICE only: the stratified
		// remainder gets worse as the share climbs, so it is not comparable.
		calibrationSent: Math.round(sent * 0.2),
		calibrationOpened: Math.round(sent * 0.08),
		calibrationClicked: Math.round(sent * 0.01),
	});
	for (const dayOffset of [0, 1, 2, 5, 10, 15, 20, 25]) {
		for (const arm of ['own', 'reference'] as const) {
			await seedArmOutcomes(t, {
				organizationId: args.organizationId,
				arm,
				sent,
				dayOffset,
				counters: counters(arm === 'own' ? 0.5 : 1),
			});
		}
	}
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
