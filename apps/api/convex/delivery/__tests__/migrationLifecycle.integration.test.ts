/**
 * THE MIGRATION, END TO END — plan A3.
 *
 * A deployment arrives from Mailchimp Transactional, applies the guided flow's
 * preset (P4.2), and is carried by the shipped controller from "every send goes
 * through Mandrill" to "every send goes through our own MTA, and the relay is
 * standby". Nothing here is a unit: the preset is written through the real
 * mutations, the ramp is moved by the real cron, and every assertion is an
 * OBSERVABLE — a share, a decision sentence, an assignment row's transport —
 * rather than an internal.
 *
 * WHAT MAKES THE FIXTURE HONEST, and it is easy to get wrong: the Mandrill
 * sending domain must be VERIFIED. `adaptive_mix` with a
 * `deliverabilityFallback` naming an unverified relay refuses per
 * reference-arm recipient, and the assignment rows simply do not appear — a
 * fixture that skips the identity row proves the opposite of what it claims.
 *
 * THE NUMBERS BELOW ARE THE SHIPPED SCHEDULE, not invented ones. Under the
 * `conservative` preset the migration flow applies, a campaign cell steps
 * 2.5pp per counted 24h window after five clean ones, is bounded by the phase
 * rungs 0.25 -> 0.5 -> 0.8 -> 1, halves on a gate breach with a 6h freeze, and
 * pins after fourteen continuous green days at full share.
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Doc } from '../../_generated/dataModel';
import { modules } from '../../__tests__/testModules';
import { deliverabilityCellKey } from '@owlat/shared/deliverabilityRouting';
import { applyRampPreset } from '@owlat/shared/deliverabilityIndependence';
import { sendProviderCatalogEntry } from '../../lib/sendProviders/catalog';
import { recordSendAssignments } from '../sendAssignments';
import { syntheticContactIds } from '../../lib/sendProviders/strategies/__tests__/fixtures';
import { RAMP_AIMD, RAMP_PHASE_CEILINGS } from '../ramp/controllerConfig';
import { RAMP_STREAM_CONFIGS } from '../ramp/gateConfig';
import {
	connectRelay,
	readManagedCell,
	seedArmOutcomes,
	seedGreenWindows,
	seedRampCell,
	type Harness,
} from './rampCronFixtures';

const ORG = 'org_mandrill_migration';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Comfortably past the controller's 24h evaluation window. */
const WINDOW_STEP_MS = 25 * HOUR_MS;

const CELL = { stream: 'campaign', destinationProvider: 'gmail' } as const;
const CELL_KEY = deliverabilityCellKey(CELL);

/** The migration flow's pace (P4.2), as constants rather than as a guess. */
const CONSERVATIVE = applyRampPreset(
	{
		increaseStep: RAMP_STREAM_CONFIGS.campaign.increaseStep,
		cleanWindowsRequired: RAMP_STREAM_CONFIGS.campaign.cleanWindowsRequired,
	},
	'conservative'
);
/** 2.5 percentage points per counted window. */
const STEP = CONSERVATIVE.increaseStep / 100;
/** Five clean windows before the first step. */
const K_CLEAN = CONSERVATIVE.cleanWindowsRequired;

const FIRST_RUNG = RAMP_PHASE_CEILINGS[0];

vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/sessionOrganization')>();
	return {
		...actual,
		getSingletonOrganizationId: vi.fn().mockResolvedValue('org_mandrill_migration'),
		getUserIdFromSession: vi.fn().mockResolvedValue('user_admin'),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'user_admin', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'user_admin', role: 'owner' }),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'user_admin', role: 'owner' }),
		requireAdminContext: vi.fn().mockResolvedValue({ userId: 'user_admin', role: 'owner' }),
	};
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

// ── Fixture ────────────────────────────────────────────────────────

/** Both arms' credentials present, and the own MTA as the single-transport env. */
function stubTransportEnv(): void {
	vi.stubEnv('EMAIL_PROVIDER', 'mta');
	for (const kind of ['mta', 'mandrill'] as const) {
		for (const name of sendProviderCatalogEntry(kind).requiredEnvVars) {
			vi.stubEnv(name, name === 'MTA_API_URL' ? 'https://mta.test' : `test-${name.toLowerCase()}`);
		}
	}
}

