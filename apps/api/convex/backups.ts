/**
 * Previous-release paths of `maintenance/backups.ts`. The Backups page and
 * the Getting Started card in a tab opened before the deploy read and record
 * the backup plan through `backups:*` by path. Each keeps its old path,
 * builder, auth floor, arguments and result shape, and runs the same body as
 * its replacement. Remove after release 0.6.17.
 */
import { v } from 'convex/values';
import { platformAdminMutation, platformAdminQuery } from './lib/authedFunctions';
import { successOrFailedValidator } from './lib/literalValidators';
import { readBackupState, recordManualRun, recordScheduleEnabled } from './maintenance/backups';

/** Remove after release 0.6.17; this release calls `maintenance/backups:getBackupState`. */
export const getBackupState = platformAdminQuery({
	args: {},
	handler: async (ctx) => await readBackupState(ctx),
});

/** Remove after release 0.6.17; this release calls `maintenance/backups:setScheduleEnabled`. */
export const setScheduleEnabled = platformAdminMutation({
	args: { enabled: v.boolean() },
	handler: async (ctx, { enabled }, admin) => await recordScheduleEnabled(ctx, admin, enabled),
});

/** Remove after release 0.6.17; this release calls `maintenance/backups:logManualRun`. */
export const logManualRun = platformAdminMutation({
	args: { status: successOrFailedValidator },
	handler: async (ctx, { status }, admin) => await recordManualRun(ctx, admin, status),
});
