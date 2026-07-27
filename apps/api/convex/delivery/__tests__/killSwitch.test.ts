/**
 * THE GLOBAL KILL SWITCH — the plan's named mitigation for controller
 * complexity, shipped with the controller rather than after it.
 *
 * The contract: one flag pins EVERY cell at its current share, honoured before
 * any other logic including the hard stops. A paused controller still evaluates
 * and still audits — so an operator can watch what it would have done — and
 * writes no share.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { allDeliverabilityCells } from '@owlat/shared/deliverabilityRouting';
import { createTestInstanceSettings } from '../../__tests__/factories';
import { nextShare } from '../ramp/controller';
import { RAMP_STREAM_CONFIGS } from '../ramp/gateConfig';
import {
	cleanEvaluation,
	controllerInput,
	mixState,
	NOW,
} from '../ramp/__tests__/controllerFixtures';
import { modules } from './testModules';

const ORG = 'org_ramp_kill_switch';
const DAY_MS = 24 * 60 * 60 * 1000;

type Harness = ReturnType<typeof convexTest>;

async function seed(t: Harness, options: { isPaused: boolean }): Promise<void> {
	const now = Date.now();
	await t.run(async (ctx) => {
		await ctx.db.insert(
			'instanceSettings',
			createTestInstanceSettings({
				abuseStatus: 'clean' as const,
				isRampControllerPaused: options.isPaused,
			})
		);
		// The stream-less row the MTA snapshot owns, plus one MANAGED cell.
		await ctx.db.insert('deliverabilityRouteStates', {
			organizationId: ORG,
			destinationProvider: 'gmail' as const,
			isFallbackActive: false,
			signals: [],
			snapshotGeneratedAt: now,
			expiresAt: now + DAY_MS,
			updatedAt: now,
		});
		await ctx.db.insert('deliverabilityRouteStates', {
			organizationId: ORG,
			destinationProvider: 'gmail' as const,
			stream: 'campaign' as const,
			isFallbackActive: true,
			ownShare: 0.1,
			phaseCeiling: 1,
			cleanStreak: 9,
			mixVersion: 3,
			signals: [],
			snapshotGeneratedAt: now,
			expiresAt: now + DAY_MS,
			updatedAt: now,
		});
	});
}

async function managedRow(t: Harness) {
	// A whole-table read rather than an index scan: the harness ctx is untyped
	// for named indexes, and the table holds two rows in this fixture.
	const rows = await t.run(
		async (ctx) => await ctx.db.query('deliverabilityRouteStates').collect()
	);
	return rows.find((row) => row.stream === 'campaign');
}

describe('the kill switch, in the decision function', () => {
	it('pins every cell of the grid before any other logic', () => {
		for (const cell of allDeliverabilityCells()) {
			const decision = nextShare(
				controllerInput({
					cell,
					config: RAMP_STREAM_CONFIGS[cell.stream],
					isKillSwitchEngaged: true,
					mix: mixState({ share: 0.37, cleanStreak: 99, greenSince: NOW - 40 * DAY_MS }),
					evaluation: cleanEvaluation(99),
					// Every hard stop active at once, and a capacity projection begging
					// for an increase. The switch still wins.
					signals: {
						isSendingAllowed: false,
						isCircuitBreakerOpen: true,
						isPoolBlocklisted: true,
					},
					capacity: { warmingCapRemaining: 1e9, projectedVolume: 1 },
				})
			);
			expect(decision.share).toBe(0.37);
			expect(decision.reason).toBe('kill_switch');
			expect(decision.direction).toBe('hold');
			expect(decision.frozenUntil).toBeUndefined();
			expect(decision.cooldownMs).toBeUndefined();
		}
	});
});

describe('the kill switch, through the cron', () => {
	it('writes no share while paused, but still audits every evaluation', async () => {
		const t = convexTest(schema, modules);
		await seed(t, { isPaused: true });
		const before = await managedRow(t);

		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		const after = await managedRow(t);
		expect(after?.ownShare).toBe(before?.ownShare);
		expect(after?.cleanStreak).toBe(before?.cleanStreak);
		expect(after?.mixVersion).toBe(before?.mixVersion);
		expect(after?.updatedAt).toBe(before?.updatedAt);

		const decisions = await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect());
		expect(decisions).toHaveLength(1);
		expect(decisions[0]?.reason).toBe('kill_switch');
		expect(decisions[0]?.direction).toBe('hold');
		expect(decisions[0]?.message).toContain('kill switch');

		// A paused controller changes nothing, so it logs nothing to the audit log.
		const auditLogs = await t.run(async (ctx) => await ctx.db.query('auditLogs').collect());
		expect(auditLogs).toHaveLength(0);
	});

	it('evaluates and writes again once the switch is released', async () => {
		const t = convexTest(schema, modules);
		await seed(t, { isPaused: false });

		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		const after = await managedRow(t);
		// With no outcome data every gate holds, so the share does not move — but
		// the row IS refreshed, which is how "the controller ran" is observable.
		expect(after?.ownShare).toBe(0.1);
		expect(after?.isFallbackActive).toBe(true);
		const decisions = await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect());
		expect(decisions).toHaveLength(1);
		expect(decisions[0]?.reason).toBe('holding');
	});

	it('leaves an UNMANAGED cell alone entirely — no row, no share, no audit', async () => {
		const t = convexTest(schema, modules);
		await seed(t, { isPaused: false });

		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});

		const rows = await t.run(
			async (ctx) => await ctx.db.query('deliverabilityRouteStates').collect()
		);
		// Still exactly the two seeded rows: the controller never seeds a cell.
		expect(rows).toHaveLength(2);
		const decisions = await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect());
		expect(decisions.map((row) => row.cell)).toEqual(['campaign:gmail']);
	});

	it('is a no-op on a deployment with no routing state at all', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', createTestInstanceSettings({}));
		});

		const result = await t.mutation(internal.delivery.rampControllerCron.runRampController, {});
		expect(result).toEqual({ evaluated: 0, done: true });
	});

	it('can be toggled through its own mutation', async () => {
		const t = convexTest(schema, modules);
		await seed(t, { isPaused: false });
		await t.mutation(internal.delivery.rampControllerCron.setRampControllerPaused, {
			isPaused: true,
		});
		const settings = await t.run(async (ctx) => await ctx.db.query('instanceSettings').first());
		expect(settings?.isRampControllerPaused).toBe(true);
	});
});
