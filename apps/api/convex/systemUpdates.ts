/**
 * Previous-release paths of `maintenance/updates.ts`. The System page, the
 * update history card and the app shell in a tab opened before the deploy
 * call `systemUpdates:*` by path, and so does the previous release's
 * `/api/system/update` route, which records the run it starts until its own
 * container is replaced. Each keeps its old path, builder, auth floor,
 * arguments and result shape, and runs the same body as its replacement.
 * Remove after release 0.6.17.
 */
import { platformAdminMutation, platformAdminQuery, publicQuery } from './lib/authedFunctions';
import {
	closeUpdateRun,
	listUpdateRuns,
	markUpdateActivity,
	openUpdateRun,
	readLatestRelease,
	readRolloutActivity,
	readUnfinishedUpdate,
	updateFinishArgs,
	updateHistoryArgs,
	updateStartArgs,
	withdrawUpdateArgs,
	withdrawUpdateRun,
} from './maintenance/updates';

/** Remove after release 0.6.17; this release calls `maintenance/updates:recordUpdateStart`. */
export const recordUpdateStart = platformAdminMutation({
	args: updateStartArgs,
	handler: async (ctx, args, admin) => await openUpdateRun(ctx, args, admin),
});

/** Remove after release 0.6.17; this release calls `maintenance/updates:recordUpdateFinish`. */
export const recordUpdateFinish = platformAdminMutation({
	args: updateFinishArgs,
	handler: async (ctx, args) => await closeUpdateRun(ctx, args),
});

/** Remove after release 0.6.17; this release calls `maintenance/updates:withdrawUpdateStart`. */
export const withdrawUpdateStart = platformAdminMutation({
	args: withdrawUpdateArgs,
	handler: async (ctx, args) => await withdrawUpdateRun(ctx, args),
});

/** Remove after release 0.6.17; this release calls `maintenance/updates:getLatestRelease`. */
export const getLatestRelease = platformAdminQuery({
	args: {},
	handler: async (ctx) => await readLatestRelease(ctx),
});

/** Remove after release 0.6.17; this release calls `maintenance/updates:getUnfinishedUpdate`. */
export const getUnfinishedUpdate = platformAdminQuery({
	args: {},
	handler: async (ctx) => await readUnfinishedUpdate(ctx),
});

/** Remove after release 0.6.17; this release calls `maintenance/updates:recordUpdateActivity`. */
export const recordUpdateActivity = platformAdminMutation({
	args: {},
	handler: async (ctx) => await markUpdateActivity(ctx),
});

/** Remove after release 0.6.17; this release calls `maintenance/updates:getRolloutActivity`. */
// authz: readRolloutActivity answers null unless isActiveOrgMember admits the caller.
// public: the app shell subscribes before it knows the caller is a member; an anonymous or non-member caller gets null instead of an error.
export const getRolloutActivity = publicQuery({
	args: {},
	handler: async (ctx) => await readRolloutActivity(ctx),
});

/** Remove after release 0.6.17; this release calls `maintenance/updates:listUpdateHistory`. */
export const listUpdateHistory = platformAdminQuery({
	args: updateHistoryArgs,
	handler: async (ctx, args) => await listUpdateRuns(ctx, args),
});
