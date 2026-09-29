import { v } from 'convex/values';
import { adminQuery } from './lib/authedFunctions';
import type { Doc } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { getBetterAuthSessionWithRole } from './lib/sessionOrganization';
import { parsePluginId } from '@owlat/plugin-kit';

// Action types for audit logging — re-exported for compat with callers.
// New code should import from lib/auditLog.ts (AuditAction / AuditResource).
export type AuditAction = Doc<'auditLogs'>['action'];
export type AuditResource = Doc<'auditLogs'>['resource'];

const AUDIT_ANALYTICS_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const AUDIT_ANALYTICS_MAX_ROWS = 5_000;

// Query: List audit logs with pagination and filtering
export const list = adminQuery({
	args: {
		action: v.optional(v.string()),
		resource: v.optional(v.string()),
		userId: v.optional(v.string()),
		pluginId: v.optional(v.string()),
		startDate: v.optional(v.number()),
		endDate: v.optional(v.number()),
		limit: v.optional(v.number()),
		cursor: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const organizationId = await activeAuditOrganizationId(ctx);
		const limit = auditPageLimit(args.limit);
		const pluginId = args.pluginId === undefined ? undefined : parsePluginId(args.pluginId);
		const query = auditLogListQuery(ctx, args, organizationId, pluginId);

		// Cursor pagination via Convex's native paginate(): it seeks past the
		// opaque continuation cursor in the index instead of collecting the
		// whole filtered set and scanning for the cursor _id (which was O(n)
		// per page and would trip the read limit on a large audit log). The
		// cursor is opaque to callers — the frontend just echoes `nextCursor`
		// back as `cursor`, so the response shape is unchanged.
		const result = await query.paginate({ numItems: limit, cursor: args.cursor ?? null });
		const paginatedLogs = result.page;
		const hasMore = !result.isDone;

		// Fetch user profiles for the logs using authUserId
		const authUserIds = [...new Set(paginatedLogs.map((log) => log.userId))];
		const userProfiles = await Promise.all(
			authUserIds.map((authUserId) =>
				ctx.db
					.query('userProfiles')
					.withIndex('by_auth_user_id', (q) => q.eq('authUserId', authUserId))
					.first()
			)
		);
		const userProfileMap = new Map(
			userProfiles.filter(Boolean).map((profile) => [profile!.authUserId, profile])
		);

		// Add user profile data to logs
		const logsWithUsers = paginatedLogs.map((log) => ({
			...log,
			userProfile: userProfileMap.get(log.userId) ?? null,
		}));

		return {
			logs: logsWithUsers,
			nextCursor: hasMore ? result.continueCursor : null,
			hasMore,
		};
	},
});

// Query: Get audit log stats (counts by action type)
export const getStats = adminQuery({
	args: {
		startDate: v.optional(v.number()),
		endDate: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const organizationId = await activeAuditOrganizationId(ctx);
		// Default to the last 90 days when the caller didn't bound the
		// query — `auditLogs` accumulates indefinitely, so an unbounded
		// scan grows with deployment age.
		const endDate = args.endDate ?? Date.now();
		const startDate = Math.max(
			args.startDate ?? endDate - AUDIT_ANALYTICS_WINDOW_MS,
			endDate - AUDIT_ANALYTICS_WINDOW_MS
		);

		const logs = await loadAuditAnalyticsWindow(ctx, organizationId, startDate, endDate);

		// Count by resource type
		const byResource: Record<string, number> = {};
		const byAction: Record<string, number> = {};

		for (const log of logs) {
			if (log.organizationId !== undefined && log.organizationId !== organizationId) continue;
			byResource[log.resource] = (byResource[log.resource] ?? 0) + 1;
			byAction[log.action] = (byAction[log.action] ?? 0) + 1;
		}

		return {
			total: Object.values(byAction).reduce((total, count) => total + count, 0),
			byResource,
			byAction,
		};
	},
});

// Query: Get distinct users who have performed actions
export const getActiveUsers = adminQuery({
	args: {},
	handler: async (ctx) => {
		const organizationId = await activeAuditOrganizationId(ctx);
		// "Active" is bounded to the last 90 days — the filter dropdown
		// in /dashboard/admin/team/audit only needs users who have been
		// recently active; an all-time scan grows linearly with logs.
		const now = Date.now();
		const since = now - AUDIT_ANALYTICS_WINDOW_MS;
		const logs = await loadAuditAnalyticsWindow(ctx, organizationId, since, now);

		// Get unique authUserIds from logs
		const authUserIds = [
			...new Set(
				logs
					.filter(
						(log) => log.organizationId === undefined || log.organizationId === organizationId
					)
					.map((log) => log.userId)
			),
		];

		// Query userProfiles by authUserId, keeping the authUserId paired so the
		// filter dropdown can send it. The audit-log `userId` column stores the
		// BetterAuth authUserId, so filtering must use authUserId — not the
		// userProfiles _id (which never equals it).
		const resolved = await Promise.all(
			authUserIds.map(async (authUserId) => ({
				authUserId,
				profile: await ctx.db
					.query('userProfiles')
					.withIndex('by_auth_user_id', (q) => q.eq('authUserId', authUserId))
					.first(),
			}))
		);

		return resolved
			.filter((r) => r.profile)
			.map((r) => ({
				_id: r.profile!._id,
				authUserId: r.authUserId,
				name: r.profile!.name,
				email: r.profile!.email,
			}));
	},
});

