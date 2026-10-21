/**
 * Which language tier a task's call runs on: the
 * resolver (`lib/llmProvider.ts`) asks this module, and this module asks the
 * task-policy catalog (`./taskPolicy.ts`). A call site names its TASK, never a
 * tier of its own choosing; the tier comes from the task's catalog entry.
 *
 *   - {@link taskTier}: the task's usual tier (the first in its `tiers`), or a
 *     tier the call site names for a task that runs on more than one tier
 *     today (clarification samples and judge, a plugin's requested tier).
 *     A tier the catalog does not list for the task is refused: the catalog
 *     is the model eligibility rule.
 *   - {@link userTextTier}: `LLM_COMPLEXITY_ROUTING`'s downgrade of a
 *     capable-tier task to the fast tier for trivially simple OWNER text.
 *     Only a task whose catalog entry allows `fast` downgrades.
 *
 * The values reproduce the routes of 2026-10-11 exactly, call site by call
 * site (`lib/__tests__/resolverCallSites.test.ts` pins the inventory against
 * the tier each site resolved before the catalog existed).
 *
 * Pure and runtime-neutral.
 */

import type { AiTaskName } from '@owlat/shared/aiRouting';
import { taskPolicy, type LlmTier } from './taskPolicy';
import { isTrivialUserText } from './complexity';

export type { LlmTier } from './taskPolicy';

/** A call site's tier choice for a task that runs on more than one tier. */
export interface TierChoice {
	/** Must be one of the task's catalog `tiers`. Absent: the task's usual tier. */
	readonly tier?: LlmTier;
}

/** A task was asked for a tier its catalog entry does not allow, or has no language model. */
export class TaskTierNotEligibleError extends Error {
	/** A routing mistake, not a provider fault: never retried, never a fallback. */
	readonly retriable = false;

	constructor(task: AiTaskName, tier: LlmTier | undefined) {
		super(
			tier === undefined
				? `Task '${task}' does not run on a language model.`
				: `Task '${task}' may not run on the ${tier} tier (lib/llm/taskPolicy.ts).`
		);
		this.name = 'TaskTierNotEligibleError';
	}
}

/** Whether `task` may run on `tier` (its catalog entry lists it). */
export function isTierEligible(task: AiTaskName, tier: LlmTier): boolean {
	const entry = taskPolicy(task);
	return entry.plane !== 'embedding' && entry.tiers.includes(tier);
}

/**
 * The tier a call for `task` runs on: the named one when the catalog allows
 * it, else the task's usual tier. Throws {@link TaskTierNotEligibleError} for
 * a tier the task may not use, and for an embedding task (no language model).
 */
export function taskTier(task: AiTaskName, choice: TierChoice = {}): LlmTier {
	const entry = taskPolicy(task);
	if (entry.plane === 'embedding') throw new TaskTierNotEligibleError(task, undefined);
	const tier = choice.tier ?? entry.tiers[0];
	if (!entry.tiers.includes(tier)) throw new TaskTierNotEligibleError(task, tier);
	return tier;
}

/**
 * `LLM_COMPLEXITY_ROUTING`: a task whose usual tier is capable runs on the
 * fast tier when the routing is on, the catalog allows `fast` for it, and the
 * owner's own text is clearly trivial. Ambiguous text keeps the usual tier.
 * `userText` must be user-controlled text only, never the assembled context.
 */
export function userTextTier(
	task: AiTaskName,
	userText: string,
	isComplexityRoutingOn: boolean
): LlmTier {
	const usual = taskTier(task);
	const downgrade =
		isComplexityRoutingOn &&
		usual === 'capable' &&
		isTierEligible(task, 'fast') &&
		isTrivialUserText(userText);
	return downgrade ? 'fast' : usual;
}
