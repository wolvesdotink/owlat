/**
 * Previous-release paths of `maintenance/releaseCheck.ts`. The System page in
 * a tab opened before the deploy checks for updates through
 * `systemUpdatesReleaseCheck:checkForUpdates` by path, and a previous-release
 * check still running when this one deploys reads and writes the release
 * cache through the three internal functions by their old paths. Each keeps
 * its old path, builder, auth floor, arguments and result shape, and runs the
 * same body as its replacement. Remove after release 0.6.17.
 */
import { internalQuery } from './_generated/server';
import { internalMutation } from './lib/writeFence';
import { authedAction } from './lib/authedFunctions';
import {
	cacheCheckFailureArgs,
	cacheLatestReleaseArgs,
	checkForUpdatesArgs,
	checkForUpdatesReturns,
	checkLatestRelease,
	readLatestCheck,
	recordCheckFailure,
	upsertLatestRelease,
} from './maintenance/releaseCheck';

/** Remove after release 0.6.17; this release calls `maintenance/releaseCheck:cacheLatestRelease`. */
export const cacheLatestRelease = internalMutation({
	args: cacheLatestReleaseArgs,
	handler: async (ctx, args) => await upsertLatestRelease(ctx, args),
});

/** Remove after release 0.6.17; this release calls `maintenance/releaseCheck:cacheCheckFailure`. */
export const cacheCheckFailure = internalMutation({
	args: cacheCheckFailureArgs,
	handler: async (ctx, args) => await recordCheckFailure(ctx, args),
});

/** Remove after release 0.6.17; this release calls `maintenance/releaseCheck:getLatestCheckInternal`. */
export const getLatestCheckInternal = internalQuery({
	args: {},
	handler: async (ctx) => await readLatestCheck(ctx),
});

/** Remove after release 0.6.17; this release calls `maintenance/releaseCheck:checkForUpdates`. */
// authz: checkLatestRelease refuses a caller who is not a platform admin
// (isPlatformAdminByUserId) before it reads the cache or polls GitHub.
export const checkForUpdates = authedAction({
	args: checkForUpdatesArgs,
	returns: checkForUpdatesReturns,
	handler: async (ctx, args) => await checkLatestRelease(ctx, args),
});
