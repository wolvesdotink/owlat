import { v } from 'convex/values';
import { authedQuery } from '../lib/authedFunctions';
import { requirePlatformAdmin } from './platformAdmin';
import { summarize } from '../analytics/sendingReputation';

/**
 * List instance status if flagged for abuse (high/critical risk or warned/suspended status).
 */
export const listFlaggedOrganizations = authedQuery({
	args: {},
	handler: async (ctx) => {
		await requirePlatformAdmin(ctx);

		// Get instance settings (singleton)
		const settings = await ctx.db.query('instanceSettings').first();
		if (!settings) return [];

		// Rolling 30-day org reputation, derived on read (no longer the stale
		// "latest bucket" cache).
		const reputation = await summarize(ctx.db, { kind: 'org' });

		const status = settings.abuseStatus;
		const riskLevel = reputation.riskLevel;

		const isFlagged =
			status === 'warned' ||
			status === 'suspended' ||
			status === 'banned' ||
			riskLevel === 'high' ||
			riskLevel === 'critical';

		if (!isFlagged) return [];

		return [
			{
				abuseStatus: settings.abuseStatus || 'clean',
				abuseStatusReason: settings.abuseStatusReason,
				abuseStatusChangedAt: settings.abuseStatusChangedAt,
				createdAt: settings.createdAt,
				// Reputation data
				riskLevel: reputation.riskLevel,
				bounceRate: reputation.bounceRate,
				complaintRate: reputation.complaintRate,
				totalSent: reputation.totalSent,
				totalBounced: reputation.totalBounced,
				totalComplaints: reputation.totalComplaints,
			},
		];
	},
});

/**
 * Get detailed instance information for admin review.
 */
export const getOrganizationDetail = authedQuery({
	args: {},
	handler: async (ctx) => {
		await requirePlatformAdmin(ctx);

		// Get instance settings
		const settings = await ctx.db
			.query('instanceSettings')
			.first();

		if (!settings) return null;

		// Rolling 30-day org reputation, derived on read. The latest bucket is
		// fetched only for presence (null when the org has never sent) and its
		// `lastCalculatedAt` timestamp.
		const reputationSummary = await summarize(ctx.db, { kind: 'org' });
		const latestBucket = await ctx.db
			.query('sendingReputation')
			.withIndex('by_scope_domain_period_shard', (q) => q.eq('scope', 'org'))
			.order('desc')
			.first();

		// Get recent content scan results
		const scanResults = await ctx.db
			.query('contentScanResults')
			.order('desc')
			.take(20);

		// Get blocked email counts via `by_reason` index. Each .collect() is
		// bounded to one reason class — far smaller than the global table.
		const [bouncedRows, complainedRows, manualRows] = await Promise.all([
			ctx.db
				.query('blockedEmails')
				.withIndex('by_reason', (q) => q.eq('reason', 'bounced'))
				.collect(), // bounded: per-reason slice
			ctx.db
				.query('blockedEmails')
				.withIndex('by_reason', (q) => q.eq('reason', 'complained'))
				.collect(), // bounded: per-reason slice
			ctx.db
				.query('blockedEmails')
				.withIndex('by_reason', (q) => q.eq('reason', 'manual'))
				.collect(), // bounded: per-reason slice (admin-curated)
		]);

		const blockedCounts = {
			total: bouncedRows.length + complainedRows.length + manualRows.length,
			bounced: bouncedRows.length,
			complained: complainedRows.length,
			manual: manualRows.length,
		};

		// Get recent campaigns
		const recentCampaigns = await ctx.db
			.query('campaigns')
			.order('desc')
			.take(10);

		return {
			settings: {
				abuseStatus: settings.abuseStatus || 'clean',
				abuseStatusReason: settings.abuseStatusReason,
				abuseStatusChangedAt: settings.abuseStatusChangedAt,
				abuseStatusChangedBy: settings.abuseStatusChangedBy,
				dailySendCount: settings.dailySendCount || 0,
		createdAt: settings.createdAt,
				contactCount: settings.contactCount || 0,
			},
			reputation: latestBucket
				? {
					riskLevel: reputationSummary.riskLevel,
					bounceRate: reputationSummary.bounceRate,
					complaintRate: reputationSummary.complaintRate,
					totalSent: reputationSummary.totalSent,
					totalDelivered: reputationSummary.totalDelivered,
					totalBounced: reputationSummary.totalBounced,
					totalHardBounced: reputationSummary.totalHardBounced,
					totalComplaints: reputationSummary.totalComplaints,
					lastCalculatedAt: latestBucket.lastCalculatedAt,
				}
				: null,
			blockedCounts,
			scanResults: scanResults.map((r) => ({
				resourceType: r.resourceType,
				resourceId: r.resourceId,
				score: r.score,
				level: r.level,
				flags: r.flags,
				scannedAt: r.scannedAt,
			})),
			recentCampaigns: recentCampaigns.map((c) => ({
				id: c._id,
				name: c.name,
				status: c.status,
				statsSent: c.statsSent,
				statsBounced: c.statsBounced,
				sentAt: c.sentAt,
				updatedAt: c.updatedAt,
			})),
		};
	},
});

