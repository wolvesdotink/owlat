/**
 * ENROLMENT — the one door onto the ramp (plan D1, D3, D14).
 *
 * Before this mutation exists nothing in production ever writes an `ownShare`:
 * the MTA snapshot writes stream-less rows, the controller skips a cell without
 * a stored share, and every control refuses an unmanaged cell rather than
 * creating one. So the properties worth pinning here are the ones that decide
 * whether the ramp can be USED at all, and whether using it is safe:
 *
 *   - the opening share is the SETUP FORK's answer, not a constant: the stream's
 *     `initialShareFraction` with a relay to ramp against, and full share with
 *     none (there is no second sender to hold traffic back for);
 *   - the rung and its DWELL ANCHOR are stamped together, because dwell is one of
 *     the four conditions on the only promotion route a yahoo/apple/other cell
 *     has — and the rung is the ladder's FIRST one on BOTH paths, because a rung
 *     is earned and the actuator is not a property of the enrolment;
 *   - it writes the D12 audit pair, so the first entry in a cell's timeline says
 *     who put it on the ramp and at what share;
 *   - an already-managed cell is refused rather than reset, and an enrolment that
 *     would RAISE today's effective share meets the same hard stops a
 *     force-advance does. A cut toward the relay never does.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import { modules } from '../../__tests__/testModules';
import { RAMP_STREAM_CONFIGS } from '../ramp/gateConfig';
import { RAMP_INITIAL_PHASE_CEILING } from '../ramp/controllerConfig';
import { resolveRampDegradation } from '../ramp/degradation';
import {
	loadRampDeploymentPresence,
	loadReferenceArmPresence,
	withReferenceArm,
} from '../rampIntegrationPresence';
import { readManagedCell, seedArmOutcomes, seedRampCell, type Harness } from './rampCronFixtures';

const ORG = 'org_ramp_enrollment';
const OTHER_ORG = 'org_ramp_enrollment_other';

const session = vi.hoisted(() => ({ organizationId: 'org_ramp_enrollment', isAdmin: true }));

// Same shape the sibling controls suite uses: the mutation resolves its tenant
// through the shared singleton-org helper (which talks to the auth component the
// harness does not have), and the ADMIN FLOOR is real rather than stubbed away —
// flipping `session.isAdmin` exercises the gate the card's claim rests on.
vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/sessionOrganization')>();
	return {
		...actual,
		getSingletonOrganizationId: vi.fn(async () => session.organizationId),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'user_admin', role: 'owner' }),
		requireAdminContext: vi.fn(async () => {
			if (!session.isAdmin) throw new Error('Admin access required');
			return { userId: 'user_admin', role: 'owner' };
		}),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'user_admin', role: 'owner' }),
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'user_admin', role: 'owner' }),
	};
});

const CELL = { stream: 'campaign', destinationProvider: 'gmail' } as const;

function harness(): Harness {
	session.organizationId = ORG;
	session.isAdmin = true;
	return convexTest(schema, modules);
}

/**
 * A configured relay: the ESP path's precondition, read from `providerRoutes`.
 *
 * The default strategy is the SHIPPED one, deliberately. `adaptive_mix` is the
 * only strategy the router splits by the cell's share under, and nothing in
 * production selects it — so a relay connected on `priority_failover` is what a
 * real deployment looks like at the moment of enrolment.
 */
async function connectRelay(
	t: Harness,
	strategy: 'priority_failover' | 'adaptive_mix' = 'priority_failover'
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('providerRoutes', {
			messageType: 'campaign' as const,
			strategy,
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'ses', isEnabled: true },
			],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

/**
 * Put the PROVIDER SLICE in relay fallback. Today's effective share for an
 * unmanaged cell is `resolveOwnShare` over that row, so this is what makes an
 * enrolment an INCREASE (0 -> the opening share) rather than a cut.
 */
async function holdProviderSliceInFallback(t: Harness): Promise<void> {
	await t.run(async (ctx) => {
		const rows = await ctx.db.query('deliverabilityRouteStates').collect();
		const streamless = rows.find(
			(row) => row.stream === undefined && row.destinationProvider === 'gmail'
		);
		if (streamless !== undefined) await ctx.db.patch(streamless._id, { isFallbackActive: true });
	});
}

/**
 * WHICH ACTUATOR THE CONTROLLER MEASURES for this cell — through the same
 * readers the tick and the promotion path use, so the divergence this asserts is
 * the real one and not a second fold's opinion of it.
 */
async function measuredActuator(t: Harness): Promise<'share' | 'pace'> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const presence = withReferenceArm(
			await loadRampDeploymentPresence(ctx, { organizationId: ORG, now }),
			await loadReferenceArmPresence(ctx, { organizationId: ORG, cell: CELL, now })
		);
		return resolveRampDegradation({ presence, provider: CELL.destinationProvider }).actuator;
	});
}

