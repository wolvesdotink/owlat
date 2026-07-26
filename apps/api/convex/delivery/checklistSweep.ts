import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { internalAction, type ActionCtx } from '../_generated/server';

type SweepScheduleResult = { done: boolean };

async function schedule(
	ctx: ActionCtx,
	mode: 'daily' | 'hourly',
	cursor: string | null
): Promise<SweepScheduleResult> {
	if (cursor === null) {
		await Promise.allSettled([
			ctx.runAction(internal.delivery.warmingSync.syncWarmingState, {}),
			ctx.runAction(internal.delivery.mtaHealth.sync, {}),
		]);
	}
	return (await ctx.runMutation(internal.delivery.checklistSweepState.schedulePage, {
		mode,
		paginationOpts: { cursor, numItems: 5 },
	})) as SweepScheduleResult;
}

export const runDaily = internalAction({
	args: {},
	handler: async (ctx): Promise<SweepScheduleResult> => schedule(ctx, 'daily', null),
});

export const continueDaily = internalAction({
	args: { cursor: v.string() },
	handler: async (ctx, args): Promise<SweepScheduleResult> => schedule(ctx, 'daily', args.cursor),
});

export const runHourly = internalAction({
	args: {},
	handler: async (ctx): Promise<SweepScheduleResult> => schedule(ctx, 'hourly', null),
});
