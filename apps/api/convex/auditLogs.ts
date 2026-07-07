import { v } from 'convex/values';
import { adminQuery } from './lib/authedFunctions';
import type { Doc } from './_generated/dataModel';

// Action types for audit logging — re-exported for compat with callers.
// New code should import from lib/auditLog.ts (AuditAction / AuditResource).
export type AuditAction = Doc<'auditLogs'>['action'];
export type AuditResource = Doc<'auditLogs'>['resource'];

// Query: List audit logs with pagination and filtering
export const list = adminQuery({
	args: {
		action: v.optional(v.string()),
		resource: v.optional(v.string()),
		userId: v.optional(v.string()),
		startDate: v.optional(v.number()),
		endDate: v.optional(v.number()),
		limit: v.optional(v.number()),
		cursor: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const limit = args.limit ?? 50;

		// Use the created_at index for date range filtering and ordering
		const baseQuery = ctx.db
			.query('auditLogs')
			.withIndex('by_created_at')
			.order('desc');

		// Apply date and attribute filters at the database level
		const query = baseQuery.filter((q) => {
			const conditions = [];
			if (args.startDate) conditions.push(q.gte(q.field('createdAt'), args.startDate));
			if (args.endDate) conditions.push(q.lte(q.field('createdAt'), args.endDate));
			if (args.action) conditions.push(q.eq(q.field('action'), args.action));
			if (args.resource) conditions.push(q.eq(q.field('resource'), args.resource));
			if (args.userId) conditions.push(q.eq(q.field('userId'), args.userId));
			if (conditions.length === 0) return true;
			if (conditions.length === 1) return conditions[0]!;
			const [first, second, ...rest] = conditions;
			let combined = q.and(first!, second!);
			for (const condition of rest) {
				combined = q.and(combined, condition);
			}
			return combined;
		});

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

// Query: Get a single audit log by ID
export const get = adminQuery({
	args: {
		auditLogId: v.id('auditLogs'),
	},
	handler: async (ctx, args) => {
		const log = await ctx.db.get(args.auditLogId);
		if (!log) return null;

		// Query userProfile by authUserId
		const userProfile = await ctx.db
			.query('userProfiles')
			.withIndex('by_auth_user_id', (q) => q.eq('authUserId', log.userId))
			.first();

		return {
			...log,
			userProfile,
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
		// Default to the last 90 days when the caller didn't bound the
		// query — `auditLogs` accumulates indefinitely, so an unbounded
		// scan grows with deployment age.
		const startDate = args.startDate ?? Date.now() - 90 * 24 * 60 * 60 * 1000;
		const endDate = args.endDate ?? Date.now();

		const logs = await ctx.db
			.query('auditLogs')
			.withIndex('by_created_at', (q) =>
				q.gte('createdAt', startDate).lte('createdAt', endDate)
			)
			.collect(); // bounded: audit logs within the ≤90-day window range

		// Count by resource type
		const byResource: Record<string, number> = {};
		const byAction: Record<string, number> = {};

		for (const log of logs) {
			byResource[log.resource] = (byResource[log.resource] ?? 0) + 1;
			byAction[log.action] = (byAction[log.action] ?? 0) + 1;
		}

		return {
			total: logs.length,
			byResource,
			byAction,
		};
	},
});

// Query: Get distinct users who have performed actions
export const getActiveUsers = adminQuery({
	args: {},
	handler: async (ctx) => {
		// "Active" is bounded to the last 90 days — the filter dropdown
		// in /dashboard/settings/audit only needs users who have been
		// recently active; an all-time scan grows linearly with logs.
		const since = Date.now() - 90 * 24 * 60 * 60 * 1000;
		const logs = await ctx.db
			.query('auditLogs')
			.withIndex('by_created_at', (q) => q.gte('createdAt', since))
			.collect(); // bounded: audit logs within the ≤90-day window range

		// Get unique authUserIds from logs
		const authUserIds = [...new Set(logs.map((log) => log.userId))];

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

// Public + internal mutations for direct audit-log inserts removed:
// callers must go through `recordAuditLog` in lib/auditLog.ts.
// (The previous `create` / `createInternal` mutations were never invoked.)
