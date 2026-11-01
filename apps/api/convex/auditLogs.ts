/**
 * Previous-release paths of `auditActions/logs.ts`. The audit page in a tab
 * opened before the deploy reads the audit log through `auditLogs:*` by path.
 * Each keeps its old path, builder, auth floor, arguments and result shape,
 * and runs the same body as its replacement. Remove after release 0.6.17.
 */
import { adminQuery } from './lib/authedFunctions';
import {
	auditStatsArgs,
	listActiveAuditUsers,
	listAuditLogs,
	listAuditLogsArgs,
	readAuditStats,
} from './auditActions/logs';

/** Remove after release 0.6.17; this release calls `auditActions/logs:list`. */
export const list = adminQuery({
	args: listAuditLogsArgs,
	handler: async (ctx, args) => await listAuditLogs(ctx, args),
});

/** Remove after release 0.6.17; this release calls `auditActions/logs:getStats`. */
export const getStats = adminQuery({
	args: auditStatsArgs,
	handler: async (ctx, args) => await readAuditStats(ctx, args),
});

/** Remove after release 0.6.17; this release calls `auditActions/logs:getActiveUsers`. */
export const getActiveUsers = adminQuery({
	args: {},
	handler: async (ctx) => await listActiveAuditUsers(ctx),
});