/**
 * List recent abuse-related events across all organizations.
 */
export const listRecentAbuse = authedQuery({
	args: {},
	handler: async (ctx) => {
		await requirePlatformAdmin(ctx);

		// Get recent content scan results that are suspicious or blocked
		const recentScans = await ctx.db
			.query('contentScanResults')
			.order('desc')
			.take(50);

		const flaggedScans = recentScans.filter(
			(s) => s.level === 'suspicious' || s.level === 'blocked'
		);

		// Get pending review campaigns
		const pendingCampaigns = await ctx.db
			.query('campaigns')
			.withIndex('by_status', (q) => q.eq('status', 'pending_review'))
			.collect(); // bounded: review queue only

		return {
			flaggedScans: flaggedScans.map((s) => ({
				resourceType: s.resourceType,
				resourceId: s.resourceId,
				score: s.score,
				level: s.level,
				scannedAt: s.scannedAt,
			})),
			pendingReview: pendingCampaigns.map((c) => ({
				id: c._id,
				name: c.name,
				subject: c.subject,
				updatedAt: c.updatedAt,
			})),
		};
	},
});

/**
 * Aggregate platform-wide statistics.
 */
export const getPlatformStats = authedQuery({
	args: {},
	handler: async (ctx) => {
		await requirePlatformAdmin(ctx);

		const settings = await ctx.db.query('instanceSettings').first();

		// Rolling 30-day org reputation, derived on read. (This previously read
		// a single day's bucket; it now reports the 30-day window like every
		// other reader — ADR-0042.)
		const reputation = await summarize(ctx.db, { kind: 'org' });

		const totalContacts = settings?.contactCount || 0;
		const abuseStatus = settings?.abuseStatus || 'clean';

		// Aggregate reputation
		const totalSent = reputation.totalSent;
		const totalDelivered = reputation.totalDelivered;
		const totalBounced = reputation.totalBounced;
		const totalComplaints = reputation.totalComplaints;

		const bounceRate = reputation.bounceRate;
		const complaintRate = reputation.complaintRate;
		const deliveryRate = totalSent > 0 ? totalDelivered / totalSent : 0;

		// Recent signups (user profiles created in last 30 days, grouped by day).
		// Range-scan on `by_creation_time` replaces the previous full-table scan.
		const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
		const recentProfiles = await ctx.db
			.query('userProfiles')
			.withIndex('by_creation_time', (q) => q.gte('_creationTime', thirtyDaysAgo))
			.collect(); // bounded: 30-day window

		const signupsByDay: Record<string, number> = {};
		for (const p of recentProfiles) {
			const day = new Date(p.createdAt).toISOString().split('T')[0]!;
			signupsByDay[day] = (signupsByDay[day] || 0) + 1;
		}

		return {
			totalContacts,
			abuseStatus,
			sending: {
				totalSent,
				totalDelivered,
				totalBounced,
				totalComplaints,
				bounceRate,
				complaintRate,
				deliveryRate,
			},
			signupsByDay,
		};
	},
});

