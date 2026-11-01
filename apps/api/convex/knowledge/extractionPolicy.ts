/**
 * What decides whether, and how much, knowledge extraction stores: the
 * `ai.knowledge` flag at run time and the routing policy's
 * per-message entry cap (L7). Used by `knowledge/extraction.ts`; no Convex
 * functions, isolate-safe.
 */

import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { logInfo } from '../lib/runtimeLog';

/**
 * `ai.knowledge` is checked where extraction RUNS, not only where it is
 * scheduled. The Team Inbox pipeline and file processing schedule extraction
 * without reading the flag, and the flag can flip before a scheduled run.
 */
export async function isKnowledgeOn(ctx: ActionCtx, logTag: string): Promise<boolean> {
	if (await ctx.runQuery(internal.mail.migrationIndexing.isKnowledgeEnabled, {})) return true;
	logInfo(`${logTag} skipped: ai.knowledge is off`);
	return false;
}

/**
 * L7: the routing policy's per-message entry cap (`null`, no cap, by default).
 * A cap keeps the most confident entries, in their extracted order. An
 * unreadable policy reads as the default.
 */
export async function capPerMessage<T extends { confidence: number }>(
	ctx: ActionCtx,
	entries: T[]
): Promise<T[]> {
	let cap: number | null = null;
	try {
		cap = (await ctx.runQuery(internal.aiRouting.policy.getResolved, {}))
			.knowledgeEntryCapPerMessage;
	} catch {
		// Today's behaviour: every entry.
	}
	return capExtractedEntries(entries, cap);
}

/** Pure half of {@link capPerMessage}. */
export function capExtractedEntries<T extends { confidence: number }>(
	entries: T[],
	cap: number | null
): T[] {
	if (cap === null || entries.length <= cap) return entries;
	const kept = new Set(
		entries
			.map((entry, index) => ({ entry, index }))
			.sort((a, b) => b.entry.confidence - a.entry.confidence || a.index - b.index)
			.slice(0, cap)
			.map((e) => e.index)
	);
	return entries.filter((_, index) => kept.has(index));
}