/**
 * THE VERIFIED MANDRILL SENDING DOMAIN — the row without which every
 * reference-arm resolution throws and the whole fixture goes quiet.
 */
async function verifyRelayDomain(t: Harness): Promise<void> {
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('sendingDomainRelayIdentities', {
			organizationId: ORG,
			domain: 'example.test',
			providerKind: 'mandrill',
			status: 'verified' as const,
			spf: { isValid: true },
			dkim: { isValid: true },
			lastCheckedAt: now,
			nextCheckDueAt: now + DAY_MS,
			createdAt: now,
			updatedAt: now,
		});
	});
}

/** The `rampStreamPresets` row the flow's `setStreamPreset` call writes. */
async function chooseConservativePace(t: Harness): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('rampStreamPresets', {
			organizationId: ORG,
			stream: 'campaign' as const,
			preset: 'conservative' as const,
			updatedAt: Date.now(),
			updatedByUserId: 'user_admin',
		});
	});
}

interface MigrationOptions {
	readonly ownShare?: number;
	readonly cleanStreak?: number;
	readonly phaseCeiling?: number;
	readonly greenSince?: number;
}

/**
 * A deployment that has just finished the guided flow: Mandrill connected and
 * verified, all traffic on the relay, the conservative pace chosen.
 */
async function seedMigration(t: Harness, options: MigrationOptions = {}): Promise<void> {
	stubTransportEnv();
	await seedRampCell(t, {
		organizationId: ORG,
		ownShare: options.ownShare ?? 0,
		cleanStreak: options.cleanStreak ?? 0,
		phaseCeiling: options.phaseCeiling ?? FIRST_RUNG,
		greenSince: options.greenSince,
		mixVersion: 2,
	});
	await connectRelay(t, 'adaptive_mix', 'mandrill');
	await verifyRelayDomain(t);
	await chooseConservativePace(t);
	await seedGreenWindows(t, { organizationId: ORG });
}

async function runTick(t: Harness): Promise<void> {
	await t.mutation(internal.delivery.rampControllerCron.runRampController, {});
}

/** The tick's decision row for the managed cell — the newest one. */
async function lastDecision(t: Harness): Promise<Doc<'mixDecisions'> | undefined> {
	const rows = await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect());
	const forCell = rows
		.filter((row) => row.cell === CELL_KEY)
		.sort((left, right) => left.at - right.at);
	return forCell[forCell.length - 1];
}

async function share(t: Harness): Promise<number | undefined> {
	return (await readManagedCell(t))?.ownShare;
}

/**
 * One day of clean sending: the clock moves past the evaluation window, both
 * arms' healthy outcomes are refreshed, the route-state snapshot is renewed the
 * way its own cron renews it, and the controller decides.
 */
async function cleanDay(t: Harness): Promise<void> {
	vi.setSystemTime(Date.now() + WINDOW_STEP_MS);
	await seedGreenWindows(t, { organizationId: ORG });
	await refreshSnapshot(t);
	await runTick(t);
}

/** The snapshot writer's half of the tick, which the ramp cron does not do. */
async function refreshSnapshot(t: Harness): Promise<void> {
	await t.run(async (ctx) => {
		const now = Date.now();
		for (const row of await ctx.db.query('deliverabilityRouteStates').collect()) {
			await ctx.db.patch(row._id, {
				snapshotGeneratedAt: now,
				updatedAt: now,
				expiresAt: now + DAY_MS,
			});
		}
	});
}

/** One arm's totals, summed across shards and days. */
async function armTotals(
	t: Harness,
	arm: 'own' | 'reference'
): Promise<{ sent: number; complained: number }> {
	return await t.run(async (ctx) => {
		const rows = (await ctx.db.query('transportOutcomes').collect()).filter(
			(row) => row.cell === CELL_KEY && row.arm === arm
		);
		return {
			sent: rows.reduce((total, row) => total + row.sent, 0),
			complained: rows.reduce((total, row) => total + row.complained, 0),
		};
	});
}

