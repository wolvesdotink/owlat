import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { throwNotFound, throwInvalidInput } from '../_utils/errors';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { assertFeatureEnabled } from '../lib/featureFlags';
import { CURRENT_WEBHOOK_PAYLOAD_VERSION } from '../lib/constants';
import { randomToken } from '../lib/randomToken';
import { recordAuditLog } from '../lib/auditLog';
import { subscribableWebhookEventValidator } from './events';
import { test as testEventModule } from './events/test';
import { isDisallowedIpAddress } from '../lib/ipBlocklist';
import type { Doc } from '../_generated/dataModel';

/**
 * Strip the HMAC signing secret from a webhook document before returning it to
 * the client. The plaintext `secret` is server-only (used to sign delivery
 * payloads) and is surfaced to the user exactly once, from create /
 * regenerateSecret — never re-read from a list or get. This keeps webhooks
 * consistent with API keys (hash + prefix) and IMAP credentials (never
 * returned), and honours the "shown only once" contract in the settings UI.
 */
function stripWebhookSecret({ secret: _secret, ...rest }: Doc<'webhooks'>): Omit<Doc<'webhooks'>, 'secret'> {
	return rest;
}

function isDisallowedWebhookHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	// Hostname-only rules first (the v8 runtime can't do DNS), then the shared
	// literal-IP blocklist so this can't diverge from lib/ssrfGuard.
	if (host === 'localhost' || host.endsWith('.local')) {
		return true;
	}
	return isDisallowedIpAddress(host);
}

/**
 * Validate a webhook destination URL: must be a well-formed http(s) URL whose
 * host is not localhost / a *.local name / a disallowed literal IP. Throws an
 * invalid-input error on any failure. Shared by create + update so the SSRF
 * front-door check can't drift between the two mutations. The caller passes the
 * already-trimmed string.
 */
function assertValidWebhookUrl(url: string): void {
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch {
		throwInvalidInput('Invalid webhook URL format');
	}
	if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
		throwInvalidInput('Webhook URL must use HTTP or HTTPS protocol');
	}
	if (isDisallowedWebhookHost(parsedUrl.hostname)) {
		throwInvalidInput('Webhook URL host is not allowed');
	}
}


// ============ QUERIES ============

// Feature-flag contract: the 'webhooks' flag is a product/UI gate, not an
// authorization boundary. It is asserted on the list entry point below (so a
// disabled instance shows no webhook UI) and reinforced by the web layer's
// path-derived feature gate. The CRUD mutations in this file are gated by
// organization:manage (admin/owner) regardless of the flag and intentionally do
// not re-assert it — authorization, not the product flag, is the security gate.
/**
 * List all webhooks
 */
export const listByOrganization = authedQuery({
	args: {
		includeInactive: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'organization:manage', 'Only owners and admins can manage webhooks');
		await assertFeatureEnabled(ctx, 'webhooks');
		const { includeInactive = false } = args;

		let webhooks;
		if (includeInactive) {
			webhooks = await ctx.db.query('webhooks').collect(); // bounded: admin-curated
		} else {
			webhooks = await ctx.db
				.query('webhooks')
				.withIndex('by_active', (q) =>
					q.eq('isActive', true)
				)
				.collect(); // bounded: active subset
		}

		// Sort by creation date descending (newest first). Strip the HMAC secret:
		// the client never reads it from the list, and it must not leak to the
		// browser on every settings-page load.
		return webhooks
			.sort((a, b) => b.createdAt - a.createdAt)
			.map(stripWebhookSecret);
	},
});

/**
 * Get a single webhook by ID
 */
export const get = authedQuery({
	args: {
		webhookId: v.id('webhooks'),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'organization:manage', 'Only owners and admins can manage webhooks');
		const webhook = await ctx.db.get(args.webhookId);
		if (!webhook) return null;
		// Never return the HMAC secret to the client (shown only once, from
		// create / regenerateSecret).
		return stripWebhookSecret(webhook);
	},
});

