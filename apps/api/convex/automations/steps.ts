import { v } from 'convex/values';
import { type MutationCtx, type QueryCtx } from '../_generated/server';
import { authedMutation } from '../lib/authedFunctions';
import type { Doc } from '../_generated/dataModel';
import { requireDraftAutomation } from './guards';
import { getOrThrow } from '../_utils/errors';
import { stepConfigValidator } from '../lib/convexValidators';
import { emailStepModule } from './steps/email';
import { delayStepModule } from './steps/delay';
import { conditionStepModule } from './steps/condition';
import type { StepKind, StepModule } from './types';

// ============== Module registry ==============

const STEP_MODULES = {
	email: emailStepModule,
	delay: delayStepModule,
	condition: conditionStepModule,
} as const satisfies {
	[K in StepKind]: StepModule<K, unknown>;
};

export function stepModuleFor<K extends StepKind>(kind: K): (typeof STEP_MODULES)[K] {
	return STEP_MODULES[kind];
}

/**
 * Compute the look-ahead delay (in ms) before scheduling a step.
 * Currently only `delay` implements `entryDelay`; everyone else is 0.
 */
export function computeEntryDelay(step: Doc<'automationSteps'>): number {
	const module = stepModuleFor(step.stepType);
	if (!module.entryDelay) return 0;
	const config = module.parseConfig(step.config);
	return module.entryDelay(config as never);
}

/**
 * Walk a step through its module's optional `enrichForQuery` hook,
 * merging the returned join fields onto the row. Modules without the
 * hook produce `{}` — the step row is returned unchanged. Lets the
 * `getWithRelations` query stay free of `if (step.stepType === ...)`
 * branches.
 */
export async function enrichStepForQuery(
	ctx: Pick<QueryCtx, 'db'>,
	step: Doc<'automationSteps'>
): Promise<Doc<'automationSteps'> & Record<string, unknown>> {
	const module = stepModuleFor(step.stepType);
	if (!module.enrichForQuery) return step;
	try {
		const config = module.parseConfig(step.config);
		const enrichment = await (
			module.enrichForQuery as (
				c: Pick<QueryCtx, 'db'>,
				cfg: unknown
			) => Promise<Record<string, unknown>>
		)(ctx, config);
		return { ...step, ...enrichment };
	} catch {
		// Malformed config — skip enrichment, return the raw row.
		return step;
	}
}

// ============== Condition branch-target remapping ==============

/**
 * Condition steps store their yes/no branch targets as raw step positions
 * (`config.yesBranchStepIndex` / `noBranchStepIndex` — the same numeric space
 * as `automationSteps.stepIndex`, which the walker resolves against). Any
 * structural edit that rewrites `stepIndex` (reorder / remove / insert) must
 * carry those targets along, or a branch silently re-points at whatever step
 * now sits in the old slot — routing contacts down the wrong path with no error.
 *
 * `oldToNew` maps a step's OLD `stepIndex` to its NEW one, or to `null` when the
 * step was deleted (a branch pointing at a deleted step is cleared, so it falls
 * through to "continue to next step"). A target absent from the map is left
 * untouched.
 *
 * Must run on the PRE-edit step rows (their `config` still holds the targets
 * keyed by old indices) before / alongside the `stepIndex` rewrite.
 */
async function remapConditionBranches(
	ctx: MutationCtx,
	steps: Doc<'automationSteps'>[],
	oldToNew: Map<number, number | null>,
	now: number
): Promise<void> {
	const remap = (target: number | null): number | null => {
		if (target === null) return null;
		const mapped = oldToNew.get(target);
		return mapped === undefined ? target : mapped;
	};

	for (const step of steps) {
		if (step.stepType !== 'condition') continue;
		// Condition configs carry `condition` plus the two branch targets; the
		// stepConfigValidator union types `config` loosely, so read the targets
		// off a record view and preserve the rest of the object on patch.
		const config = step.config as Record<string, unknown> & {
			yesBranchStepIndex?: number | null;
			noBranchStepIndex?: number | null;
		};
		const yes = config.yesBranchStepIndex ?? null;
		const no = config.noBranchStepIndex ?? null;
		const nextYes = remap(yes);
		const nextNo = remap(no);
		if (nextYes === yes && nextNo === no) continue;
		await ctx.db.patch(step._id, {
			config: {
				...config,
				yesBranchStepIndex: nextYes,
				noBranchStepIndex: nextNo,
			} as Doc<'automationSteps'>['config'],
			updatedAt: now,
		});
	}
}

// ============== Per-step CRUD mutations ==============
// Convex path: api.automations.steps.{addStep, updateStep, reorderSteps, removeStep}