/**
 * Where a campaign's recipients actually go, through the shipped writer.
 * `ownShare` 0 and 1 are exact by construction — they short-circuit before the
 * hash — so the degenerate ends of the migration are asserted, not sampled.
 */
async function assignCampaign(t: Harness, campaignId: string): Promise<Doc<'sendAssignments'>[]> {
	const recipients = syntheticContactIds(200, campaignId).map((contactId, index) => ({
		sendId: `${campaignId}-${index}`,
		email: `user${index}@gmail.com`,
		contactId,
	}));
	await t.run(async (ctx) => {
		await recordSendAssignments(ctx, {
			organizationId: ORG,
			stream: 'campaign',
			sendKind: 'campaign',
			campaignId,
			routing: { messageType: 'campaign', from: 'news@example.test' },
			recipients,
		});
	});
	return await t.run(async (ctx) => await ctx.db.query('sendAssignments').collect());
}

function harness(startAt = Date.UTC(2026, 7, 4, 9, 0, 0)): Harness {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(startAt);
	return convexTest(schema, modules);
}

// ── The preset ─────────────────────────────────────────────────────

/** The six writes the guided flow composes (P4.2), in its order. */
const MIGRATION_MESSAGE_TYPES = ['transactional', 'campaign', 'automation'] as const;

describe('the guided flow’s preset, through the real mutations', () => {
	it('is accepted for all three streams, and names Mandrill as the relay', async () => {
		const t = harness();
		stubTransportEnv();
		await verifyRelayDomain(t);

		for (const messageType of MIGRATION_MESSAGE_TYPES) {
			await t.mutation(api.providerRoutes.setRoute, {
				messageType,
				strategy: 'adaptive_mix',
				providers: [
					{ providerType: 'mta', isEnabled: true },
					{ providerType: 'mandrill', isEnabled: true },
				],
				deliverabilityFallback: {
					isEnabled: true,
					relayProviderType: 'mandrill',
					isWarmupOverflowEnabled: false,
				},
			});
			await t.mutation(api.delivery.rampControls.setStreamPreset, {
				stream: messageType,
				preset: 'conservative',
			});
		}

		const routes = await t.run(async (ctx) => await ctx.db.query('providerRoutes').collect());
		expect(routes).toHaveLength(3);
		for (const route of routes) {
			expect(route.strategy).toBe('adaptive_mix');
			expect(route.providers.map((provider) => provider.providerType).sort()).toEqual([
				'mandrill',
				'mta',
			]);
			expect(route.deliverabilityFallback?.relayProviderType).toBe('mandrill');
			// The controller owns the split during a migration, so overflow is off.
			expect(route.deliverabilityFallback?.isWarmupOverflowEnabled).toBe(false);
		}

		const presets = await t.run(async (ctx) => await ctx.db.query('rampStreamPresets').collect());
		expect(presets.map((row) => row.preset)).toEqual([
			'conservative',
			'conservative',
			'conservative',
		]);

		// Both mutations are permission-gated and audited; the pace change is the
		// one that leaves a row of its own.
		const audits = await t.run(async (ctx) => await ctx.db.query('auditLogs').collect());
		expect(
			audits.filter((row) => row.action === 'deliverability_ramp.preset_changed')
		).toHaveLength(3);
	});

	it('refuses the preset when the relay it names is not connected', async () => {
		const t = harness();
		vi.stubEnv('EMAIL_PROVIDER', 'mta');
		for (const name of sendProviderCatalogEntry('mta').requiredEnvVars) {
			vi.stubEnv(name, name === 'MTA_API_URL' ? 'https://mta.test' : `test-${name.toLowerCase()}`);
		}

		await expect(
			t.mutation(api.providerRoutes.setRoute, {
				messageType: 'campaign',
				strategy: 'adaptive_mix',
				providers: [
					{ providerType: 'mta', isEnabled: true },
					{ providerType: 'mandrill', isEnabled: true },
				],
				deliverabilityFallback: {
					isEnabled: true,
					relayProviderType: 'mandrill',
					isWarmupOverflowEnabled: false,
				},
			})
		).rejects.toThrow(/unavailable transport/);
	});
});

// ── Day 0 ──────────────────────────────────────────────────────────

