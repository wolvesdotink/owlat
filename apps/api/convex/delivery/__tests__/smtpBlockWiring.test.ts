/**
 * GATE 2'S BLOCK CLAUSE HAS A PRODUCTION SUPPLIER — end to end, through the REAL
 * readers (issue #501).
 *
 * The sibling of `seedGateWiring.test.ts`, one gate over. `smtpBlockMessage.test.ts`
 * has always proved the clause's ARITHMETIC by handing it an observation; what
 * nothing proved is that anything in a deployment ever BUILDS one. Nothing did:
 * the classifier ran in the MTA, no row carried its per-category counts into
 * Convex per (cell, arm), and `evaluateSmtpBlockMessages` returned `null` on
 * every tick of every deployment while every gate suite stayed green.
 *
 * So this file asserts REACHABILITY, not arithmetic. Classified responses go in
 * the way the webhook writes them, and the verdict is read off the evaluation
 * THE CRON'S OWN loader builds and off THE SCREEN'S query — never off a
 * hand-built input.
 *
 * AND IT PINS THE DISTINCTION THE WHOLE WAVE IS ABOUT. Three states, three
 * different verdicts:
 *   - NO ROWS: the clause has no verdict, gate 2 falls through to the deferral
 *     rate. This is what every deployment did before the wire existed, and it is
 *     still the honest answer for a cell nothing has classified.
 *   - ROWS, NO REFUSALS: the clause HAS a denominator and derives 0%. Measured,
 *     and healthy.
 *   - ROWS WITH REFUSALS: the halt fires, on the controller and on the screen.
 *
 * BOTH ARMS OF THE MATRIX. The clause only exists on the trailing-baseline
 * (standalone) evaluator, so the reference-armed cell is pinned as NOT consulting
 * it — a supply that leaked into the two-armed path would be a second gate-2
 * definition, not a wiring fix.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import type { DeliverabilityCell } from '@owlat/shared/deliverabilityRouting';
import type { SmtpFailureCategory } from '@owlat/shared/smtpBlockCategories';
import { recordSmtpResponseForCell } from '../../analytics/smtpResponseCategories';
import { deliverabilityCellKey } from '@owlat/shared/deliverabilityRouting';
import { loadCellInput } from '../rampControllerInputs';
import { loadRampDeploymentPresence } from '../rampIntegrationPresence';
import { loadRampPresets } from '../rampPresets';
import { loadRampCapacityContext } from '../rampCapacityInputs';
import { loadStreamlessRouteState } from '../../lib/deliverabilityRouteState';
import { summarizeSeedPlacementSweeps } from '../../analytics/seedPlacement';
import type { DeliverabilityDashboard } from '../deliverabilityDashboard';
import type { RampGateResult } from '../ramp/gateTypes';
import { connectRelay, seedArmOutcomes, seedRampCell, type Harness } from './rampCronFixtures';
import { modules } from '../../__tests__/testModules';

const ORG = 'org_smtp_block_wiring';
const CELL: DeliverabilityCell = { stream: 'campaign', destinationProvider: 'gmail' };

vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/sessionOrganization')>();
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ({
			userId: 'user-1',
			role: 'owner' as const,
			activeOrganizationId: 'org_smtp_block_wiring',
		})),
		getUserIdFromSession: vi.fn().mockResolvedValue('user-1'),
		getSingletonOrganizationId: vi.fn().mockResolvedValue('org_smtp_block_wiring'),
	};
});

/** Classified responses on the cell's own arm, through the production writer. */
async function seedClassifiedResponses(
	t: Harness,
	responses: Partial<Record<SmtpFailureCategory, number>>,
	options: { readonly arm?: 'own' | 'reference' } = {}
): Promise<void> {
	await t.run(async (ctx) => {
		for (const [category, count] of Object.entries(responses)) {
			for (let index = 0; index < (count ?? 0); index += 1) {
				await recordSmtpResponseForCell(ctx, {
					organizationId: ORG,
					cell: deliverabilityCellKey(CELL),
					arm: options.arm ?? 'own',
					category: category as SmtpFailureCategory,
				});
			}
		}
	});
}

/** Gate 2's verdict as the CRON's loader builds it. */
async function controllerDeferralGate(t: Harness): Promise<RampGateResult> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const pool = await loadStreamlessRouteState(ctx, ORG, 'all');
		const presence = await loadRampDeploymentPresence(ctx, { organizationId: ORG, now });
		const presets = await loadRampPresets(ctx, ORG);
		const loaded = await loadCellInput(ctx, {
			organizationId: ORG,
			cell: CELL,
			pool,
			capacity: async () => await loadRampCapacityContext(ctx, { organizationId: ORG, now }),
			seeds: async () => await summarizeSeedPlacementSweeps(ctx.db, ORG, now),
			presence,
			isKillSwitchEngaged: false,
			isSendingPermitted: true,
			presets: presets.presets,
			presetFallback: presets.fallback,
			now,
		});
		if (loaded === null) throw new Error('the seeded cell is not ramp-managed');
		const evaluation = loaded.input.evaluation;
		if (evaluation === null) throw new Error('the loader built no gate evaluation');
		return gateOf(evaluation.perGate, 'the controller evaluation');
	});
}

/** The SAME gate as the screen reports it, for the same cell. */
async function dashboardDeferralGate(t: Harness): Promise<RampGateResult> {
	const dashboard: DeliverabilityDashboard = await t.query(
		api.delivery.deliverabilityDashboard.getDeliverabilityDashboard,
		{}
	);
	const view = dashboard.cells.find(
		(candidate) =>
			candidate.cell.stream === CELL.stream &&
			candidate.cell.destinationProvider === CELL.destinationProvider
	);
	if (view === undefined) throw new Error('the dashboard rendered no such cell');
	return gateOf(view.gates, 'the dashboard cell');
}

