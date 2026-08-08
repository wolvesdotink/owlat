/**
 * THE ACCEPTANCE TEST (plan D2, D3, D14).
 *
 * Removing a previously-connected integration must:
 *   1. make the affected gate fall back to its SUBSTITUTE within ONE window,
 *   2. drop the cell's confidence, NAMING the integration that would restore it,
 *   3. and CONTINUE THE RAMP AT REDUCED SPEED rather than halting.
 *
 * "Within one window" is a property of the resolution, not of a scheduler: the
 * presence map is read on every tick and the constants are folded from it, so
 * the tick after the feed stops is already the degraded tick. The suite asserts
 * it TWICE — once over the pure fold (resolve with the integration and without,
 * and compare) and once END TO END through the cron against real rows, because
 * the fold reacting proves nothing if the reader that feeds it never notices.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import { OWN_SHARE_CEILING } from '@owlat/shared/deliverabilityRouting';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import { modules } from '../../../__tests__/testModules';
import { seedArmOutcomes, seedRampCell, type Harness } from '../../__tests__/rampCronFixtures';
import {
	loadRampDeploymentPresence,
	loadReferenceArmPresence,
	withReferenceArm,
} from '../../rampIntegrationPresence';
import {
	degradedCeilingCap,
	degradedStreamConfig,
	resolveRampDegradation,
	usesTrailingBaseline,
} from '../degradation';
import { RAMP_FULLY_EQUIPPED } from '../degradationMatrix';
import { rampCellConfidence } from '../measurementConfidence';
import { RAMP_STREAM_CONFIGS } from '../gateConfig';
import { absent } from './controllerFixtures';

vi.mock('../../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../lib/sessionOrganization')>();
	return {
		...actual,
		getSingletonOrganizationId: vi.fn().mockResolvedValue('org_ramp_integration_removal'),
	};
});

describe('removing a connected integration degrades within one window', () => {
	it('falls back to the substitute gate the moment the reference transport goes', () => {
		const before = resolveRampDegradation({
			presence: RAMP_FULLY_EQUIPPED,
			provider: 'gmail',
		});
		const after = resolveRampDegradation({
			presence: absent('reference_transport'),
			provider: 'gmail',
		});
		expect(usesTrailingBaseline(before)).toBe(false);
		expect(usesTrailingBaseline(after)).toBe(true);
		expect(after.actuator).toBe('pace');
		expect(after.substitutes).toContain('seed_placement');
	});

	it('falls back to the cell’s own outcomes the moment SNDS goes', () => {
		const after = resolveRampDegradation({
			presence: absent('microsoft_snds'),
			provider: 'microsoft',
		});
		// NOT SMTP reply classification, which this entry claimed until issue #501.
		// The counts reach Convex now, but the clause reading them is on the
		// standalone evaluator, and this entry also covers relay-equipped cells
		// whose gate 2 never consults it.
		expect(after.substitutes).toEqual(['own_bounce_deferral_complaint', 'seed_placement']);
		expect(degradedCeilingCap(after)).toBeLessThan(OWN_SHARE_CEILING);
	});

	it('falls back to the unsubscribe proxy the moment the feedback loop goes', () => {
		const after = resolveRampDegradation({
			presence: absent('complaint_feedback_loop'),
			provider: 'other',
		});
		expect(after.substitutes).toContain('unsubscribe_rate_proxy');
		const config = degradedStreamConfig(RAMP_STREAM_CONFIGS.campaign, after);
		expect(config.thresholds.complaintMax as number).toBeLessThan(
			RAMP_STREAM_CONFIGS.campaign.thresholds.complaintMax as number
		);
	});
});

describe('the confidence drop names the integration that would restore it', () => {
	it('names Google Postmaster on the gmail cell', () => {
		const degradation = resolveRampDegradation({
			presence: absent('google_postmaster'),
			provider: 'gmail',
		});
		const confidence = rampCellConfidence({ degradation, evaluated: 'high' });
		expect(confidence.level).not.toBe('high');
		expect(confidence.improvements.map((offer) => offer.integration)).toEqual([
			'google_postmaster',
		]);
		expect(confidence.improvements[0]?.improvement).toMatch(/Google Postmaster/);
	});

	it('names seed mailboxes — the one absence with no substitute at all', () => {
		const degradation = resolveRampDegradation({
			presence: absent('seed_mailboxes'),
			provider: 'gmail',
		});
		expect(degradation.substitutes).toHaveLength(0);
		const confidence = rampCellConfidence({ degradation, evaluated: 'high' });
		expect(confidence.level).toBe('low');
		expect(confidence.improvements.map((offer) => offer.integration)).toEqual(['seed_mailboxes']);
		// The reason is stated on the cell, not hidden behind a support article.
		expect(degradation.absent[0]?.paceCeilingDay).toBe(14);
	});
});

describe('the ramp continues at reduced speed rather than halting', () => {
	const degradation = resolveRampDegradation({
		presence: absent('reference_transport'),
		provider: 'gmail',
	});
	const base = RAMP_STREAM_CONFIGS.campaign;
	const degraded = degradedStreamConfig(base, degradation);

	it('still advances — the step is smaller, never zero', () => {
		expect(degraded.increaseStep as number).toBeGreaterThan(0);
		expect(degraded.increaseStep as number).toBeLessThan(base.increaseStep as number);
	});

	it('still advances — the confidence requirement is longer, never infinite', () => {
		expect(degraded.cleanWindowsRequired).toBeGreaterThan(base.cleanWindowsRequired);
		expect(Number.isFinite(degraded.cleanWindowsRequired)).toBe(true);
	});

	it('still reaches the top rung — a cap is not a halt', () => {
		expect(degradedCeilingCap(degradation)).toBe(OWN_SHARE_CEILING);
	});

	it('blocks nothing, anywhere in the resolution', () => {
		expect(degradation.isBlocking).toBe(false);
		for (const entry of degradation.absent) expect(entry.isBlocking).toBe(false);
	});

	it('reconnecting restores the equipped constants with no migration', () => {
		const restored = resolveRampDegradation({
			presence: RAMP_FULLY_EQUIPPED,
			provider: 'gmail',
		});
		expect(degradedStreamConfig(base, restored)).toBe(base);
		expect(usesTrailingBaseline(restored)).toBe(false);
	});
});

/**
 * THE SAME ACCEPTANCE CRITERION, THROUGH THE REAL SEAM.
 *
 * Everything above resolves two hand-built presence maps and compares them,
 * which proves the FOLD reacts. It cannot prove the deployment ever notices,
 * because "is this integration connected?" is answered by rows on disk —
 * `delivery/rampIntegrationPresence.ts` — and a reader that never sees a revoked
 * key would leave the equipped constants running for ever with every pure
 * fixture still green. So the criterion is re-asserted end to end: the tick
 * AFTER the data stops is already the degraded tick.
 */