/**
 * Count webhooks
 */
export const countByOrganization = authedQuery({
	args: {},
	handler: async (ctx) => {
		await requireOrgPermission(ctx, 'organization:manage', 'Only owners and admins can manage webhooks');
		// Both reads are bounded — webhooks are admin-curated.
		const [allWebhooks, activeWebhooks] = await Promise.all([
			ctx.db.query('webhooks').collect(), // bounded: admin-curated
			ctx.db
				.query('webhooks')
				.withIndex('by_active', (q) => q.eq('isActive', true))
				.collect(), // bounded: active subset
		]);

		return {
			total: allWebhooks.length,
			active: activeWebhooks.length,
		};
	},
});

// Firing webhook notifications resolves the per-event active set via the
// internal query webhooks/deliveryQueries.getWebhooksForEvent (the live caller
// is webhooks/fanout.ts). A public `listByEvent` authedQuery duplicating that
// logic used to live here with no caller — removed.

// ============ MUTATIONS ============

/**
 * Create a new webhook
 * Generates a secret for HMAC signature verification
 */
export const create = authedMutation({
	args: {
		name: v.string(),
		url: v.string(),
		events: v.array(subscribableWebhookEventValidator),
	},
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(ctx, 'organization:manage', 'Only owners and admins can manage webhooks');
		const { name, url, events } = args;

		// Validate name
		if (!name.trim()) {
			throwInvalidInput('Webhook name is required');
		}

		// Validate URL
		if (!url.trim()) {
			throwInvalidInput('Webhook URL is required');
		}
		assertValidWebhookUrl(url);

		// Validate events
		if (events.length === 0) {
			throwInvalidInput('At least one event must be selected');
		}

		// Generate the webhook secret
		const secret = randomToken(32, 'whsec_');

		const now = Date.now();

		// Create the webhook record
		const webhookId = await ctx.db.insert('webhooks', {
			name: name.trim(),
			url: url.trim(),
			events,
			secret,
			isActive: true,
			createdAt: now,
			updatedAt: now,
		});

		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'webhook.created',
			resource: 'webhook',
			resourceId: webhookId,
			details: { name: name.trim(), url: url.trim() },
		});

		// Return the webhook details including the secret
		// The secret should be shown to the user for signature verification
		return {
			webhookId,
			name: name.trim(),
			url: url.trim(),
			events,
			secret, // Shown for user to configure their endpoint
			isActive: true,
		};
	},
});

/**
 * Update webhook settings
 */
export const update = authedMutation({
	args: {
		webhookId: v.id('webhooks'),
		name: v.optional(v.string()),
		url: v.optional(v.string()),
		events: v.optional(v.array(subscribableWebhookEventValidator)),
	},
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(ctx, 'organization:manage', 'Only owners and admins can manage webhooks');
		const { webhookId, name, url, events } = args;

		const webhook = await ctx.db.get(webhookId);
		if (!webhook) {
			throwNotFound('Webhook');
		}

		const updates: Record<string, unknown> = {
			updatedAt: Date.now(),
		};

		// Validate and set name
		if (name !== undefined) {
			if (!name.trim()) {
				throwInvalidInput('Webhook name is required');
			}
			updates['name'] = name.trim();
		}

		// Validate and set URL
		if (url !== undefined) {
			if (!url.trim()) {
				throwInvalidInput('Webhook URL is required');
			}
			assertValidWebhookUrl(url);
			updates['url'] = url.trim();
		}

		// Validate and set events
		if (events !== undefined) {
			if (events.length === 0) {
				throwInvalidInput('At least one event must be selected');
			}
			updates['events'] = events;
		}

		await ctx.db.patch(webhookId, updates);

		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'webhook.updated',
			resource: 'webhook',
			resourceId: webhookId,
			details: {
				name: (updates['name'] as string | undefined) ?? webhook.name,
				url: (updates['url'] as string | undefined) ?? webhook.url,
			},
		});

		return { success: true };
	},
});