async function auditActions(t: Harness): Promise<string[]> {
	const rows = await t.run(async (ctx) => await ctx.db.query('auditLogs').collect());
	return rows.map((row) => row.action);
}

async function decisions(t: Harness) {
	return await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect());
}

async function routeStates(t: Harness) {
	return await t.run(async (ctx) => await ctx.db.query('deliverabilityRouteStates').collect());
}

describe('the ESP path', () => {
	it('opens the cell at its stream’s initial share and stamps the first rung', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, omitManagedCell: true });
		await connectRelay(t);

		const result = await t.mutation(api.delivery.rampEnrollment.enrollCell, CELL);
		expect(result).toMatchObject({
			enrolled: true,
			path: 'esp_relay',
			share: RAMP_STREAM_CONFIGS.campaign.initialShareFraction,
		});

		const row = await readManagedCell(t);
		expect(row?.ownShare).toBe(RAMP_STREAM_CONFIGS.campaign.initialShareFraction);
		// The derived boolean view stays consistent with the share (plan D1): at 2%
		// the relay carries the rest, so the fallback IS active.
		expect(row?.isFallbackActive).toBe(true);
		expect(row?.phaseCeiling).toBe(RAMP_INITIAL_PHASE_CEILING);
		// THE DWELL ANCHOR ARRIVES WITH THE RUNG. Without it the standalone
		// promotion route reports `unknown` for ever on a provider with no external
		// route, and the cell could never be promoted by anyone.
		expect(row?.phaseCeilingSince).toBeGreaterThan(0);
		expect(row?.cleanStreak).toBe(0);
		// Enrolment IS a mix generation: the cell's recipients are assigned to two
		// arms for the first time (plan D7).
		expect(row?.mixVersion).toBe(1);
		expect(row?.graduatedAt).toBeUndefined();
	});

	it('opens transactional at zero — the stream that ramps last', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, omitManagedCell: true });
		await connectRelay(t);

		const result = await t.mutation(api.delivery.rampEnrollment.enrollCell, {
			stream: 'transactional' as const,
			destinationProvider: 'gmail' as const,
		});
		expect(result.share).toBe(0);
		const rows = await routeStates(t);
		expect(rows.find((row) => row.stream === 'transactional')?.ownShare).toBe(0);
	});
});

