/**
 * Persistence + read surface for signed-hook DELIVERY LOGS (Tier 2, PP-25).
 *
 * V8 runtime (queries/mutations; no Node). Three responsibilities:
 *   - `_recordHookDelivery` (internal): the Node hook runtime folds every
 *     `invokeHook` resolution into a redacted, tenant-scoped row. Best-effort —
 *     the runtime never lets a logging fault change a hook's outcome.
 *   - `listHookDeliveryLogs` (operator): a bounded, indexed, org-scoped read with
 *     app / kind / source filters, projected through {@link toPublicHookDeliveryLog}.
 *   - `_cleanupHookDeliveryLogs` (internal): weekly retention that ages rows out
 *     at AUDIT_LOG_RETENTION_MS in batches, mirroring the webhook-log cleanup.
 *
 * Redaction is enforced at the schema: there is no column for payload, app text,
 * secret, or signature, so no row and no projection can leak them.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { internalMutation } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { authedQuery } from '../lib/authedFunctions';
import { requireOrgPermission } from '../lib/sessionOrganization';
import {
	AUDIT_LOG_RETENTION_MS,
	CONNECTED_APP_HOOK_LOG_CLEANUP_BATCH_SIZE,
	CONNECTED_APP_HOOK_LOG_DEFAULT_LIMIT,
	CONNECTED_APP_HOOK_LOG_MAX_LIMIT,
	CONNECTED_APP_HOOK_LOG_SCAN_CAP,
} from '../lib/constants';
import type { HookUnavailableCode } from './hookOutcome';
import type { ConnectedAppHookKind } from './hookProtocol';
import {
	hookDeliveryKindValidator,
	hookDeliverySourceValidator,
	hookUnavailableCodeValidator,
} from './hookDeliveryLog';

type HookDeliverySource = 'app' | 'fallback';

/**
 * Record one hook delivery. Internal-only: the Node runtime calls it in a system
 * context after resolving a hook. Every field is non-sensitive metadata — the
 * schema has no room for content or secrets, so this can never persist them.
 */
export const _recordHookDelivery = internalMutation({
	args: {
		organizationId: v.string(),
		connectedAppId: v.id('connectedApps'),
		pluginId: v.optional(v.string()),
		hookKind: hookDeliveryKindValidator,
		isAttempted: v.boolean(),
		source: hookDeliverySourceValidator,
		failureCode: v.optional(hookUnavailableCodeValidator),
		durationMs: v.optional(v.number()),
		attemptedAt: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args): Promise<null> => {
		await ctx.db.insert('connectedAppHookDeliveryLogs', {
			organizationId: args.organizationId,
			connectedAppId: args.connectedAppId,
			...(args.pluginId === undefined ? {} : { pluginId: args.pluginId }),
			hookKind: args.hookKind,
			isAttempted: args.isAttempted,
			source: args.source,
			...(args.failureCode === undefined ? {} : { failureCode: args.failureCode }),
			...(args.durationMs === undefined ? {} : { durationMs: args.durationMs }),
			attemptedAt: args.attemptedAt,
		});
		return null;
	},
});

/** The client-facing shape of a delivery log: redacted metadata only. */
export interface PublicHookDeliveryLog {
	readonly _id: Id<'connectedAppHookDeliveryLogs'>;
	readonly _creationTime: number;
	readonly connectedAppId: Id<'connectedApps'>;
	readonly pluginId?: string;
	readonly hookKind: ConnectedAppHookKind;
	readonly isAttempted: boolean;
	readonly source: HookDeliverySource;
	readonly failureCode?: HookUnavailableCode;
	readonly durationMs?: number;
	readonly attemptedAt: number;
}

/**
 * Project a stored row to its client-facing shape. The row carries no sensitive
 * columns by construction; this is the single read projection so the surface
 * stays stable and obviously redaction-safe (mirrors `toPublicConnectedApp`).
 */
export function toPublicHookDeliveryLog(
	row: Doc<'connectedAppHookDeliveryLogs'>
): PublicHookDeliveryLog {
	return {
		_id: row._id,
		_creationTime: row._creationTime,
		connectedAppId: row.connectedAppId,
		...(row.pluginId === undefined ? {} : { pluginId: row.pluginId }),
		hookKind: row.hookKind,
		isAttempted: row.isAttempted,
		source: row.source,
		...(row.failureCode === undefined ? {} : { failureCode: row.failureCode }),
		...(row.durationMs === undefined ? {} : { durationMs: row.durationMs }),
		attemptedAt: row.attemptedAt,
	};
}

/** Clamp a caller-supplied page size to the bounded [1, MAX] range. */
function clampLimit(limit: number | undefined): number {
	if (limit === undefined) return CONNECTED_APP_HOOK_LOG_DEFAULT_LIMIT;
	const floored = Math.floor(limit);
	if (!Number.isFinite(floored) || floored < 1) return CONNECTED_APP_HOOK_LOG_DEFAULT_LIMIT;
	return Math.min(floored, CONNECTED_APP_HOOK_LOG_MAX_LIMIT);
}

