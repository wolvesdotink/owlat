/**
 * Backups — self-hosted backup status the dashboard can read and record.
 *
 * WHY THIS IS A RECORD, NOT A LIVE READING
 * ----------------------------------------
 * A self-hosted install schedules backups on the HOST via the CLI
 * (`owlat backup-schedule enable`, which installs a systemd timer or an
 * /etc/cron.d entry that runs `scripts/backup.sh` daily). The Convex backend
 * runs inside a container with no access to the host's systemd/cron or the
 * ./backups directory, so it cannot truthfully report the live schedule or
 * the real last-run timestamp.
 *
 * Rather than fake a reading (which would violate the "never claim a step is
 * done that isn't real" principle), this module stores the OPERATOR's own
 * attestation: a deployment-wide singleton `backupState` row that the platform
 * admin sets from Settings → Backups after running the commands on their
 * server. The panel always shows the exact CLI commands, and every value here
 * is presented as "recorded by you", never as a verified live status.
 *
 * Gating: all UI-facing functions are platform-admin only (requirePlatformAdmin).
 */
import { v } from 'convex/values';
import type { QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { authedMutation, authedQuery } from './lib/authedFunctions';
import { requirePlatformAdmin } from './platformAdmin/platformAdmin';

/**
 * Read the singleton backupState row, if the operator has recorded one.
 * Typed on `QueryCtx` (read-only) so both the query and the mutations — whose
 * `MutationCtx.db` is assignable to the reader — can share it.
 */
async function getState(ctx: QueryCtx): Promise<Doc<'backupState'> | null> {
	return await ctx.db.query('backupState').first();
}

/**
 * Read the operator-recorded backup plan for this deployment.
 *
 * Returns `null` when nothing has been recorded yet (the panel then shows its
 * "no backup plan recorded" empty state). Platform-admin only.
 */
export const getBackupState = authedQuery({
	args: {},
	handler: async (ctx) => {
		await requirePlatformAdmin(ctx);

		const state = await getState(ctx);
		if (!state) return null;

		return {
			scheduleEnabled: state.scheduleEnabled,
			lastRunAt: state.lastRunAt,
			lastRunStatus: state.lastRunStatus,
			updatedAt: state.updatedAt,
			updatedBy: state.updatedBy,
		};
	},
});

/**
 * Record whether the daily backup schedule is installed on the host.
 *
 * The admin flips this AFTER running `owlat backup-schedule enable` (or
 * `disable`) on their server — it is their attestation, not a live check.
 * Platform-admin only.
 */
export const setScheduleEnabled = authedMutation({
	args: { enabled: v.boolean() },
	handler: async (ctx, { enabled }) => {
		const admin = await requirePlatformAdmin(ctx);

		const existing = await getState(ctx);
		const now = Date.now();
		if (existing) {
			await ctx.db.patch(existing._id, {
				scheduleEnabled: enabled,
				updatedAt: now,
				updatedBy: admin.email,
			});
		} else {
			await ctx.db.insert('backupState', {
				scheduleEnabled: enabled,
				updatedAt: now,
				updatedBy: admin.email,
			});
		}

		return { scheduleEnabled: enabled };
	},
});

/**
 * Log a manual backup the operator just ran with `scripts/backup.sh`.
 *
 * Records the run's timestamp and outcome so the panel can show "last backup:
 * recorded by you". Does not (and cannot) trigger the backup itself — the panel
 * surfaces the command to run on the host. Platform-admin only.
 */
export const logManualRun = authedMutation({
	args: { status: v.union(v.literal('success'), v.literal('failed')) },
	handler: async (ctx, { status }) => {
		const admin = await requirePlatformAdmin(ctx);

		const existing = await getState(ctx);
		const now = Date.now();
		if (existing) {
			await ctx.db.patch(existing._id, {
				lastRunAt: now,
				lastRunStatus: status,
				updatedAt: now,
				updatedBy: admin.email,
			});
		} else {
			await ctx.db.insert('backupState', {
				scheduleEnabled: false,
				lastRunAt: now,
				lastRunStatus: status,
				updatedAt: now,
				updatedBy: admin.email,
			});
		}

		return { lastRunAt: now, lastRunStatus: status };
	},
});
