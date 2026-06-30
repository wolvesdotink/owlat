/**
 * Agent Config Mutations
 *
 * CRUD for the agent pipeline's *operational tuning* (threshold, tone,
 * signature, rate limits). The agent's master on/off lives on the `ai.agent`
 * feature flag — see `organizations.featureFlags.setFeatureFlag` for the toggle
 * and its one-shot knowledge-backfill side effect.
 */

import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { publicQuery, adminMutation } from './lib/authedFunctions';
import { recordAuditLog } from './lib/auditLog';
import { requireAdminContext, isActiveOrgMember } from './lib/sessionOrganization';

/**
 * Get the current agent configuration
 */
export const getConfig = publicQuery({
	// public: soft-auth — org members only; returns null for anonymous/non-members
	args: {},
	handler: async (ctx) => {
		if (!(await isActiveOrgMember(ctx))) return null;

		const configs = await ctx.db.query('agentConfig').take(1);
		return configs.length > 0 ? configs[0] : null;
	},
});

/**
 * Update or create agent configuration tuning. The on/off toggle is the
 * `ai.agent` feature flag — set it via `organizations.featureFlags.setFeatureFlag`.
 *
 * Admin-only: the signature template and auto-reply settings are exfiltration /
 * brand-impersonation vectors, and the rate-limit knobs gate spend. Restrict
 * to owners/admins via `adminMutation`.
 */
export const updateConfig = adminMutation({
	args: {
		isAutoReplyEnabled: v.optional(v.boolean()),
		confidenceThreshold: v.optional(v.number()),
		toneDescription: v.optional(v.string()),
		signatureTemplate: v.optional(v.string()),
		maxDailyAutoReplies: v.optional(v.number()),
		coalesceWindowMs: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const { userId } = await requireAdminContext(ctx);

		const configs = await ctx.db.query('agentConfig').take(1);
		const now = Date.now();

		if (configs.length > 0) {
			const config = configs[0]!;
			const patches: Partial<Doc<'agentConfig'>> = { updatedAt: now };

			if (args.isAutoReplyEnabled !== undefined) patches.isAutoReplyEnabled = args.isAutoReplyEnabled;
			if (args.confidenceThreshold !== undefined) patches.confidenceThreshold = args.confidenceThreshold;
			if (args.toneDescription !== undefined) patches.toneDescription = args.toneDescription;
			if (args.signatureTemplate !== undefined) patches.signatureTemplate = args.signatureTemplate;
			if (args.maxDailyAutoReplies !== undefined) patches.maxDailyAutoReplies = args.maxDailyAutoReplies;
			if (args.coalesceWindowMs !== undefined) patches.coalesceWindowMs = args.coalesceWindowMs;

			await ctx.db.patch(config._id, patches);

			await recordAuditLog(ctx, {
				userId,
				action: 'agent.config_updated',
				resource: 'agent_config',
				detailsBlob: JSON.stringify(args),
			});

			return config._id;
		}

		const configId = await ctx.db.insert('agentConfig', {
			isAutoReplyEnabled: args.isAutoReplyEnabled ?? false,
			confidenceThreshold: args.confidenceThreshold ?? 0.8,
			toneDescription: args.toneDescription,
			signatureTemplate: args.signatureTemplate,
			maxDailyAutoReplies: args.maxDailyAutoReplies ?? 100,
			coalesceWindowMs: args.coalesceWindowMs ?? 30000,
			createdAt: now,
			updatedAt: now,
		});

		await recordAuditLog(ctx, {
			userId,
			action: 'agent.config_updated',
			resource: 'agent_config',
			details: { action: 'created' },
		});

		return configId;
	},
});