describe('day 0 — everything still goes through Mandrill', () => {
	it('routes every recipient to the reference arm at ownShare 0', async () => {
		const t = harness();
		await seedMigration(t);

		const rows = await assignCampaign(t, 'cmp-day-0');

		expect(rows).toHaveLength(200);
		for (const row of rows) {
			expect(row.cell).toBe(CELL_KEY);
			expect(row.transport).toBe('mandrill');
			expect(row.arm).toBe('reference');
		}
	});

	it('holds while it builds confidence, without touching the share', async () => {
		const t = harness();
		await seedMigration(t);

		await runTick(t);

		expect(await share(t)).toBe(0);
		const decision = await lastDecision(t);
		expect(decision).toMatchObject({
			direction: 'hold',
			verdict: 'pass',
			reason: 'building_confidence',
			fromShare: 0,
			toShare: 0,
		});
	});
});

// ── The climb ──────────────────────────────────────────────────────

describe('the climb — clean windows buy 2.5pp each', () => {
	it('takes five clean windows before the first step, then steps every window', async () => {
		const t = harness();
		await seedMigration(t);

		// The seeded row starts with no clean streak at all, so the first windows
		// buy confidence rather than share: the streak has to REACH K_CLEAN, and
		// the window that takes it there is the one that pays for the first step.
		for (let window = 1; window < K_CLEAN; window += 1) {
			await cleanDay(t);
			expect(await share(t)).toBe(0);
		}
		expect((await lastDecision(t))?.reason).toBe('building_confidence');

		await cleanDay(t);
		expect(await share(t)).toBeCloseTo(STEP, 10);
		expect(await lastDecision(t)).toMatchObject({ direction: 'increase', verdict: 'pass' });

		await cleanDay(t);
		expect(await share(t)).toBeCloseTo(2 * STEP, 10);
	});

	it('will not step twice inside one evaluation window', async () => {
		const t = harness();
		await seedMigration(t, { cleanStreak: K_CLEAN });

		await cleanDay(t);
		const stepped = await share(t);
		expect(stepped).toBeCloseTo(STEP, 10);

		// Same day, second tick: the window is still open.
		await runTick(t);
		expect(await share(t)).toBe(stepped);
		expect((await lastDecision(t))?.reason).toBe('window_open');
	});

	it('stops at the first phase rung and says so', async () => {
		const t = harness();
		await seedMigration(t, { cleanStreak: K_CLEAN, ownShare: FIRST_RUNG - STEP });

		await cleanDay(t);
		expect(await share(t)).toBeCloseTo(FIRST_RUNG, 10);

		await cleanDay(t);
		// The rung is a ceiling, not a pause: the share holds and the reason names
		// the ladder, because only an operator promotion can cross it.
		expect(await share(t)).toBeCloseTo(FIRST_RUNG, 10);
		expect(await lastDecision(t)).toMatchObject({
			direction: 'hold',
			reason: 'phase_ceiling',
			toShare: FIRST_RUNG,
		});
	});
});

// ── The retreat ────────────────────────────────────────────────────

