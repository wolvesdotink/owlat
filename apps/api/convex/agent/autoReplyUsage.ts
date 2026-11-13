/**
 * The daily auto-reply count of the legacy global fallback (the route step's
 * tier 3, `maxDailyAutoReplies`).
 *
 * It lives in its own singleton row, `agentAutoReplyUsage`, not on
 * `agentConfig`: every Team Inbox thread reader reads `agentConfig`, and the
 * count is written on every autonomous reply.
 *
 * Deployments that counted before this row existed carry the day's count on
 * `agentConfig.dailyAutoReplyCount` / `dailyAutoReplyResetAt`. Until the first
 * reply after the deploy creates the row, those fields are the count, and that
 * first reply carries them over, so the deploy does not reset the day.
 */

import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { nextUtcDayStart } from '../lib/clock';

export interface AutoReplyUsage {
	dailyAutoReplyCount?: number;
	dailyAutoReplyResetAt?: number;
}

async function usageRow(ctx: QueryCtx): Promise<Doc<'agentAutoReplyUsage'> | null> {
	return await ctx.db.query('agentAutoReplyUsage').first();
}

/** The count a deployment kept on `agentConfig` before the usage row existed. */
function legacyUsage(config: Doc<'agentConfig'> | null): AutoReplyUsage {
	return {
		...(config?.dailyAutoReplyCount !== undefined
			? { dailyAutoReplyCount: config.dailyAutoReplyCount }
			: {}),
		...(config?.dailyAutoReplyResetAt !== undefined
			? { dailyAutoReplyResetAt: config.dailyAutoReplyResetAt }
			: {}),
	};
}

/** The current count: the usage row, else what `config` still carries. */
export async function readAutoReplyUsage(
	ctx: QueryCtx,
	config: Doc<'agentConfig'> | null
): Promise<AutoReplyUsage> {
	const row = await usageRow(ctx);
	if (!row) return legacyUsage(config);
	return {
		dailyAutoReplyCount: row.dailyAutoReplyCount,
		dailyAutoReplyResetAt: row.dailyAutoReplyResetAt,
	};
}

/**
 * Count one autonomous reply. A reply after the counted day's end starts a
 * new day at one, ending at the next UTC midnight.
 *
 * Two concurrent replies both read the singleton (or its absence) and write
 * it, so the mutation that commits second conflicts and re-runs on the first
 * one's count: no reply is lost and only one row is ever created.
 */
export async function countAutoReply(ctx: MutationCtx): Promise<void> {
	const now = Date.now();
	const row = await usageRow(ctx);
	const current = row ?? legacyUsage(await ctx.db.query('agentConfig').first());
	const resetAt = current.dailyAutoReplyResetAt ?? 0;
	const isNewDay = now > resetAt;
	const next = {
		dailyAutoReplyCount: isNewDay ? 1 : (current.dailyAutoReplyCount ?? 0) + 1,
		dailyAutoReplyResetAt: isNewDay ? nextUtcDayStart(now) : resetAt,
		updatedAt: now,
	};
	if (row) await ctx.db.patch(row._id, next);
	else await ctx.db.insert('agentAutoReplyUsage', next);
}
