import type { Infer } from 'convex/values';
import type { MutationCtx } from '../_generated/server';
import {
	auditActionValidator,
	auditResourceValidator,
	jsonPrimitiveRecord,
} from './convexValidators';

export type AuditAction = Infer<typeof auditActionValidator>;
export type AuditResource = Infer<typeof auditResourceValidator>;
export type AuditDetails = Infer<typeof jsonPrimitiveRecord>;

interface RecordAuditLogArgs {
	userId: string;
	organizationId?: string;
	pluginId?: string;
	action: AuditAction;
	resource: AuditResource;
	resourceId?: string;
	/**
	 * Flat scalar payload. For nested change-tracking (e.g. `{ changes: { from, to } }`),
	 * JSON-encode into `detailsBlob` instead — see schema/auth.ts auditLogs.
	 */
	details?: AuditDetails;
	/** Optional JSON-encoded nested payload when `details` (flat scalars) isn't enough. */
	detailsBlob?: string;
	ipAddress?: string;
	userAgent?: string;
}

/**
 * Centralized audit-log writer. ALL audit log inserts must go through this
 * helper — never call `ctx.db.insert('auditLogs', ...)` directly. The helper
 * keeps the action / resource union the single source of truth and gives us
 * one chokepoint to extend later (e.g. async fan-out to an external SIEM,
 * row-level rate limiting, automatic tenant scoping).
 *
 * See apps/api/convex/docs/audit-log-actions.md for the action catalog.
 */
export async function recordAuditLog(ctx: MutationCtx, args: RecordAuditLogArgs): Promise<void> {
	await ctx.db.insert('auditLogs', {
		userId: args.userId,
		organizationId: args.organizationId,
		pluginId: args.pluginId,
		action: args.action,
		resource: args.resource,
		resourceId: args.resourceId,
		details: args.details,
		detailsBlob: args.detailsBlob,
		ipAddress: args.ipAddress,
		userAgent: args.userAgent,
		createdAt: Date.now(),
	});
}