describe('a complaint burst on the own arm', () => {
	it('freezes and halves the own share, naming the gate, and leaves Mandrill alone', async () => {
		const t = harness();
		await seedMigration(t, { cleanStreak: K_CLEAN, ownShare: FIRST_RUNG });

		vi.setSystemTime(Date.now() + WINDOW_STEP_MS);
		await seedGreenWindows(t, { organizationId: ORG });
		await refreshSnapshot(t);
		const ownBefore = await armTotals(t, 'own');
		const referenceBefore = await armTotals(t, 'reference');
		// One percent of the own arm's day complains — ten times the ceiling —
		// while bounces and deferrals stay clean, so the gate that breaks is
		// unambiguous.
		await seedArmOutcomes(t, {
			organizationId: ORG,
			arm: 'own',
			sent: 20_000,
			counters: { delivered: 19_800, complained: 200 },
		});
		await runTick(t);

		const row = await readManagedCell(t);
		expect(row?.ownShare).toBeCloseTo(FIRST_RUNG * RAMP_AIMD.decreaseFactor, 10);
		expect(row?.freezeReason).toBe('gate_breach');
		expect(row?.frozenUntil).toBeGreaterThan(Date.now());
		expect(row?.cooldownMs).toBe(RAMP_AIMD.cooldownBaseMs);
		expect(row?.cleanStreak).toBe(0);

		expect(await lastDecision(t)).toMatchObject({
			direction: 'decrease',
			verdict: 'fail',
			reason: 'complaint',
			failedGate: 'complaint',
			fromShare: FIRST_RUNG,
		});

		// THE MEASUREMENT PLANE'S PROMISE: the own arm's trouble is the own arm's.
		// Every complaint in the burst is attributed to the arm that earned it, and
		// Mandrill's counters are exactly where they were.
		expect((await armTotals(t, 'own')).complained).toBe(ownBefore.complained + 200);
		expect(await armTotals(t, 'reference')).toEqual(referenceBefore);
	});

	it('holds where it is while the freeze is running', async () => {
		const t = harness();
		await seedMigration(t, { cleanStreak: K_CLEAN, ownShare: FIRST_RUNG });
		vi.setSystemTime(Date.now() + WINDOW_STEP_MS);
		await seedGreenWindows(t, { organizationId: ORG });
		await refreshSnapshot(t);
		await seedArmOutcomes(t, {
			organizationId: ORG,
			arm: 'own',
			sent: 20_000,
			counters: { delivered: 19_800, complained: 200 },
		});
		await runTick(t);
		const frozenAt = await share(t);

		// Well inside the six-hour cooldown, on a clean day.
		vi.setSystemTime(Date.now() + 2 * HOUR_MS);
		await seedGreenWindows(t, { organizationId: ORG });
		await refreshSnapshot(t);
		await runTick(t);

		expect(await share(t)).toBe(frozenAt);
		expect(await lastDecision(t)).toMatchObject({ direction: 'hold', reason: 'frozen' });
	});
});

// ── Recovery ───────────────────────────────────────────────────────

describe('recovery — the freeze expires and the climb resumes', () => {
	it('rebuilds the streak, then steps again', async () => {
		const t = harness();
		await seedMigration(t, {
			cleanStreak: 0,
			ownShare: FIRST_RUNG * RAMP_AIMD.decreaseFactor,
		});
		// A freeze already on the row, stamped an hour ago: the state a cell is in
		// the moment after a breach.
		await t.run(async (ctx) => {
			const rows = await ctx.db.query('deliverabilityRouteStates').collect();
			const managed = rows.find((row) => row.stream === 'campaign');
			if (managed === undefined) throw new Error('the fixture seeded no managed cell');
			await ctx.db.patch(managed._id, {
				frozenUntil: Date.now() + 5 * HOUR_MS,
				freezeStartedAt: Date.now() - HOUR_MS,
				freezeReason: 'gate_breach' as const,
				cooldownMs: RAMP_AIMD.cooldownBaseMs,
			});
		});

		// Past the freeze, on a clean day: the cell may act again, but the streak
		// the breach reset has to be earned back first.
		await cleanDay(t);
		expect((await lastDecision(t))?.reason).toBe('building_confidence');

		for (let window = 2; window < K_CLEAN; window += 1) await cleanDay(t);
		expect(await share(t)).toBeCloseTo(FIRST_RUNG * RAMP_AIMD.decreaseFactor, 10);

		await cleanDay(t);
		expect(await lastDecision(t)).toMatchObject({ direction: 'increase', verdict: 'pass' });
		expect(await share(t)).toBeCloseTo(FIRST_RUNG * RAMP_AIMD.decreaseFactor + STEP, 10);
	});
});

// ── The ladder ─────────────────────────────────────────────────────