describe('the own-server path', () => {
	it('opens at full share when there is no relay, on the ladder’s FIRST rung', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, omitManagedCell: true });

		const result = await t.mutation(api.delivery.rampEnrollment.enrollCell, CELL);
		expect(result).toMatchObject({ enrolled: true, path: 'own_server', share: 1 });

		const row = await readManagedCell(t);
		expect(row?.ownShare).toBe(1);
		expect(row?.isFallbackActive).toBe(false);
		// THE RUNG IS EARNED, NEVER GRANTED. The phase ladder bounds the SHARE dial
		// and this cell has no second sender, so the ladder does not bind it at all
		// — an answer the controller re-resolves every tick from observed traffic.
		// Stamping the TOP rung here instead would bank a ceiling nobody was
		// promoted to.
		expect(row?.phaseCeiling).toBe(RAMP_INITIAL_PHASE_CEILING);
	});

	/**
	 * THE ACTUATOR IS NOT A PROPERTY OF THE ENROLMENT (plan D3). It is re-resolved
	 * every tick from OBSERVED reference-arm traffic, so a cell enrolled with no
	 * relay can be share-actuated next week — an operator connects an ESP, or a
	 * force-advance, a pin or a hard stop puts traffic on it. A ceiling banked at
	 * enrolment time would let the AIMD ladder climb back through 0.5 and 0.8 with
	 * the promotion gate never consulted, which is the exact recover-after-an-
	 * incident case that gate exists for.
	 */
	it('banks no ceiling for the day the cell becomes share-actuated', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, omitManagedCell: true });
		const enrolled = await t.mutation(api.delivery.rampEnrollment.enrollCell, CELL);
		expect(enrolled.path).toBe('own_server');

		// A relay now carries part of this cell: the reference arm is PRESENT, and
		// the substitution fold hands the cell to the share actuator from this tick.
		await seedArmOutcomes(t, { organizationId: ORG, arm: 'own', sent: 800 });
		await seedArmOutcomes(t, { organizationId: ORG, arm: 'reference', sent: 800 });
		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		expect((await readManagedCell(t))?.phaseCeiling).toBe(RAMP_INITIAL_PHASE_CEILING);
		// And the only way up is still one rung at a time, through the gate.
		const promoted = await t.mutation(api.delivery.rampPhasePromotion.promoteCellPhase, CELL);
		expect(promoted.phaseCeiling).toBe(0.5);
	});
});

/**
 * THE FORK AND THE CONTROLLER READ TWO DIFFERENT FACTS, and the divergence is
 * bounded: enrolment reads CONFIGURATION (a relay is connected) because that is
 * all that exists before the cell has ever been cut, while every tick reads
 * MEASUREMENT (reference-arm rows for this cell). They converge because the
 * opening cut is what produces the traffic the measurement then sees.
 */
describe('the fork’s answer and the controller’s converge', () => {
	it('opens on the ESP path with no relay traffic yet, and the tick agrees once there is', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, omitManagedCell: true });
		await connectRelay(t);

		// No outcome rows at all: nothing has been sent through either arm, so the
		// controller still measures this cell as standalone.
		const result = await t.mutation(api.delivery.rampEnrollment.enrollCell, CELL);
		expect(result.path).toBe('esp_relay');
		expect(await measuredActuator(t)).toBe('pace');

		// The cut lands: the relay carries 98% of the cell, and the arm it fills is
		// exactly the presence the fold reads.
		await seedArmOutcomes(t, { organizationId: ORG, arm: 'own', sent: 20 });
		await seedArmOutcomes(t, { organizationId: ORG, arm: 'reference', sent: 980 });
		expect(await measuredActuator(t)).toBe('share');
	});
});

describe('the audit pair (plan D12)', () => {
	it('records who enrolled the cell, and the move it made', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, omitManagedCell: true });
		await connectRelay(t);

		await t.mutation(api.delivery.rampEnrollment.enrollCell, CELL);

		expect(await auditActions(t)).toContain('deliverability_ramp.cell_enrolled');
		const recorded = await decisions(t);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.reason).toBe('operator_enrollment');
		expect(recorded[0]?.cell).toBe('campaign:gmail');
		// A healthy provider slice means the cell was already sending everything
		// from the own MTA, so enrolling on the ESP path is a CUT toward the relay.
		expect(recorded[0]?.fromShare).toBe(1);
		expect(recorded[0]?.toShare).toBe(RAMP_STREAM_CONFIGS.campaign.initialShareFraction);
		expect(recorded[0]?.direction).toBe('decrease');
		expect(recorded[0]?.message).toContain('operator');
		expect(recorded[0]?.snapshot).toContain('esp_relay');
	});
});

/**
 * THE SHARE IS ONLY A SPLIT WHERE THE ROUTE CAN MAKE ONE.
 *
 * The router builds a per-recipient mix context under `adaptive_mix` and under
 * no other strategy, so on a shipped `priority_failover` stream the opening 2%
 * is a number the controller drives while every message keeps routing exactly
 * where it did yesterday. Enrolment still happens — the streak, the rung and the
 * measurement all start here — but the audit row is the permanent record of what
 * an operator was told, and it must not claim a 98/2 split no message obeys.
 */