/**
 * Get instance settings with metrics.
 */
export const listAllOrganizations = authedQuery({
	args: {
		search: v.optional(v.string()),
		statusFilter: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		await requirePlatformAdmin(ctx);

		const settings = await ctx.db.query('instanceSettings').first();
		if (!settings) return [];

		// Rolling 30-day org reputation, derived on read.
		const reputation = await summarize(ctx.db, { kind: 'org' });

		const entry = {
			abuseStatus: settings.abuseStatus || 'clean',
			abuseStatusReason: settings.abuseStatusReason,
			contactCount: settings.contactCount || 0,
			createdAt: settings.createdAt,
			defaultFromName: settings.defaultFromName,
			defaultFromEmail: settings.defaultFromEmail,
			riskLevel: reputation.riskLevel,
			bounceRate: reputation.bounceRate,
			complaintRate: reputation.complaintRate,
			totalSent: reputation.totalSent,
			totalBounced: reputation.totalBounced,
		};

		// Apply filters
		if (args.statusFilter && entry.abuseStatus !== args.statusFilter) {
			return [];
		}
		if (args.search) {
			const searchLower = args.search.toLowerCase();
			const matchesSearch =
				(entry.defaultFromName || '').toLowerCase().includes(searchLower) ||
				(entry.defaultFromEmail || '').toLowerCase().includes(searchLower);
			if (!matchesSearch) return [];
		}

		return [entry];
	},
});

/**
 * List all platform admins.
 */
export const listPlatformAdmins = authedQuery({
	args: {},
	handler: async (ctx) => {
		await requirePlatformAdmin(ctx);

		const admins = await ctx.db.query('platformAdmins').collect(); // bounded: super-admin roster, low-tens at most

		return admins
			.map((a) => ({
				id: a._id,
				authUserId: a.authUserId,
				email: a.email,
				role: a.role,
				createdAt: a.createdAt,
			}))
			.sort((a, b) => a.createdAt - b.createdAt);
	},
});

/**
 * List all users with search filtering.
 */
export const listAllUsers = authedQuery({
	args: {
		search: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		await requirePlatformAdmin(ctx);

		// bounded: single-org membership; in a real deployment this is dozens.
		// If a deployment scales to thousands of users we should switch to
		// pagination at the UI layer.
		let users = await ctx.db.query('userProfiles').order('desc').collect();

		if (args.search) {
			const searchLower = args.search.toLowerCase();
			users = users.filter(
				(u) =>
					u.email.toLowerCase().includes(searchLower) ||
					(u.name || '').toLowerCase().includes(searchLower)
			);
		}

		return users.map((u) => ({
			id: u._id,
			authUserId: u.authUserId,
			email: u.email,
			name: u.name,
			image: u.image,
			createdAt: u.createdAt,
			updatedAt: u.updatedAt,
		}));
	},
});

/**
 * Get delivery statistics including active campaigns and aggregate metrics.
 */
