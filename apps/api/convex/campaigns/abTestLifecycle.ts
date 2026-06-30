/**
 * AB test lifecycle (module) — single writer of `campaigns.abTestStatus`
 * and its companion fields (`abTestConfig`, `abWinner`,
 * `abWinnerSelectedAt`, plus the `abVariantBSent..` reset block on
 * disable). Sibling of the **Campaign lifecycle (module)** — same row,
 * different column, separate legal-edges graph.
 *
 * Four legal edges:
 *   (none)  → pending           (enableABTest)
 *   pending → testing           (cross-machine — Campaign lifecycle's
 *                                start_ab_test_if_enabled effect when
 *                                the campaign goes `→ sending`)
 *   testing → winner_selected   (declareABTestWinner; manual or
 *                                auto-criteria-driven)
 *   *       → none              (disableABTest — full reset)
 *
 * Effects:
 *   audit_log(action, ...)      — fires on every transition.
 *
 * See docs/adr/0017-campaign-lifecycle-modules.md.
 */

import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { abTestConfigValidator } from '../lib/convexValidators';
import { recordAuditLog, type AuditAction } from '../lib/auditLog';

// ─── Types ──────────────────────────────────────────────────────────────────

export type AbTestStatus = 'pending' | 'testing' | 'winner_selected';

/**
 * The "machine state" includes a synthetic `'none'` representing
 * `abTestStatus === undefined` (AB test not enabled). Only used internally;
 * the persisted column is `AbTestStatus | undefined`.
 */
export type AbTestMachineState = AbTestStatus | 'none';

type AbTestConfig = NonNullable<Doc<'campaigns'>['abTestConfig']>;

export type AbTestTransitionInput =
	| { to: 'pending'; at: number; config: AbTestConfig }
	| { to: 'testing'; at: number }
	| { to: 'winner_selected'; at: number; winner: 'A' | 'B' }
	| { to: 'none'; at: number };

export type AbTestTransitionOutcome =
	| {
			ok: true;
			applied: 'transitioned' | 'recorded';
			from: AbTestMachineState;
			to: AbTestMachineState;
			campaignId: Id<'campaigns'>;
	  }
	| {
			ok: false;
			reason: 'campaign_not_found' | 'illegal_edge';
			from?: AbTestMachineState;
			to?: AbTestMachineState;
	  };

// ─── Validators ─────────────────────────────────────────────────────────────

const transitionInputValidator = v.union(
	v.object({
		to: v.literal('pending'),
		at: v.number(),
		config: abTestConfigValidator,
	}),
	v.object({ to: v.literal('testing'), at: v.number() }),
	v.object({
		to: v.literal('winner_selected'),
		at: v.number(),
		winner: v.union(v.literal('A'), v.literal('B')),
	}),
	v.object({ to: v.literal('none'), at: v.number() }),
);

// ─── Legal-edges graph ──────────────────────────────────────────────────────

const LEGAL_EDGES: Record<AbTestMachineState, ReadonlySet<AbTestMachineState>> = {
	none: new Set<AbTestMachineState>(['pending']),
	pending: new Set<AbTestMachineState>(['testing', 'none']),
	testing: new Set<AbTestMachineState>(['winner_selected', 'none']),
	winner_selected: new Set<AbTestMachineState>(['none']),
};

// ─── Effects ────────────────────────────────────────────────────────────────

type Effect =
	| {
			kind: 'audit_log';
			action: AuditAction;
			campaignId: Id<'campaigns'>;
			userId: string;
			details: Record<string, string | number | boolean | null>;
	  }
	| {
			// Schedules the second-phase send (winner content to the
			// audience members who were held back from the test cohort).
			// Owned by the Campaign send orchestrator (module)'s sibling
			// action `emails.sendCampaignWinnerToRemainder`. Fires only on
			// transitions into `winner_selected`.
			kind: 'schedule_winner_remainder';
			campaignId: Id<'campaigns'>;
	  }
	| {
			// Schedules automatic winner selection `testDurationHours` after the
			// test cohort goes out. Without this, an `open_rate`/`click_rate`
			// campaign (the wizard default) would sit in `testing` forever and
			// the held-back remainder audience (40–60%) would NEVER be sent.
			// Fires only on `→ testing` when winnerCriteria is not `manual`.
			kind: 'schedule_auto_winner';
			campaignId: Id<'campaigns'>;
			delayMs: number;
	  };

type ReducerResult = {
	patch: Record<string, unknown>;
	effects: Effect[];
	applied: 'transitioned' | 'recorded';
};

// ─── Reducer ────────────────────────────────────────────────────────────────