describe('the deployment itself degrades within one window', () => {
	const ORG = 'org_ramp_integration_removal';

	interface DecisionSnapshot {
		readonly config?: { readonly increaseStep?: number; readonly cleanWindowsRequired?: number };
	}

	async function latestConfig(t: Harness): Promise<DecisionSnapshot['config']> {
		const rows = await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect());
		const newest = rows.sort((a, b) => b.at - a.at)[0];
		return (JSON.parse(newest?.snapshot ?? '{}') as DecisionSnapshot).config;
	}

	it('keeps the equipped constants while the relay arm is live, and halves them the next tick', async () => {
		const t = convexTest(schema, modules);
		await seedRampCell(t, { organizationId: ORG });
		await seedArmOutcomes(t, { organizationId: ORG, arm: 'own', sent: 800 });
		await seedArmOutcomes(t, { organizationId: ORG, arm: 'reference', sent: 800 });

		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});
		const equipped = await latestConfig(t);
		expect(equipped?.cleanWindowsRequired).toBe(RAMP_STREAM_CONFIGS.campaign.cleanWindowsRequired);
		expect(equipped?.increaseStep).toBeCloseTo(
			RAMP_STREAM_CONFIGS.campaign.increaseStep as number,
			10
		);

		// The relay is disconnected: its outcome rows stop existing. No migration,
		// no flag, no operator action — the next tick reads a different deployment.
		await t.run(async (ctx) => {
			const rows = await ctx.db.query('transportOutcomes').collect();
			for (const row of rows) if (row.arm === 'reference') await ctx.db.delete(row._id);
		});

		await t.mutation(internal.delivery.rampControllerCron.runRampController, {});
		const degraded = await latestConfig(t);
		// K_CLEAN 3 -> 5 and the step HALVED, exactly as the table says.
		expect(degraded?.cleanWindowsRequired).toBe(5);
		expect(degraded?.increaseStep).toBeCloseTo(
			(RAMP_STREAM_CONFIGS.campaign.increaseStep as number) / 2,
			10
		);
		// REDUCED SPEED, NOT A HALT: the step is smaller and still positive, and the
		// controller kept deciding rather than erroring out.
		expect(degraded?.increaseStep ?? 0).toBeGreaterThan(0);
	});

	it('drops the cell’s confidence and names what would restore it, off real rows', async () => {
		const t = convexTest(schema, modules);
		await seedRampCell(t, { organizationId: ORG });
		await seedArmOutcomes(t, { organizationId: ORG, arm: 'reference', sent: 800 });

		const confidenceNow = async () => {
			const deployment = await t.run(
				async (ctx) =>
					await loadRampDeploymentPresence(ctx, { organizationId: ORG, now: Date.now() })
			);
			const hasArm = await t.run(
				async (ctx) =>
					await loadReferenceArmPresence(ctx, {
						organizationId: ORG,
						cell: { stream: 'campaign', destinationProvider: 'gmail' },
						now: Date.now(),
					})
			);
			return rampCellConfidence({
				degradation: resolveRampDegradation({
					presence: withReferenceArm(deployment, hasArm),
					provider: 'gmail',
				}),
				evaluated: 'high',
			});
		};

		const before = await confidenceNow();
		expect(before.improvements.map((offer) => offer.integration)).not.toContain(
			'reference_transport'
		);

		await t.run(async (ctx) => {
			const rows = await ctx.db.query('transportOutcomes').collect();
			for (const row of rows) if (row.arm === 'reference') await ctx.db.delete(row._id);
		});

		const after = await confidenceNow();
		expect(after.level).toBe('low');
		expect(after.improvements.map((offer) => offer.integration)).toContain('reference_transport');
		// An OFFER, not a warning: the surface stays informational throughout.
		expect(after.tone).toBe('info');
		expect(after.isBlocking).toBe(false);
	});
});
