/**
 * THE AUDIT TRAIL (plan D12), against real table writes.
 *
 * The contract this file exists to pin:
 *   - a row for EVERY evaluation, including the no-ops;
 *   - the gate snapshot round-trips, so a decision can be replayed;
 *   - every retreat with a NAMED cause carries an admin notice that names the
 *     gate that broke and says what to do about it — including the one that
 *     cannot lower the share because the cell is already on the floor;
 *   - 100% of decisions carry a human-readable reason. That is the KPI, and it
 *     is asserted over every reachable decision reason, not a sample.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { MutationCtx } from '../../_generated/server';
import { createTestInstanceSettings } from '../../__tests__/factories';
import { nextShare } from '../ramp/controller';
import { RAMP_AIMD } from '../ramp/controllerConfig';
import { recordMixDecision } from '../rampMixDecisions';
import { describeRampDecision } from '../ramp/controllerNarrative';
import type { Infer } from 'convex/values';
import { rampDecisionReasonValidator, rampGateIdValidator } from '../deliverabilityValidators';
import type { RampControllerInput, RampDecisionReason } from '../ramp/controllerTypes';
import type { RampGateId } from '../ramp/gateTypes';
import {
	breachedEvaluation,
	cleanEvaluation,
	controllerInput,
	DAY,
	GMAIL_CAMPAIGN,
	mixState,
	NOW,
	thinEvaluation,
} from '../ramp/__tests__/controllerFixtures';
import { modules } from '../../__tests__/testModules';

const ORG = 'org_ramp_audit';

type Harness = ReturnType<typeof convexTest>;

function routeStateRow(overrides: Record<string, unknown> = {}) {
	const now = Date.now();
	return {
		organizationId: ORG,
		destinationProvider: 'gmail' as const,
		stream: 'campaign' as const,
		isFallbackActive: false,
		ownShare: 0.1,
		phaseCeiling: 1,
		cleanStreak: 0,
		mixVersion: 1,
		signals: [],
		snapshotGeneratedAt: now,
		expiresAt: now + 24 * 60 * 60 * 1000,
		updatedAt: now,
		...overrides,
	};
}

async function record(t: Harness, input: RampControllerInput): Promise<void> {
	const decision = nextShare(input);
	await t.run(async (ctx) => {
		await recordMixDecision(ctx as unknown as MutationCtx, {
			organizationId: ORG,
			cell: input.cell,
			input,
			decision,
			at: NOW,
		});
	});
}

describe('mixDecisions — a row for every evaluation', () => {
	it('records a NO-OP hold, not just a change', async () => {
		const t = convexTest(schema, modules);
		await record(
			t,
			controllerInput({ mix: mixState({ share: 0.4 }), evaluation: thinEvaluation(0) })
		);

		const rows = await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect());
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row?.direction).toBe('hold');
		expect(row?.fromShare).toBe(0.4);
		expect(row?.toShare).toBe(0.4);
		expect(row?.reason).toBe('holding');
		expect(row?.message.length).toBeGreaterThan(20);
		expect(row?.adminNotice).toBeUndefined();
	});

	it('round-trips the gate snapshot so the decision can be replayed', async () => {
		const t = convexTest(schema, modules);
		const input = controllerInput({
			mix: mixState({ share: 0.4 }),
			evaluation: breachedEvaluation('hard_bounce'),
			capacity: { kind: 'projected', warmingCapRemaining: 500, projectedVolume: 1_000 },
		});
		await record(t, input);

		const rows = await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect());
		const snapshot = JSON.parse(rows[0]?.snapshot ?? '{}') as Record<string, unknown>;
		expect(snapshot['cell']).toBe('campaign:gmail');
		expect(snapshot['capacity']).toEqual({
			kind: 'projected',
			warmingCapRemaining: 500,
			projectedVolume: 1_000,
		});
		expect(snapshot['signals']).toEqual(input.signals);
		const evaluation = snapshot['evaluation'] as Record<string, unknown>;
		expect(evaluation['verdict']).toBe('fail');
		expect(evaluation['failedGate']).toBe('hard_bounce');
		expect(Array.isArray(evaluation['perGate'])).toBe(true);
		expect((evaluation['perGate'] as unknown[]).length).toBe(5);
	});

	it('names the failing gate and the remedy on a DECREASE', async () => {
		const t = convexTest(schema, modules);
		await record(
			t,
			controllerInput({
				mix: mixState({ share: 0.4 }),
				evaluation: breachedEvaluation('complaint'),
			})
		);

		const rows = await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect());
		const row = rows[0];
		expect(row?.direction).toBe('decrease');
		expect(row?.failedGate).toBe('complaint');
		expect(row?.adminNotice).toBeDefined();
		expect(row?.adminNotice).toContain('complaint');
		// "what to do about it", not just "it broke".
		expect(row?.adminNotice).toContain('unsubscribe');
		expect(row?.frozenUntil).toBeDefined();
	});

	it('writes no admin notice for an increase', async () => {
		const t = convexTest(schema, modules);
		await record(t, controllerInput({ mix: mixState({ share: 0.4 }) }));
		const rows = await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect());
		expect(rows[0]?.direction).toBe('increase');
		expect(rows[0]?.adminNotice).toBeUndefined();
	});

	it('is queryable by ORG, cell and time — never unscoped', async () => {
		const t = convexTest(schema, modules);
		await record(t, controllerInput({ mix: mixState({ share: 0.4 }) }));
		const byCell = await t.run(
			async (ctx) =>
				await ctx.db
					.query('mixDecisions')
					.withIndex('by_org_cell_time', (q) =>
						q.eq('organizationId', ORG).eq('cell', 'campaign:gmail')
					)
					.collect()
		);
		expect(byCell).toHaveLength(1);
		expect(byCell[0]?.organizationId).toBe(ORG);

		// The tenant is part of the key, so another tenant's identical cell key
		// cannot be reached through it.
		const otherTenant = await t.run(
			async (ctx) =>
				await ctx.db
					.query('mixDecisions')
					.withIndex('by_org_cell_time', (q) =>
						q.eq('organizationId', 'org_someone_else').eq('cell', 'campaign:gmail')
					)
					.collect()
		);
		expect(otherTenant).toHaveLength(0);
	});

	// A CELL ALREADY AT THE FLOOR CANNOT FALL FURTHER, and that is exactly when an
	// operator most needs telling: the breach is real, it imposes a fresh freeze
	// and it advances the cooldown ladder — only the number stands still. Keying
	// the notice off the direction of the share silenced the worst case.
	it('notifies on a breach that cannot lower the share any further', async () => {
		const t = convexTest(schema, modules);
		const input = controllerInput({
			mix: mixState({ share: RAMP_AIMD.shareFloor }),
			evaluation: breachedEvaluation('hard_bounce'),
		});
		const decision = nextShare(input);
		expect(decision.share).toBe(RAMP_AIMD.shareFloor);
		expect(decision.direction).toBe('hold');
		expect(decision.failedGate).toBe('hard_bounce');
		// The retreat still costs the cell a freeze: this is an incident, not a no-op.
		expect(decision.frozenUntil).toBeGreaterThan(NOW);

		await record(t, input);
		const row = (await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect()))[0];
		expect(row?.reason).toBe('hard_bounce');
		expect(row?.adminNotice).toContain('hard bounce');
		// The verb comes from the DIRECTION: "Reduced (1% -> 1%)" would read as a
		// no-op sentence for a real breach.
		expect(row?.message).not.toContain('Reduced');
		expect(row?.message).toContain('floor');
	});

	it('writes no admin notice for a ceiling-bound retreat — nothing broke', async () => {
		const t = convexTest(schema, modules);
		await record(
			t,
			controllerInput({
				mix: mixState({ share: 0.5 }),
				capacity: { kind: 'projected', warmingCapRemaining: 1, projectedVolume: 1_000 },
			})
		);
		const row = (await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect()))[0];
		expect(row?.direction).toBe('decrease');
		expect(row?.failedGate).toBeUndefined();
		expect(row?.adminNotice).toBeUndefined();
		// …and the sentence describes a RETREAT rather than claiming it "held".
		expect(row?.message).toContain('Reduced');
	});

	it('notifies on a HARD-STOP retreat, naming the cause', async () => {
		const t = convexTest(schema, modules);
		await record(
			t,
			controllerInput({
				mix: mixState({ share: 0.5 }),
				signals: { isSendingAllowed: true, isCircuitBreakerOpen: false, isPoolBlocklisted: true },
			})
		);
		const row = (await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect()))[0];
		expect(row?.reason).toBe('dnsbl');
		expect(row?.adminNotice).toContain('blocklist');
	});
});

describe('mixDecisions — the human-readable-reason KPI', () => {
	const scenarios: ReadonlyArray<[string, Partial<RampControllerInput>]> = [
		['kill switch', { isKillSwitchEngaged: true }],
		['clock', { now: Number.NaN }],
		[
			'abuse',
			{
				signals: { isSendingAllowed: false, isCircuitBreakerOpen: false, isPoolBlocklisted: false },
			},
		],
		[
			'breaker',
			{ signals: { isSendingAllowed: true, isCircuitBreakerOpen: true, isPoolBlocklisted: false } },
		],
		[
			'dnsbl',
			{ signals: { isSendingAllowed: true, isCircuitBreakerOpen: false, isPoolBlocklisted: true } },
		],
		['unreadable share', { mix: mixState({ share: -3 }) }],
		['frozen', { mix: mixState({ share: 0.4, frozenUntil: NOW + 1 }) }],
		// `evaluation: null` is deliberately absent: it is the SAME `holding`
		// reason as thin evidence, and this table asserts one scenario per reason.
		['holding', { evaluation: thinEvaluation(0) }],
		['stale evidence', { evaluation: cleanEvaluation(3, NOW - 400 * DAY) }],
		['tripwire alone', { evaluation: breachedEvaluation('seed_placement') }],
		[
			'capacity unknown',
			{ capacity: { kind: 'projected', warmingCapRemaining: Number.NaN, projectedVolume: 1 } },
		],
		['building confidence', { evaluation: cleanEvaluation(0) }],
		[
			'capacity ceiling',
			{ capacity: { kind: 'projected', warmingCapRemaining: 1, projectedVolume: 1_000 } },
		],
		['phase ceiling', { mix: mixState({ share: 0.25, phaseCeiling: 0.25 }) }],
		// K_CLEAN is already satisfied, so the ONLY thing between this cell and an
		// additive step is the window anchor — without the streak it would fall into
		// `building_confidence` and this row would silently stop covering `window_open`.
		[
			'window already counted',
			{ mix: mixState({ share: 0.4, cleanStreak: 3, lastCountedAt: NOW - 1_000 }) },
		],
		['healthy', {}],
		['graduated', { mix: mixState({ share: 1, greenSince: NOW - 20 * DAY }) }],
		['gate breach', { evaluation: breachedEvaluation('deferral') }],
		// THE FLOORED BREACH. `max(floor, floor x 0.5)` is the floor, so this
		// decision is a HOLD — the one retreat the share cannot express. It has to
		// be in the table, or the branch that words it and the notice that announces
		// it are both unpinned. A different gate from the row above, because the
		// table asserts one scenario per distinct reason.
		[
			'gate breach at the floor',
			{
				mix: mixState({ share: RAMP_AIMD.shareFloor }),
				evaluation: breachedEvaluation('hard_bounce'),
			},
		],
	];

	it('gives every reachable decision a distinct, actionable sentence', async () => {
		const t = convexTest(schema, modules);
		const seen = new Set<string>();
		for (const [, overrides] of scenarios) {
			const input = controllerInput({ mix: mixState({ share: 0.4 }), ...overrides });
			const decision = nextShare(input);
			const message = describeRampDecision(GMAIL_CAMPAIGN, decision);
			expect(message.length).toBeGreaterThan(20);
			expect(message).toContain('campaign mail to gmail');
			seen.add(decision.reason);
			await record(t, input);
		}
		// Every scenario is a distinct reason: the table is not accidentally
		// exercising one branch seventeen times.
		expect(seen.size).toBe(scenarios.length);

		const rows = await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect());
		expect(rows).toHaveLength(scenarios.length);
		for (const row of rows) {
			expect(row.message.length).toBeGreaterThan(20);
			expect(row.reason.length).toBeGreaterThan(0);
			expect(typeof row.snapshot).toBe('string');
		}
	});

	it('never tells an operator the relay is on standby while it carries the cell', async () => {
		const t = convexTest(schema, modules);
		// A GRADUATED cell the warming cap has bounded to 40%. The pin is real, but
		// the relay is demonstrably still carrying the other 60%, so the recorded
		// sentence must be built from the SHARE and not from the reason alone.
		const input = controllerInput({
			mix: mixState({
				share: 0.4,
				cleanStreak: 41,
				greenSince: NOW - 20 * DAY,
				graduatedAt: NOW - 6 * DAY,
			}),
			evaluation: cleanEvaluation(41),
			capacity: { kind: 'projected', warmingCapRemaining: 500, projectedVolume: 1_000 },
		});
		expect(nextShare(input).reason).toBe('graduated');
		await record(t, input);

		const rows = await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect());
		const row = rows[0];
		expect(row?.reason).toBe('graduated');
		expect(row?.toShare).toBe(0.4);
		expect(row?.message).toContain('40%');
		expect(row?.message).not.toContain('100%');
		expect(row?.message).not.toContain('standby');
	});
});

/**
 * THE STORED VOCABULARY AND THE TS UNION ARE ONE.
 *
 * `controllerNarrative.ts` switches EXHAUSTIVELY on `RampDecisionReason`, which
 * is what guarantees every decision has a sentence. A `v.string()` column would
 * leave that guarantee with no counterpart in the stored data. These are
 * compile-time assertions: a reason added to the type without a literal in the
 * validator (or the reverse) makes `true` unassignable and fails typecheck.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const REASON_VOCABULARY_MATCHES: Exact<
	Infer<typeof rampDecisionReasonValidator>,
	RampDecisionReason
> = true;
const GATE_VOCABULARY_MATCHES: Exact<Infer<typeof rampGateIdValidator>, RampGateId> = true;

describe('mixDecisions — the stored reason vocabulary', () => {
	it('is exactly the union the narrative switches on', () => {
		expect(REASON_VOCABULARY_MATCHES).toBe(true);
		expect(GATE_VOCABULARY_MATCHES).toBe(true);
	});
});

describe('mixDecisions — retention', () => {
	it('ages out rows past the horizon and leaves fresh ones alone', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', createTestInstanceSettings({}));
			await ctx.db.insert('deliverabilityRouteStates', routeStateRow());
		});
		await record(t, controllerInput({ mix: mixState({ share: 0.4 }) }));
		await t.run(async (ctx) => {
			const rows = await ctx.db.query('mixDecisions').collect();
			for (const row of rows) await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
			await ctx.db.insert('mixDecisions', {
				organizationId: ORG,
				cell: 'campaign:gmail',
				stream: 'campaign' as const,
				destinationProvider: 'gmail' as const,
				at: Date.now(),
				fromShare: 0.1,
				toShare: 0.1,
				direction: 'hold' as const,
				verdict: 'pass' as const,
				reason: 'phase_ceiling',
				message: 'Held campaign mail to gmail at its phase ceiling.',
				snapshot: '{}',
				expiresAt: Date.now() + 1_000_000,
			});
		});

		await t.mutation(internal.delivery.rampMixDecisions.cleanupExpiredDecisions, {});
		const remaining = await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect());
		expect(remaining).toHaveLength(1);
		expect(remaining[0]?.expiresAt).toBeGreaterThan(Date.now());
	});
});