describe('what the opening share actually does today', () => {
	it('does not claim the relay carries the rest on a route that cannot split', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, omitManagedCell: true });
		await connectRelay(t);

		const result = await t.mutation(api.delivery.rampEnrollment.enrollCell, CELL);
		expect(result).toMatchObject({ enrolled: true, path: 'esp_relay', isShareRouted: false });

		const recorded = await decisions(t);
		expect(recorded[0]?.message).toContain('does not split by share');
		expect(recorded[0]?.message).not.toContain('the relay carries the rest');
		// The one fact the row would otherwise be read as claiming — same shape as
		// the phase reset's `shareHeld`.
		expect(recorded[0]?.snapshot).toContain('shareNotRouted');
	});

	it('claims it once the stream’s route splits by the share', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, omitManagedCell: true });
		await connectRelay(t, 'adaptive_mix');

		const result = await t.mutation(api.delivery.rampEnrollment.enrollCell, CELL);
		expect(result).toMatchObject({ enrolled: true, path: 'esp_relay', isShareRouted: true });

		const recorded = await decisions(t);
		expect(recorded[0]?.message).toContain('the relay carries the rest');
		expect(recorded[0]?.snapshot).not.toContain('shareNotRouted');
	});

	/**
	 * THE ANSWER IS PER STREAM, not per deployment. A campaign route on
	 * `adaptive_mix` says nothing about how the automation stream routes, and a
	 * screen that read the first row it found would tell half the cells the wrong
	 * thing.
	 */
	it('answers for the enrolled cell’s own stream', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, omitManagedCell: true });
		await connectRelay(t, 'adaptive_mix');

		const automation = await t.mutation(api.delivery.rampEnrollment.enrollCell, {
			stream: 'automation' as const,
			destinationProvider: 'gmail' as const,
		});
		expect(automation.isShareRouted).toBe(false);
	});

	/**
	 * THE OWN-SERVER PATH NEVER CLAIMED A SPLIT, so the strategy cannot change
	 * what it says: with no relay there is no second sender for any route to send
	 * traffic to, and the dial that ramps is the warming pace.
	 */
	it('says the same thing on the own-server path either way', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, omitManagedCell: true });

		const result = await t.mutation(api.delivery.rampEnrollment.enrollCell, CELL);
		expect(result).toMatchObject({ enrolled: true, path: 'own_server' });
		expect((await decisions(t))[0]?.message).toContain('warm-up pace');
	});

	/**
	 * AND ALL THREE SEAMS ASK THE SAME QUESTION. What this door TELLS an operator,
	 * what the enqueue seam RECORDS and what the dispatch-time router DOES are
	 * three modules that must agree about whether a split is happening. Today
	 * `adaptive_mix` is the union's only splitting member, so a hand-rolled copy
	 * of the comparison is invisible — until a second splitting strategy lands,
	 * at which point the seam that was not updated records `own` for traffic the
	 * router is splitting and this door tells the operator the opposite. So the
	 * comparison lives in `isShareSplitRoute` and nowhere else.
	 */
	it('asks ONE predicate — no seam hand-rolls the strategy comparison', async () => {
		const fs = await import('node:fs/promises');
		const read = async (rel: string) => await fs.readFile(new URL(rel, import.meta.url), 'utf8');
		const rule = /===\s*'adaptive_mix'/g;

		const owner = await read('../../lib/sendProviders/routeMixContext.ts');
		expect(owner.match(rule)).toHaveLength(1);

		for (const rel of [
			'../rampEnrollment.ts',
			'../../lib/sendProviders/route.ts',
			'../../lib/sendProviders/cellRoute.ts',
		]) {
			const source = await read(rel);
			expect(source.match(rule), `${rel} must not restate the rule`).toBeNull();
			expect(source, `${rel} must ask the predicate`).toMatch(/ShareSplitRoute|ShareSplitRouted/);
		}
	});
});