function reduce(
	campaign: Doc<'campaigns'>,
	input: AbTestTransitionInput,
	userId: string,
): ReducerResult {
	const from: AbTestMachineState = campaign.abTestStatus ?? 'none';

	if (from === input.to) {
		// Idempotent — record the attempt via audit log, no patch.
		return {
			patch: {},
			effects: [
				{
					kind: 'audit_log',
					action: auditActionFor(input.to),
					campaignId: campaign._id,
					userId,
					details: {
						previousStatus: from,
						newStatus: input.to,
						applied: 'recorded',
					},
				},
			],
			applied: 'recorded',
		};
	}

	const patch = buildPatch(input);
	const effects: Effect[] = [
		{
			kind: 'audit_log',
			action: auditActionFor(input.to),
			campaignId: campaign._id,
			userId,
			details: {
				previousStatus: from,
				newStatus: input.to,
				applied: 'transitioned',
				...(input.to === 'winner_selected' ? { winner: input.winner } : {}),
			},
		},
	];

	// Winner declaration triggers the second-phase send. The remainder
	// audience is computed inside the orchestrator from the existing
	// emailSends rows so the lifecycle stays oblivious to the cohort
	// membership.
	if (input.to === 'winner_selected') {
		effects.push({
			kind: 'schedule_winner_remainder',
			campaignId: campaign._id,
		});
	}

	// Entering the test phase with an automatic winner criterion: schedule the
	// auto-winner so the remainder audience is guaranteed a send. Manual
	// criteria rely on the user clicking "choose winner" (and the report page
	// surfaces those buttons only for `manual`).
	if (input.to === 'testing') {
		const config = campaign.abTestConfig;
		const durationHours = config?.testDuration;
		if (config && config.winnerCriteria !== 'manual' && durationHours && durationHours > 0) {
			effects.push({
				kind: 'schedule_auto_winner',
				campaignId: campaign._id,
				delayMs: durationHours * 60 * 60 * 1000,
			});
		}
	}

	return { patch, effects, applied: 'transitioned' };
}

function auditActionFor(to: AbTestMachineState): AuditAction {
	switch (to) {
		case 'pending':
			return 'ab_test.enabled';
		case 'testing':
			return 'ab_test.testing_started';
		case 'winner_selected':
			return 'ab_test.winner_declared';
		case 'none':
			return 'ab_test.disabled';
	}
}

function buildPatch(input: AbTestTransitionInput): Record<string, unknown> {
	const updatedAt = input.at;
	switch (input.to) {
		case 'pending':
			return {
				isABTest: true,
				abTestConfig: input.config,
				abTestStatus: 'pending',
				updatedAt,
			};
		case 'testing':
			return { abTestStatus: 'testing', updatedAt };
		case 'winner_selected':
			return {
				abTestStatus: 'winner_selected',
				abWinner: input.winner,
				abWinnerSelectedAt: input.at,
				updatedAt,
			};
		case 'none':
			// Full reset — mirrors the open-coded disableABTest:114-124 block.
			return {
				isABTest: false,
				abTestConfig: undefined,
				abTestStatus: undefined,
				abVariantBSent: undefined,
				abVariantBOpened: undefined,
				abVariantBClicked: undefined,
				abWinner: undefined,
				abWinnerSelectedAt: undefined,
				updatedAt,
			};
	}
}

// ─── Runner ─────────────────────────────────────────────────────────────────

async function applyEffects(
	ctx: MutationCtx,
	effects: ReadonlyArray<Effect>,
): Promise<void> {
	for (const effect of effects) {
		switch (effect.kind) {
			case 'audit_log': {
				await recordAuditLog(ctx, {
					userId: effect.userId,
					action: effect.action,
					resource: 'campaign',
					resourceId: effect.campaignId,
					details: effect.details,
				});
				break;
			}
			case 'schedule_winner_remainder': {
				await ctx.scheduler.runAfter(
					0,
					internal.campaigns.send.sendCampaignWinnerToRemainder,
					{ campaignId: effect.campaignId },
				);
				break;
			}
			case 'schedule_auto_winner': {
				await ctx.scheduler.runAfter(
					effect.delayMs,
					internal.campaigns.abTest.autoDeclareWinner,
					{ campaignId: effect.campaignId },
				);
				break;
			}
		}
	}
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

async function dispatch(
	ctx: MutationCtx,
	campaign: Doc<'campaigns'>,
	input: AbTestTransitionInput,
	userId: string,
): Promise<AbTestTransitionOutcome> {
	const from: AbTestMachineState = campaign.abTestStatus ?? 'none';
	const isLegalEdge = LEGAL_EDGES[from].has(input.to);
	const isSelfLoop = from === input.to;

	if (!isLegalEdge && !isSelfLoop) {
		return { ok: false, reason: 'illegal_edge', from, to: input.to };
	}

	const result = reduce(campaign, input, userId);

	if (Object.keys(result.patch).length > 0) {
		await ctx.db.patch(campaign._id, result.patch as Partial<Doc<'campaigns'>>);
	}
	await applyEffects(ctx, result.effects);

	return {
		ok: true,
		applied: result.applied,
		from,
		to: input.to,
		campaignId: campaign._id,
	};
}

// ─── Public mutations ───────────────────────────────────────────────────────

/**
 * Apply an AB-test-status transition to a Campaign. The only writer of
 * `campaigns.abTestStatus` and its companion fields. Atomic with: row
 * patch + audit-log row.
 *
 * `userId` is the caller identity recorded in the audit log:
 *   - User-facing mutations pass `session.userId`.
 *   - The cross-machine effect from the Campaign lifecycle passes
 *     a `'system:<source>'` tag.
 *
 * Duplicate (`from === to`) returns `applied: 'recorded'` with an
 * audit-log entry but no patch. Illegal transitions return
 * `{ ok: false, reason: 'illegal_edge' }` — never thrown.
 */
export const transition = internalMutation({
	args: {
		campaignId: v.id('campaigns'),
		input: transitionInputValidator,
		userId: v.string(),
	},
	handler: async (ctx, args): Promise<AbTestTransitionOutcome> => {
		const campaign = await ctx.db.get(args.campaignId);
		if (!campaign) return { ok: false, reason: 'campaign_not_found' };
		return await dispatch(ctx, campaign, args.input, args.userId);
	},
});