/**
 * Regenerate webhook secret
 * Returns the new secret (shown only once)
 */
export const regenerateSecret = authedMutation({
	args: {
		webhookId: v.id('webhooks'),
	},
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(ctx, 'organization:manage', 'Only owners and admins can manage webhooks');
		const webhook = await ctx.db.get(args.webhookId);
		if (!webhook) {
			throwNotFound('Webhook');
		}

		// Generate a new secret
		const secret = randomToken(32, 'whsec_');

		await ctx.db.patch(args.webhookId, {
			secret,
			updatedAt: Date.now(),
		});

		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'webhook.secret_rotated',
			resource: 'webhook',
			resourceId: args.webhookId,
			details: { name: webhook.name },
		});

		return { secret };
	},
});

/**
 * Toggle webhook active status (enable/disable)
 */
export const toggle = authedMutation({
	args: {
		webhookId: v.id('webhooks'),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'organization:manage', 'Only owners and admins can manage webhooks');
		const webhook = await ctx.db.get(args.webhookId);
		if (!webhook) {
			throwNotFound('Webhook');
		}

		await ctx.db.patch(args.webhookId, {
			isActive: !webhook.isActive,
			updatedAt: Date.now(),
		});

		return { isActive: !webhook.isActive };
	},
});

/**
 * Enable a webhook
 */
export const enable = authedMutation({
	args: {
		webhookId: v.id('webhooks'),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'organization:manage', 'Only owners and admins can manage webhooks');
		const webhook = await ctx.db.get(args.webhookId);
		if (!webhook) {
			throwNotFound('Webhook');
		}

		if (webhook.isActive) {
			return { success: true };
		}

		await ctx.db.patch(args.webhookId, {
			isActive: true,
			updatedAt: Date.now(),
		});

		return { success: true };
	},
});

/**
 * Disable a webhook
 */
export const disable = authedMutation({
	args: {
		webhookId: v.id('webhooks'),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'organization:manage', 'Only owners and admins can manage webhooks');
		const webhook = await ctx.db.get(args.webhookId);
		if (!webhook) {
			throwNotFound('Webhook');
		}

		if (!webhook.isActive) {
			return { success: true };
		}

		await ctx.db.patch(args.webhookId, {
			isActive: false,
			updatedAt: Date.now(),
		});

		return { success: true };
	},
});

/**
 * Delete a webhook permanently
 * Also deletes all associated delivery logs
 */
export const remove = authedMutation({
	args: {
		webhookId: v.id('webhooks'),
	},
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(ctx, 'organization:manage', 'Only owners and admins can manage webhooks');
		const webhook = await ctx.db.get(args.webhookId);
		if (!webhook) {
			throwNotFound('Webhook');
		}

		// Delete all delivery logs for this webhook
		const deliveryLogs = await ctx.db
			.query('webhookDeliveryLogs')
			.withIndex('by_webhook', (q) => q.eq('webhookId', args.webhookId))
			.collect();

		for (const log of deliveryLogs) {
			await ctx.db.delete(log._id);
		}

		await ctx.db.delete(args.webhookId);

		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'webhook.deleted',
			resource: 'webhook',
			resourceId: args.webhookId,
			details: { name: webhook.name, url: webhook.url },
		});

		return { success: true };
	},
});

/**
 * Send a test webhook to verify endpoint connectivity
 */
export const sendTestWebhook = authedMutation({
	args: {
		webhookId: v.id('webhooks'),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'organization:manage', 'Only owners and admins can manage webhooks');
		const webhook = await ctx.db.get(args.webhookId);
		if (!webhook) {
			throwNotFound('Webhook');
		}

		if (!webhook.isActive) {
			throwInvalidInput('Webhook must be active to send a test event');
		}

		const payloadObj = {
			event: 'test' as const,
			timestamp: new Date().toISOString(),
			data: testEventModule.build({
				webhookId: args.webhookId,
				webhookName: webhook.name,
			}),
		};
		const payloadStr = JSON.stringify(payloadObj);

		const now = Date.now();
		const logId = await ctx.db.insert('webhookDeliveryLogs', {
			webhookId: args.webhookId,
			event: 'test',
			payload: payloadObj,
			payloadVersion: CURRENT_WEBHOOK_PAYLOAD_VERSION,
			attemptNumber: 1,
			maxAttempts: 3,
			status: 'pending',
			scheduledAt: now,
		});

		await ctx.scheduler.runAfter(0, internal.webhooks.delivery.deliverWebhookInternal, {
			webhookId: args.webhookId,
			logId,
			payload: payloadStr,
			attemptNumber: 1,
		});

		return { success: true, logId };
	},
});