export const addStep = authedMutation({
	args: {
		automationId: v.id('automations'),
		stepType: v.union(v.literal('email'), v.literal('delay'), v.literal('condition')),
		config: stepConfigValidator,
		insertAtIndex: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		// authz: requireDraftAutomation enforces automations:manage
		// Structure edits are draft-only — editing steps on a live automation
		// would desync in-flight runs that resolve steps by index.
		await requireDraftAutomation(
			ctx,
			args.automationId,
			'add automation steps',
			'Steps can only be added while the automation is a draft'
		);

		const existingSteps = await ctx.db
			.query('automationSteps')
			.withIndex('by_automation', (q) => q.eq('automationId', args.automationId))
			.collect(); // bounded: one automation's steps

		const now = Date.now();
		let stepIndex: number;

		if (args.insertAtIndex !== undefined && args.insertAtIndex < existingSteps.length) {
			stepIndex = args.insertAtIndex;
			// Inserting at `stepIndex` shifts every step at/after it up by one.
			// Carry condition branch targets along so they keep pointing at the
			// same step (the new step has no inbound branches yet).
			const oldToNew = new Map<number, number | null>();
			for (const step of existingSteps) {
				if (step.stepIndex >= stepIndex) {
					oldToNew.set(step.stepIndex, step.stepIndex + 1);
				}
			}
			await remapConditionBranches(ctx, existingSteps, oldToNew, now);
			for (const step of existingSteps) {
				if (step.stepIndex >= stepIndex) {
					await ctx.db.patch(step._id, {
						stepIndex: step.stepIndex + 1,
						updatedAt: now,
					});
				}
			}
		} else {
			stepIndex = existingSteps.length;
		}

		const stepId = await ctx.db.insert('automationSteps', {
			automationId: args.automationId,
			stepIndex,
			stepType: args.stepType,
			config: args.config,
			createdAt: now,
			updatedAt: now,
		});

		await ctx.db.patch(args.automationId, { updatedAt: now });

		return stepId;
	},
});

export const updateStep = authedMutation({
	args: {
		stepId: v.id('automationSteps'),
		stepType: v.optional(v.union(v.literal('email'), v.literal('delay'), v.literal('condition'))),
		config: v.optional(stepConfigValidator),
	},
	handler: async (ctx, args) => {
		const step = await getOrThrow(ctx, args.stepId, 'Automation step');
		// authz: requireDraftAutomation enforces automations:manage
		await requireDraftAutomation(
			ctx,
			step.automationId,
			'update automation steps',
			'Steps can only be edited while the automation is a draft'
		);

		const now = Date.now();
		const updates: Partial<Doc<'automationSteps'>> = { updatedAt: now };

		if (args.stepType !== undefined) updates.stepType = args.stepType;
		if (args.config !== undefined) updates.config = args.config;

		await ctx.db.patch(args.stepId, updates);
		await ctx.db.patch(step.automationId, { updatedAt: now });
	},
});

export const reorderSteps = authedMutation({
	args: {
		automationId: v.id('automations'),
		stepOrder: v.array(v.id('automationSteps')),
	},
	handler: async (ctx, args) => {
		// authz: requireDraftAutomation enforces automations:manage
		await requireDraftAutomation(
			ctx,
			args.automationId,
			'reorder automation steps',
			'Steps can only be reordered while the automation is a draft'
		);

		const now = Date.now();

		// Build the old-index → new-index map from the requested order, then
		// carry every condition step's branch targets along before rewriting
		// `stepIndex`. `stepOrder[i]` is the step that should land at position
		// `i`; its OLD position is its current `stepIndex`.
		const orderedSteps = await Promise.all(args.stepOrder.map((id) => ctx.db.get(id)));
		const oldToNew = new Map<number, number | null>();
		const conditionSteps: Doc<'automationSteps'>[] = [];
		orderedSteps.forEach((step, i) => {
			if (step && step.automationId === args.automationId) {
				oldToNew.set(step.stepIndex, i);
				if (step.stepType === 'condition') conditionSteps.push(step);
			}
		});
		await remapConditionBranches(ctx, conditionSteps, oldToNew, now);

		for (let i = 0; i < args.stepOrder.length; i++) {
			const stepId = args.stepOrder[i];
			if (stepId) {
				await ctx.db.patch(stepId, {
					stepIndex: i,
					updatedAt: now,
				});
			}
		}
		await ctx.db.patch(args.automationId, { updatedAt: now });
	},
});

export const removeStep = authedMutation({
	args: {
		stepId: v.id('automationSteps'),
	},
	handler: async (ctx, args) => {
		const step = await getOrThrow(ctx, args.stepId, 'Automation step');
		// authz: requireDraftAutomation enforces automations:manage
		await requireDraftAutomation(
			ctx,
			step.automationId,
			'remove automation steps',
			'Steps can only be removed while the automation is a draft'
		);

		const automationId = step.automationId;
		const deletedIndex = step.stepIndex;

		await ctx.db.delete(args.stepId);

		const remainingSteps = await ctx.db
			.query('automationSteps')
			.withIndex('by_automation', (q) => q.eq('automationId', automationId))
			.collect(); // bounded: one automation's steps

		const now = Date.now();

		// Deleting a step closes its slot: every step after it shifts down by one,
		// the deleted slot maps to `null` (branches to it are cleared so they fall
		// through to the next step), and earlier slots are unchanged. Remap each
		// remaining condition step's branch targets through that map before the
		// `stepIndex` rewrite — the configs still hold old-index targets here.
		const oldToNew = new Map<number, number | null>();
		oldToNew.set(deletedIndex, null);
		for (const remainingStep of remainingSteps) {
			if (remainingStep.stepIndex > deletedIndex) {
				oldToNew.set(remainingStep.stepIndex, remainingStep.stepIndex - 1);
			}
		}
		await remapConditionBranches(ctx, remainingSteps, oldToNew, now);

		for (const remainingStep of remainingSteps) {
			if (remainingStep.stepIndex > deletedIndex) {
				await ctx.db.patch(remainingStep._id, {
					stepIndex: remainingStep.stepIndex - 1,
					updatedAt: now,
				});
			}
		}
		await ctx.db.patch(automationId, { updatedAt: now });
	},
});