describe('a cell that is already managed', () => {
	it('is refused, and nothing about its state is reset', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, ownShare: 0.4, cleanStreak: 3, mixVersion: 2 });

		const result = await t.mutation(api.delivery.rampEnrollment.enrollCell, CELL);
		expect(result).toEqual({ enrolled: false, refusal: 'cell_already_ramp_managed' });

		const row = await readManagedCell(t);
		expect(row?.ownShare).toBe(0.4);
		expect(row?.cleanStreak).toBe(3);
		expect(row?.mixVersion).toBe(2);
		expect(await decisions(t)).toHaveLength(0);
		expect(await auditActions(t)).toHaveLength(0);
	});
});

describe('a per-stream row with no stored share', () => {
	it('is patched rather than duplicated', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, omitManagedCell: true });
		const now = Date.now();
		await t.run(async (ctx) => {
			await ctx.db.insert('deliverabilityRouteStates', {
				organizationId: ORG,
				destinationProvider: 'gmail' as const,
				stream: 'campaign' as const,
				isFallbackActive: false,
				signals: [],
				mixVersion: 4,
				snapshotGeneratedAt: now,
				expiresAt: now + 60_000,
				updatedAt: now,
			});
		});

		await t.mutation(api.delivery.rampEnrollment.enrollCell, CELL);

		const perStream = (await routeStates(t)).filter((row) => row.stream === 'campaign');
		expect(perStream).toHaveLength(1);
		expect(perStream[0]?.ownShare).toBe(1);
		// The generation advances from the one the row already carried, so a cell
		// re-enrolled after a spell off the ramp cannot reuse an old assignment.
		expect(perStream[0]?.mixVersion).toBe(5);
	});

	/**
	 * OPENING STATE MEANS OPENING STATE. A share-less row was written by something
	 * that is not the ramp, so anything ramp-shaped on it was set for no enrolment
	 * anybody made: an operator pause or pin would silently hold or cap a ramp its
	 * owner never touched, and the pace dial would start the second actuator
	 * somewhere nobody put it.
	 */
	it('clears the operator’s hand and the pace dial it inherited', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, omitManagedCell: true });
		const now = Date.now();
		await t.run(async (ctx) => {
			await ctx.db.insert('deliverabilityRouteStates', {
				organizationId: ORG,
				destinationProvider: 'gmail' as const,
				stream: 'campaign' as const,
				isFallbackActive: false,
				signals: [],
				operatorPausedAt: now - 1_000,
				operatorPinnedShare: 0.1,
				lastCountedAt: now - 1_000,
				paceMultiplier: 0.5,
				paceCleanStreak: 4,
				paceLastEvaluatedUtcDay: '2026-01-01',
				paceDeferredAt: now - 1_000,
				snapshotGeneratedAt: now,
				expiresAt: now + 60_000,
				updatedAt: now,
			});
		});

		await t.mutation(api.delivery.rampEnrollment.enrollCell, CELL);

		const row = await readManagedCell(t);
		expect(row?.operatorPausedAt).toBeUndefined();
		expect(row?.operatorPinnedShare).toBeUndefined();
		expect(row?.lastCountedAt).toBeUndefined();
		expect(row?.paceMultiplier).toBeUndefined();
		expect(row?.paceCleanStreak).toBeUndefined();
		expect(row?.paceLastEvaluatedUtcDay).toBeUndefined();
		expect(row?.paceDeferredAt).toBeUndefined();
	});

	/**
	 * THE SHARE FREEZE IS THE ONE THING THAT SURVIVES. A cooldown is evidence a
	 * retreat happened, and the ramp's standing rule is that nobody raises through
	 * one — so enrolment must not become a laundering path for it: cut the cell,
	 * re-enrol, penalty gone.
	 */
	it('does not launder a stored cooldown off the row', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, omitManagedCell: true });
		const now = Date.now();
		const frozenUntil = now + 6 * 60 * 60 * 1000;
		await t.run(async (ctx) => {
			await ctx.db.insert('deliverabilityRouteStates', {
				organizationId: ORG,
				destinationProvider: 'gmail' as const,
				stream: 'campaign' as const,
				isFallbackActive: false,
				signals: [],
				frozenUntil,
				freezeReason: 'gate_breach' as const,
				cooldownMs: 6 * 60 * 60 * 1000,
				snapshotGeneratedAt: now,
				expiresAt: now + 60_000,
				updatedAt: now,
			});
		});

		// A CUT toward the relay is never blocked, so this enrolment applies — and
		// the freeze it found is still standing afterwards.
		await connectRelay(t);
		const result = await t.mutation(api.delivery.rampEnrollment.enrollCell, CELL);
		expect(result.enrolled).toBe(true);

		const row = await readManagedCell(t);
		expect(row?.frozenUntil).toBe(frozenUntil);
		expect(row?.freezeReason).toBe('gate_breach');
		expect(row?.cooldownMs).toBe(6 * 60 * 60 * 1000);
	});
});