// ============ DELIVERY LOG QUERIES ============

/**
 * List delivery logs for a specific webhook (for the UI)
 */
export const listDeliveryLogs = authedQuery({
	args: {
		webhookId: v.id('webhooks'),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'organization:manage', 'Only owners and admins can manage webhooks');
		const webhook = await ctx.db.get(args.webhookId);
		if (!webhook) return [];

		const limit = args.limit ?? 50;
		const logs = await ctx.db
			.query('webhookDeliveryLogs')
			.withIndex('by_webhook', (q) => q.eq('webhookId', args.webhookId))
			.order('desc')
			.take(limit);

		return logs;
	},
});

/**
 * List all delivery logs (for the UI)
 */
export const listDeliveryLogsByOrganization = authedQuery({
	args: {
		limit: v.optional(v.number()),
		status: v.optional(
			v.union(
				v.literal('pending'),
				v.literal('success'),
				v.literal('failed'),
				v.literal('retrying')
			)
		),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'organization:manage', 'Only owners and admins can manage webhooks');
		const limit = args.limit ?? 50;

		let logs;
		if (args.status) {
			logs = await ctx.db
				.query('webhookDeliveryLogs')
				.withIndex('by_status', (q) =>
					q.eq('status', args.status!)
				)
				.order('desc')
				.take(limit);
		} else {
			logs = await ctx.db
				.query('webhookDeliveryLogs')
				.order('desc')
				.take(limit);
		}

		return logs;
	},
});

/**
 * Get delivery log details
 */
export const getDeliveryLog = authedQuery({
	args: {
		logId: v.id('webhookDeliveryLogs'),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'organization:manage', 'Only owners and admins can manage webhooks');
		const log = await ctx.db.get(args.logId);
		if (!log) return null;
		return log;
	},
});

/**
 * Get delivery stats for a webhook
 */
export const getDeliveryStats = authedQuery({
	args: {
		webhookId: v.id('webhooks'),
		since: v.optional(v.number()), // Timestamp to filter from
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'organization:manage', 'Only owners and admins can manage webhooks');
		const webhook = await ctx.db.get(args.webhookId);
		if (!webhook) return { total: 0, success: 0, failed: 0, pending: 0, retrying: 0, successRate: 100 };

		// Limit to a recent window to bound the read on a high-volume table.
		// If the caller didn't specify a window, default to the past 30 days.
		const since = args.since ?? Date.now() - 30 * 24 * 60 * 60 * 1000;
		const logs = await ctx.db
			.query('webhookDeliveryLogs')
			.withIndex('by_webhook', (q) => q.eq('webhookId', args.webhookId))
			.collect(); // bounded by webhook-scoped index; further capped by `since`

		const filteredLogs = logs.filter((log) => log.scheduledAt >= since);

		const total = filteredLogs.length;
		const success = filteredLogs.filter((l) => l.status === 'success').length;
		const failed = filteredLogs.filter((l) => l.status === 'failed').length;
		const pending = filteredLogs.filter((l) => l.status === 'pending').length;
		const retrying = filteredLogs.filter((l) => l.status === 'retrying').length;

		// Calculate success rate
		const completed = success + failed;
		const successRate = completed > 0 ? Math.round((success / completed) * 100) : 100;

		return {
			total,
			success,
			failed,
			pending,
			retrying,
			successRate,
		};
	},
});