export const getDeliveryStats = authedQuery({
	args: {},
	handler: async (ctx) => {
		await requirePlatformAdmin(ctx);

		// Get campaigns currently sending — via index, bounded by in-flight count.
		const sendingCampaigns = await ctx.db
			.query('campaigns')
			.withIndex('by_status', (q) => q.eq('status', 'sending'))
			.collect(); // bounded: in-flight campaigns only

		// Get scheduled campaigns — via index, bounded by scheduling queue.
		const scheduledCampaigns = await ctx.db
			.query('campaigns')
			.withIndex('by_status', (q) => q.eq('status', 'scheduled'))
			.collect(); // bounded: scheduled queue only

		// Rolling 30-day org reputation for delivery metrics, derived on read.
		const reputation = await summarize(ctx.db, { kind: 'org' });

		const totalSent = reputation.totalSent;
		const totalDelivered = reputation.totalDelivered;
		const totalBounced = reputation.totalBounced;
		const totalHardBounced = reputation.totalHardBounced;
		const totalComplaints = reputation.totalComplaints;

		// Get recent blocked emails (last 7 days) — `by_creation_time` is an
		// implicit Convex index, so a range scan replaces the previous full-
		// table `.collect()` followed by in-memory filter.
		const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
		const recentBlocked = await ctx.db
			.query('blockedEmails')
			.withIndex('by_creation_time', (q) => q.gte('_creationTime', sevenDaysAgo))
			.collect(); // bounded: 7-day window
		const recentBlockedCount = recentBlocked.length;
		const blockedByReason: Record<string, number> = {};
		for (const b of recentBlocked) {
			blockedByReason[b.reason] = (blockedByReason[b.reason] || 0) + 1;
		}

		return {
			activeSending: sendingCampaigns.map((c) => ({
				id: c._id,
				name: c.name,
				subject: c.subject,
				statsSent: c.statsSent || 0,
				statsBounced: c.statsBounced || 0,
				updatedAt: c.updatedAt,
			})),
			scheduledCount: scheduledCampaigns.length,
			scheduledCampaigns: scheduledCampaigns.slice(0, 10).map((c) => ({
				id: c._id,
				name: c.name,
				scheduledAt: c.scheduledAt,
			})),
			aggregateStats: {
				totalSent,
				totalDelivered,
				totalBounced,
				totalHardBounced,
				totalComplaints,
				deliveryRate: totalSent > 0 ? totalDelivered / totalSent : 0,
				bounceRate: totalSent > 0 ? totalBounced / totalSent : 0,
				complaintRate: totalSent > 0 ? totalComplaints / totalSent : 0,
			},
			recentBlocked: {
				count: recentBlockedCount,
				byReason: blockedByReason,
			},
		};
	},
});

/**
 * List all domains with filtering and search.
 */
export const listAllDomains = authedQuery({
	args: {
		statusFilter: v.optional(v.string()),
		search: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		await requirePlatformAdmin(ctx);

		// Narrow to the requested status via index before any in-memory work.
		const statusValues = ['registering', 'pending', 'verified', 'failed'] as const;
		let domains;
		if (args.statusFilter && (statusValues as readonly string[]).includes(args.statusFilter)) {
			domains = await ctx.db
				.query('domains')
				.withIndex('by_status', (q) => q.eq('status', args.statusFilter as typeof statusValues[number]))
				.collect();
		} else {
			domains = await ctx.db.query('domains').collect();
		}

		if (args.search) {
			const searchLower = args.search.toLowerCase();
			domains = domains.filter(
				(d) => d.domain.toLowerCase().includes(searchLower)
			);
		}

		return domains
			.map((d) => ({
				id: d._id,
				domain: d.domain,
				status: d.status,
				verifiedAt: d.verifiedAt,
				lastVerifiedAt: d.lastVerifiedAt,
				createdAt: d.createdAt,
				updatedAt: d.updatedAt,
			}))
			.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
	},
});

/**
 * Get content review queue with pending campaigns and transactional emails.
 */
