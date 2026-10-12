/**
 * L9 (AI routing plan): the dispatch input for a task whose prompt is split
 * into stable instructions and per-message content (`promptCache.ts`). The
 * routing policy's `promptCacheTasks` decides whether the task carries a cache
 * marker; it is empty by default, and an unreadable policy reads as empty, so
 * every call sends exactly the single prompt it sent before.
 *
 * What a marker saves is measured from the ledger: the dispatch records the
 * provider's cache read and write tokens on every request row.
 */

import type { ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import type { AiTaskName } from '@owlat/shared/aiRouting';
import { isPromptCacheMarked, promptInputOf, type PromptParts } from './promptCache';

export async function cachedPromptInput(
	ctx: Pick<ActionCtx, 'runQuery'>,
	task: AiTaskName,
	model: unknown,
	parts: PromptParts
): Promise<ReturnType<typeof promptInputOf>> {
	let cacheTasks: readonly string[] = [];
	try {
		cacheTasks = (await ctx.runQuery(internal.aiRouting.policy.getResolved, {})).promptCacheTasks;
	} catch {
		// Today's behaviour: no markers.
	}
	return promptInputOf(parts, isPromptCacheMarked(model, task, cacheTasks));
}