/**
 * A HAND ON THE CONTROL IS STILL A HAND INSIDE THE HARD STOPS — and enrolment
 * can be an increase: a cell whose provider slice is in relay fallback resolves
 * to 0 today, so putting it on the ramp at full share moves every recipient onto
 * the own MTA in one step. That is exactly the move the hard stops exist for.
 */
describe('hard stops bound an enrolment that RAISES the share', () => {
	it('refuses while the global kill switch is engaged, and creates no row', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, omitManagedCell: true, isPaused: true });
		await holdProviderSliceInFallback(t);

		const result = await t.mutation(api.delivery.rampEnrollment.enrollCell, CELL);
		expect(result).toEqual({ enrolled: false, refusal: 'controller_paused' });
		expect((await routeStates(t)).some((row) => row.stream === 'campaign')).toBe(false);
		expect(await decisions(t)).toHaveLength(0);
	});

	it('refuses while sending is abuse-suspended', async () => {
		const t = harness();
		await seedRampCell(t, {
			organizationId: ORG,
			omitManagedCell: true,
			abuseStatus: 'suspended',
		});
		await holdProviderSliceInFallback(t);

		const result = await t.mutation(api.delivery.rampEnrollment.enrollCell, CELL);
		expect(result).toEqual({ enrolled: false, refusal: 'hard_stop_active' });
	});

	it('refuses while a critical pool blocklist listing stands', async () => {
		const t = harness();
		await seedRampCell(t, {
			organizationId: ORG,
			omitManagedCell: true,
			poolSignals: [{ source: 'dnsbl_listed', severity: 'critical', observedAt: Date.now() }],
		});
		await holdProviderSliceInFallback(t);

		const result = await t.mutation(api.delivery.rampEnrollment.enrollCell, CELL);
		expect(result).toEqual({ enrolled: false, refusal: 'hard_stop_active' });
	});

	it('still enrols a CUT toward the relay while the kill switch is engaged', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, omitManagedCell: true, isPaused: true });
		await connectRelay(t);

		// The slice is healthy, so the cell sends everything from the own MTA today
		// and enrolling at 2% moves traffic TO the relay. A retreat is never blocked.
		const result = await t.mutation(api.delivery.rampEnrollment.enrollCell, CELL);
		expect(result.enrolled).toBe(true);
		expect((await readManagedCell(t))?.ownShare).toBe(
			RAMP_STREAM_CONFIGS.campaign.initialShareFraction
		);
	});
});

describe('the admin floor', () => {
	it('refuses a non-admin caller and writes nothing', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, omitManagedCell: true });
		session.isAdmin = false;
		try {
			await expect(t.mutation(api.delivery.rampEnrollment.enrollCell, CELL)).rejects.toThrow();
		} finally {
			session.isAdmin = true;
		}
		expect((await routeStates(t)).some((row) => row.stream === 'campaign')).toBe(false);
		expect(await auditActions(t)).toHaveLength(0);
	});
});

describe('cross-tenant', () => {
	it('files the enrolment against the caller’s own organization only', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, omitManagedCell: true });

		// The cell arguments are unchanged; only the SESSION's tenant moved.
		session.organizationId = OTHER_ORG;
		await t.mutation(api.delivery.rampEnrollment.enrollCell, CELL);

		const perStream = (await routeStates(t)).filter((row) => row.stream === 'campaign');
		expect(perStream).toHaveLength(1);
		expect(perStream[0]?.organizationId).toBe(OTHER_ORG);
	});
});