export const getContentReviewQueue = authedQuery({
	args: {
		filter: v.optional(v.string()),
	},
	handler: async (ctx, _args) => {
		await requirePlatformAdmin(ctx);

		// Get pending review campaigns
		const pendingCampaigns = await ctx.db
			.query('campaigns')
			.withIndex('by_status', (q) => q.eq('status', 'pending_review'))
			.collect(); // bounded: review queue only

		// Get pending review transactional emails — indexed lookup, no scan.
		const pendingTransactional = await ctx.db
			.query('transactionalEmails')
			.withIndex('by_status', (q) => q.eq('status', 'pending_review'))
			.collect(); // bounded: review queue only

		// Get content scan results for context
		const scanResults = await ctx.db
			.query('contentScanResults')
			.order('desc')
			.take(100);
		const scanMap = new Map<string, (typeof scanResults)[0]>();
		for (const s of scanResults) {
			const key = `${s.resourceType}:${s.resourceId}`;
			if (!scanMap.has(key)) {
				scanMap.set(key, s);
			}
		}

		// Get recent audit logs for approved/rejected content — one indexed
		// query per action, then merge and re-sort. Cheaper than scanning all
		// of `auditLogs`.
		const [approved, rejected] = await Promise.all([
			ctx.db
				.query('auditLogs')
				.withIndex('by_action', (q) => q.eq('action', 'platform_admin.content_approved'))
				.order('desc')
				.take(50),
			ctx.db
				.query('auditLogs')
				.withIndex('by_action', (q) => q.eq('action', 'platform_admin.content_rejected'))
				.order('desc')
				.take(50),
		]);
		const recentActions = [...approved, ...rejected]
			.sort((a, b) => b.createdAt - a.createdAt)
			.slice(0, 50);

		const pendingItems = [
			...pendingCampaigns.map((c) => {
				const scan = scanMap.get(`campaign:${c._id}`);
				return {
					type: 'campaign' as const,
					id: c._id,
					name: c.name,
					subject: c.subject,
					status: 'pending' as const,
					updatedAt: c.updatedAt,
					scan: scan ? { score: scan.score, level: scan.level } : null,
				};
			}),
			...pendingTransactional.map((t) => {
				const scan = scanMap.get(`transactional:${t._id}`);
				return {
					type: 'transactional' as const,
					id: t._id,
					name: t.name,
					subject: null,
					status: 'pending' as const,
					updatedAt: t.updatedAt || t.createdAt,
					scan: scan ? { score: scan.score, level: scan.level } : null,
				};
			}),
		].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

		const recentlyReviewed = recentActions.map((a) => ({
			action: a.action,
			details: a.details,
			userId: a.userId,
			createdAt: a.createdAt,
		}));

		return {
			pending: pendingItems,
			pendingCount: pendingItems.length,
			recentlyReviewed,
		};
	},
});

/**
 * Get platform admin audit log with filtering.
 */
export const getAdminAuditLog = authedQuery({
	args: {
		actionFilter: v.optional(v.string()),
		search: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		await requirePlatformAdmin(ctx);

		// Get all platform admin audit logs via index — far cheaper than a scan.
		let logs = await ctx.db
			.query('auditLogs')
			.withIndex('by_resource', (q) => q.eq('resource', 'platform_admin'))
			.order('desc')
			.take(200);

		if (args.actionFilter) {
			logs = logs.filter((l) => l.action === args.actionFilter);
		}

		if (args.search) {
			const searchLower = args.search.toLowerCase();
			logs = logs.filter(
				(l) =>
					l.userId.toLowerCase().includes(searchLower) ||
					(l.action || '').toLowerCase().includes(searchLower)
			);
		}

		// Get admin emails for display
		const admins = await ctx.db.query('platformAdmins').collect();
		const adminEmailMap = new Map(admins.map((a) => [a.authUserId, a.email]));

		return logs.map((l) => ({
			id: l._id,
			userId: l.userId,
			userEmail: adminEmailMap.get(l.userId) || l.userId,
			action: l.action,
			resource: l.resource,
			resourceId: l.resourceId,
			details: l.details,
			createdAt: l.createdAt,
		}));
	},
});

/**
 * Get billing overview.
 * Note: Invoice-based billing was removed during billing simplification.
 * This query now returns empty data for backward compatibility.
 */
export const getBillingOverview = authedQuery({
	args: {},
	handler: async (ctx) => {
		await requirePlatformAdmin(ctx);

		return {
			recentRevenue: 0,
			recentInvoices: [],
		};
	},
});