function gateOf(gates: readonly RampGateResult[], source: string): RampGateResult {
	const gate = gates.find((result) => result.gate === 'deferral');
	if (gate === undefined) throw new Error(`${source} carries no deferral gate`);
	return gate;
}

/** Own traffic only: the trailing-baseline twin runs, so the clause is live. */
async function standaloneCell(t: Harness): Promise<void> {
	await seedRampCell(t, { organizationId: ORG });
	await seedArmOutcomes(t, { organizationId: ORG, arm: 'own', sent: 5_000 });
}

describe('a window of refusals reaches gate 2 through both real readers', () => {
	it('HALTS the controller, on evidence no deployment could supply before', async () => {
		const t = convexTest(schema, modules);
		await standaloneCell(t);
		// 30 classified responses, one of them a refusal: past the sample floor of
		// 20 and past the 0.5% halt line.
		await seedClassifiedResponses(t, { greylisted: 29, content_rejected: 1 });

		const gate = await controllerDeferralGate(t);
		expect(gate.status).toBe('halt');
		expect(gate.reason).toBe('block_message_detected');
		expect(gate.measurement.ownSample).toBe(30);
	});

	it('reports the SAME halt on the screen', async () => {
		// ADR-0042: the screen must report the verdict the controller reaches, not a
		// friendlier one. Both build the observation from the same rows through the
		// same summarizer; the spans differ (24h against 7d) and this window sits
		// inside both.
		const t = convexTest(schema, modules);
		await standaloneCell(t);
		await seedClassifiedResponses(t, { greylisted: 29, content_rejected: 1 });

		const gate = await dashboardDeferralGate(t);
		expect(gate.status).toBe('halt');
		expect(gate.reason).toBe('block_message_detected');
	});

	it('halts on a POLICY refusal and on Gmail’s IP-identity 4xx too', async () => {
		// The block SET, not one literal: `gmail_ip_identity` is a 421 — a code
		// class the deferral counter also sees — and it is a refusal of the sending
		// identity rather than rate pressure. A wiring that carried only 5xx
		// categories would drop it silently.
		for (const category of ['policy_rejected', 'gmail_ip_identity'] as const) {
			const t = convexTest(schema, modules);
			await standaloneCell(t);
			await seedClassifiedResponses(t, { rate_limited: 29, [category]: 1 });
			expect((await controllerDeferralGate(t)).reason).toBe('block_message_detected');
		}
	});
});

describe('a measured zero is not an absence, and neither is a halt', () => {
	it('does NOT halt on a window of pure rate pressure', async () => {
		// The rows exist and the denominator is real; none of the categories in it
		// is a refusal, so the clause derives 0% and declines. Treating throttling
		// as a block would halt a cell for succeeding.
		const t = convexTest(schema, modules);
		await standaloneCell(t);
		await seedClassifiedResponses(t, {
			greylisted: 20,
			rate_limited: 10,
			yahoo_ts03: 5,
			microsoft_resource_throttle: 5,
			mailbox_full: 5,
		});

		const gate = await controllerDeferralGate(t);
		expect(gate.status).not.toBe('halt');
		expect(gate.reason).not.toBe('block_message_detected');
	});

	it('does NOT halt a cell nothing has classified — the pre-wiring state, preserved', async () => {
		// A deployment with no classified responses gets ABSENCE, and absence has
		// never been a reason to halt. The point of the case is that supplying the
		// field did not turn silence into a verdict.
		const t = convexTest(schema, modules);
		await standaloneCell(t);

		expect((await controllerDeferralGate(t)).reason).not.toBe('block_message_detected');
		expect((await dashboardDeferralGate(t)).reason).not.toBe('block_message_detected');
	});

	it('does not halt below the sample floor', async () => {
		// 19 responses, ALL of them refusals: a 100% block rate under a floor of 20.
		// A hard stop that can fire on a handful of responses is a hard stop that
		// will fire on a handful of responses.
		const t = convexTest(schema, modules);
		await standaloneCell(t);
		await seedClassifiedResponses(t, { content_rejected: 19 });

		expect((await controllerDeferralGate(t)).reason).not.toBe('block_message_detected');
	});
});

describe('the clause belongs to the standalone evaluator alone', () => {
	it('leaves a reference-armed cell on the deferral RATE, refusals or not', async () => {
		// The two-armed evaluator's gate 2 is `evaluateDeferralGate` and consults no
		// block observation at all. Supplying the field must not have quietly given
		// the equipped path a second gate-2 definition.
		const t = convexTest(schema, modules);
		await seedRampCell(t, { organizationId: ORG });
		await connectRelay(t);
		await seedArmOutcomes(t, { organizationId: ORG, arm: 'own', sent: 5_000 });
		await seedArmOutcomes(t, { organizationId: ORG, arm: 'reference', sent: 5_000 });
		await seedClassifiedResponses(t, { greylisted: 29, content_rejected: 1 });

		expect((await controllerDeferralGate(t)).reason).not.toBe('block_message_detected');
		expect((await dashboardDeferralGate(t)).reason).not.toBe('block_message_detected');
	});

	it('reads the OWN arm, never the reference arm’s responses', async () => {
		// A standalone cell whose refusals were recorded against the reference arm
		// has observed nothing on the arm the gate judges. The arm is a property of
		// the assignment row, so this is a real state — and folding both arms into
		// one observation would halt a cell on a relay's traffic.
		const t = convexTest(schema, modules);
		await standaloneCell(t);
		await seedClassifiedResponses(t, { greylisted: 29, content_rejected: 1 }, { arm: 'reference' });

		expect((await controllerDeferralGate(t)).reason).not.toBe('block_message_detected');
	});
});