describe('the phase ladder — the ceiling moves on evidence, never on a tick', () => {
	it('climbs the rungs, and asks for evidence above the halfway line', async () => {
		const t = harness();
		await seedMigration(t, { cleanStreak: K_CLEAN, ownShare: FIRST_RUNG });

		// The lower rung is the ordinary ladder.
		expect(await t.mutation(api.delivery.rampPhasePromotion.promoteCellPhase, CELL)).toEqual({
			applied: true,
			phaseCeiling: 0.5,
		});

		const refused = await t.mutation(api.delivery.rampPhasePromotion.promoteCellPhase, CELL);
		expect(refused).toMatchObject({
			applied: false,
			refusal: 'promotion_evidence_outstanding',
			phaseCeiling: 0.5,
		});
		expect(refused.outstanding ?? []).toContain('google_compliance_pass');

		// One Google Postmaster compliance pass inside the evidence window is a
		// whole route on its own, and it carries the cell to the top.
		await t.run(async (ctx) => {
			const now = Date.now();
			const domainId = await ctx.db.insert('domains', {
				domain: 'example.test',
				status: 'verified' as const,
				dnsRecords: {},
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert('googlePostmasterCompliance', {
				domainId,
				domain: 'example.test',
				periodStart: now - DAY_MS,
				checks: [{ name: 'spam_rate', state: 'passing' as const }],
				fetchedAt: now - HOUR_MS,
				ingestedAt: now - HOUR_MS,
			});
		});

		expect(await t.mutation(api.delivery.rampPhasePromotion.promoteCellPhase, CELL)).toEqual({
			applied: true,
			phaseCeiling: 0.8,
		});
		expect(await t.mutation(api.delivery.rampPhasePromotion.promoteCellPhase, CELL)).toEqual({
			applied: true,
			phaseCeiling: 1,
		});
		// A promotion moves the CEILING, never the share: every step is still paid
		// for with a clean window.
		expect(await share(t)).toBeCloseTo(FIRST_RUNG, 10);
	});
});

// ── Graduation ─────────────────────────────────────────────────────

describe('graduation — fourteen green days at full share', () => {
	it('starts the green clock at full share and pins the cell when it runs out', async () => {
		const t = harness();
		await seedMigration(t, {
			cleanStreak: K_CLEAN,
			ownShare: 1 - STEP,
			phaseCeiling: 1,
		});

		await cleanDay(t);
		const atFull = await readManagedCell(t);
		expect(atFull?.ownShare).toBe(1);
		// REACHING full share is not the start of the clock: the decision that
		// takes the share to 1 is still judged from the share it came FROM, so the
		// green clock starts on the first window the cell spends AT full share.
		expect(atFull?.greenSince).toBeUndefined();
		expect(atFull?.graduatedAt).toBeUndefined();

		await cleanDay(t);
		const clockStarted = await readManagedCell(t);
		expect(clockStarted?.greenSince).toBe(Date.now());
		expect(clockStarted?.graduatedAt).toBeUndefined();
		expect((await lastDecision(t))?.reason).toBe('phase_ceiling');

		vi.setSystemTime(Date.now() + RAMP_AIMD.graduationHoldMs + HOUR_MS);
		await seedGreenWindows(t, { organizationId: ORG });
		await refreshSnapshot(t);
		await runTick(t);

		const graduated = await readManagedCell(t);
		expect(graduated?.ownShare).toBe(1);
		expect(graduated?.graduatedAt).toBe(Date.now());
		expect(graduated?.isFallbackActive).toBe(false);
		expect(await lastDecision(t)).toMatchObject({
			direction: 'hold',
			reason: 'graduated',
			toShare: 1,
		});
	});
});

// ── After graduation ───────────────────────────────────────────────

describe('after graduation — the relay is standby', () => {
	it('sends every recipient through the own MTA, with Mandrill still configured', async () => {
		const t = harness();
		await seedMigration(t, {
			ownShare: 1,
			cleanStreak: 20,
			phaseCeiling: 1,
			greenSince: Date.now() - RAMP_AIMD.graduationHoldMs - HOUR_MS,
		});

		const rows = await assignCampaign(t, 'cmp-graduated');

		expect(rows).toHaveLength(200);
		for (const row of rows) {
			expect(row.transport).toBe('mta');
			expect(row.arm).toBe('own');
		}
		// The reference arm is idle, not gone: the route still names Mandrill, so
		// the deliverability fallback can still take over on a real signal.
		const route = await t.run(async (ctx) => await ctx.db.query('providerRoutes').first());
		expect(route?.providers.map((provider) => provider.providerType)).toContain('mandrill');
	});
});