interface AuditListFilters {
	action?: string;
	resource?: string;
	userId?: string;
	startDate?: number;
	endDate?: number;
}

/**
 * The newest-first read behind `list`. The date window rides the index range
 * on every path, and a userId or action filter seeks its own compound index,
 * so a narrow filter over a long audit history reads the matching rows rather
 * than paging through every row and dropping most of them (plan C10).
 *
 *   - `pluginId`: seek the plugin's rows within the authenticated tenant.
 *   - otherwise `userId`, then `action`, then the bare `createdAt` order. These
 *     also keep legacy instance-global core rows whose organizationId predates
 *     explicit attribution, so the tenant test stays in the filter.
 *
 * Whatever the chosen index does not cover (resource, the second of userId and
 * action, the tenant test) stays in `.filter()`. A falsy bound means "open",
 * as it always has.
 */
export function auditLogListQuery(
	ctx: Pick<QueryCtx, 'db'>,
	args: AuditListFilters,
	organizationId: string,
	pluginId: string | undefined
) {
	const from = args.startDate || Number.MIN_SAFE_INTEGER;
	const to = args.endDate || Number.MAX_SAFE_INTEGER;
	const table = ctx.db.query('auditLogs');
	let seekedUser = false;
	let seekedAction = false;
	let base;
	if (pluginId !== undefined) {
		base = table.withIndex('by_organization_id_and_plugin_id_and_created_at', (q) =>
			q
				.eq('organizationId', organizationId)
				.eq('pluginId', pluginId)
				.gte('createdAt', from)
				.lte('createdAt', to)
		);
	} else if (args.userId) {
		const userId = args.userId;
		seekedUser = true;
		base = table.withIndex('by_user_and_created_at', (q) =>
			q.eq('userId', userId).gte('createdAt', from).lte('createdAt', to)
		);
	} else if (args.action) {
		// The column is a literal union; an unknown string simply matches nothing.
		const action = args.action as Doc<'auditLogs'>['action'];
		seekedAction = true;
		base = table.withIndex('by_action_and_created_at', (q) =>
			q.eq('action', action).gte('createdAt', from).lte('createdAt', to)
		);
	} else {
		base = table.withIndex('by_created_at', (q) => q.gte('createdAt', from).lte('createdAt', to));
	}

	return base.order('desc').filter((q) => {
		const conditions = [];
		if (args.action && !seekedAction) conditions.push(q.eq(q.field('action'), args.action));
		if (args.resource) conditions.push(q.eq(q.field('resource'), args.resource));
		if (args.userId && !seekedUser) conditions.push(q.eq(q.field('userId'), args.userId));
		if (pluginId === undefined) {
			conditions.push(
				q.or(
					q.eq(q.field('organizationId'), organizationId),
					q.eq(q.field('organizationId'), undefined)
				)
			);
		}
		if (conditions.length === 0) return true;
		if (conditions.length === 1) return conditions[0]!;
		const [first, second, ...rest] = conditions;
		let combined = q.and(first!, second!);
		for (const condition of rest) {
			combined = q.and(combined, condition);
		}
		return combined;
	});
}

async function activeAuditOrganizationId(ctx: Parameters<typeof getBetterAuthSessionWithRole>[0]) {
	const session = await getBetterAuthSessionWithRole(ctx);
	if (!session?.activeOrganizationId || !session.role) {
		throw new Error('Audit organization unavailable');
	}
	return session.activeOrganizationId;
}

function auditPageLimit(value: number | undefined): number {
	const limit = value ?? 50;
	if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Invalid audit page limit');
	return Math.min(limit, 100);
}

/**
 * Seek the active tenant and legacy singleton rows independently, then retain
 * the newest bounded union. Fetching at most the cap from either index is
 * sufficient to determine the newest cap across both streams and prevents a
 * busy plugin cron from exhausting Convex's document-read limit.
 */
async function loadAuditAnalyticsWindow(
	ctx: QueryCtx,
	organizationId: string,
	startDate: number,
	endDate: number
): Promise<Doc<'auditLogs'>[]> {
	if (startDate > endDate) return [];
	const queryForOrganization = (scope: string | undefined) =>
		ctx.db
			.query('auditLogs')
			.withIndex('by_organization_id_and_created_at', (q) =>
				q.eq('organizationId', scope).gte('createdAt', startDate).lte('createdAt', endDate)
			)
			.order('desc')
			.take(AUDIT_ANALYTICS_MAX_ROWS);
	const [tenantRows, legacyRows] = await Promise.all([
		queryForOrganization(organizationId),
		queryForOrganization(undefined),
	]);
	return [...tenantRows, ...legacyRows]
		.sort((left, right) => right.createdAt - left.createdAt)
		.slice(0, AUDIT_ANALYTICS_MAX_ROWS);
}

// Public + internal mutations for direct audit-log inserts removed:
// callers must go through `recordAuditLog` in lib/auditLog.ts.
// (The previous `create` / `createInternal` mutations were never invoked.)