interface LogFilters {
	readonly connectedAppId?: Id<'connectedApps'>;
	readonly hookKind?: ConnectedAppHookKind;
	readonly source?: HookDeliverySource;
}

/**
 * Scan the most selective index for the given filters — one app, one source, one
 * kind, or the whole org — newest first, up to SCAN_CAP rows. Every index arm
 * fixes `organizationId`, so a read can only ever see the caller's own tenant.
 * The app filter wins when combined (its index is the most selective); source and
 * kind each have a dedicated index so a sole/primary filter of either is
 * index-complete, never scan-cap-lossy.
 */
async function scanRecentLogs(
	ctx: QueryCtx,
	organizationId: string,
	filters: LogFilters
): Promise<Doc<'connectedAppHookDeliveryLogs'>[]> {
	if (filters.connectedAppId !== undefined) {
		const appId = filters.connectedAppId;
		return ctx.db
			.query('connectedAppHookDeliveryLogs')
			.withIndex('by_org_app_and_time', (index) =>
				index.eq('organizationId', organizationId).eq('connectedAppId', appId)
			)
			.order('desc')
			.take(CONNECTED_APP_HOOK_LOG_SCAN_CAP);
	}
	if (filters.source !== undefined) {
		const source = filters.source;
		return ctx.db
			.query('connectedAppHookDeliveryLogs')
			.withIndex('by_org_source_and_time', (index) =>
				index.eq('organizationId', organizationId).eq('source', source)
			)
			.order('desc')
			.take(CONNECTED_APP_HOOK_LOG_SCAN_CAP);
	}
	if (filters.hookKind !== undefined) {
		const hookKind = filters.hookKind;
		return ctx.db
			.query('connectedAppHookDeliveryLogs')
			.withIndex('by_org_kind_and_time', (index) =>
				index.eq('organizationId', organizationId).eq('hookKind', hookKind)
			)
			.order('desc')
			.take(CONNECTED_APP_HOOK_LOG_SCAN_CAP);
	}
	return ctx.db
		.query('connectedAppHookDeliveryLogs')
		.withIndex('by_org_and_time', (index) => index.eq('organizationId', organizationId))
		.order('desc')
		.take(CONNECTED_APP_HOOK_LOG_SCAN_CAP);
}

/**
 * List the active organization's hook delivery logs, newest first. Owner/admin
 * only (the same gate as viewing connected apps). Bounded, indexed, and
 * tenant-isolated; `connectedAppId`, `hookKind`, and `source` narrow the result.
 */
export const listHookDeliveryLogs = authedQuery({
	args: {
		connectedAppId: v.optional(v.id('connectedApps')),
		hookKind: v.optional(hookDeliveryKindValidator),
		source: v.optional(hookDeliverySourceValidator),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<PublicHookDeliveryLog[]> => {
		const { activeOrganizationId } = await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can view connected-app hook delivery logs'
		);
		const limit = clampLimit(args.limit);
		const filters: LogFilters = {
			...(args.connectedAppId === undefined ? {} : { connectedAppId: args.connectedAppId }),
			...(args.hookKind === undefined ? {} : { hookKind: args.hookKind }),
			...(args.source === undefined ? {} : { source: args.source }),
		};
		const recent = await scanRecentLogs(ctx, activeOrganizationId, filters);
		const matched: PublicHookDeliveryLog[] = [];
		for (const row of recent) {
			// Whichever single index `scanRecentLogs` chose already narrows one
			// dimension; re-check the other two in JS so a combined filter (e.g. app +
			// source, or app + kind) still narrows. Each re-check is a no-op for the
			// dimension its own index already backed.
			if (filters.hookKind !== undefined && row.hookKind !== filters.hookKind) continue;
			if (filters.source !== undefined && row.source !== filters.source) continue;
			matched.push(toPublicHookDeliveryLog(row));
			if (matched.length >= limit) break;
		}
		return matched;
	},
});

/**
 * Retention: delete hook delivery logs older than AUDIT_LOG_RETENTION_MS in
 * batches, rescheduling itself while a full batch is drained. Wired to a weekly
 * cron in crons.ts, mirroring `webhooks/cleanup.cleanupOldLogs`.
 */
export const _cleanupHookDeliveryLogs = internalMutation({
	args: {},
	returns: v.object({ deletedCount: v.number() }),
	handler: async (ctx): Promise<{ deletedCount: number }> => {
		const cutoff = Date.now() - AUDIT_LOG_RETENTION_MS;
		const old = await ctx.db
			.query('connectedAppHookDeliveryLogs')
			.withIndex('by_attempted_at', (index) => index.lt('attemptedAt', cutoff))
			.take(CONNECTED_APP_HOOK_LOG_CLEANUP_BATCH_SIZE);

		for (const row of old) {
			await ctx.db.delete(row._id);
		}

		if (old.length === CONNECTED_APP_HOOK_LOG_CLEANUP_BATCH_SIZE) {
			await ctx.scheduler.runAfter(
				0,
				internal.connectedApps.hookDeliveryLogStore._cleanupHookDeliveryLogs,
				{}
			);
		}
		return { deletedCount: old.length };
	},
});
