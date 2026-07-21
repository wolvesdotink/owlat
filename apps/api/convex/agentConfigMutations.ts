/**
 * Agent Config Mutations
 *
 * CRUD for the agent pipeline's *operational tuning* (threshold, tone,
 * signature, rate limits). The agent's master on/off lives on the `ai.agent`
 * feature flag — see `organizations.featureFlags.setFeatureFlag` for the toggle
 * and its one-shot knowledge-backfill side effect.
 */

import { v } from 'convex/values';
import { applyToggle } from '@owlat/shared/featureFlags';
import type { Doc } from './_generated/dataModel';
import { internal } from './_generated/api';
import { publicQuery, adminMutation } from './lib/authedFunctions';
import { recordAuditLog } from './lib/auditLog';
import { getStoredFlags } from './lib/featureFlags';
import { requireAdminContext, isActiveOrgMember } from './lib/sessionOrganization';
import { FEATURE_FLAG_REGISTRY } from './plugins/featureFlagRegistry';

/** Clamp a minute-of-day into [0, 1439] so a bad client value can't wedge the window. */
function clampMinuteOfDay(minute: number): number {
	if (!Number.isFinite(minute)) return 0;
	return Math.min(1439, Math.max(0, Math.round(minute)));
}

/** De-dupe + keep only valid weekday indices (0=Sun … 6=Sat). */
function normalizeWeekdays(days: number[]): number[] {
	const seen = new Set<number>();
	for (const d of days) {
		const n = Math.round(d);
		if (n >= 0 && n <= 6) seen.add(n);
	}
	return Array.from(seen).sort((a, b) => a - b);
}

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
		// Undo / send-delay window (ms) for AUTONOMOUS auto-sends. Unset keeps
		// the configured value; 0 restores the legacy immediate send. See
		// inbox/processingLifecycle/effects.ts.
		autoSendDelayMs: v.optional(v.number()),
		// Timezone-aware working-hours window for autonomous auto-sends. When
		// enabled, an auto-approved reply decided OUTSIDE the window is held for
		// human review instead of sent. See lib/workingHours.ts.
		isWorkingHoursEnabled: v.optional(v.boolean()),
		workingHoursTimezone: v.optional(v.string()),
		workingHoursStart: v.optional(v.number()),
		workingHoursEnd: v.optional(v.number()),
		workingHoursDays: v.optional(v.array(v.number())),
	},
	handler: async (ctx, args) => {
		const { userId } = await requireAdminContext(ctx);

		const configs = await ctx.db.query('agentConfig').take(1);
		const now = Date.now();

		if (configs.length > 0) {
			const config = configs[0]!;
			const patches: Partial<Doc<'agentConfig'>> = { updatedAt: now };

			if (args.isAutoReplyEnabled !== undefined)
				patches.isAutoReplyEnabled = args.isAutoReplyEnabled;
			if (args.confidenceThreshold !== undefined)
				patches.confidenceThreshold = args.confidenceThreshold;
			if (args.toneDescription !== undefined) patches.toneDescription = args.toneDescription;
			if (args.signatureTemplate !== undefined) patches.signatureTemplate = args.signatureTemplate;
			if (args.maxDailyAutoReplies !== undefined)
				patches.maxDailyAutoReplies = args.maxDailyAutoReplies;
			if (args.coalesceWindowMs !== undefined) patches.coalesceWindowMs = args.coalesceWindowMs;
			if (args.autoSendDelayMs !== undefined)
				patches.autoSendDelayMs = Math.max(0, args.autoSendDelayMs);
			if (args.isWorkingHoursEnabled !== undefined)
				patches.isWorkingHoursEnabled = args.isWorkingHoursEnabled;
			if (args.workingHoursTimezone !== undefined)
				patches.workingHoursTimezone = args.workingHoursTimezone;
			if (args.workingHoursStart !== undefined)
				patches.workingHoursStart = clampMinuteOfDay(args.workingHoursStart);
			if (args.workingHoursEnd !== undefined)
				patches.workingHoursEnd = clampMinuteOfDay(args.workingHoursEnd);
			if (args.workingHoursDays !== undefined)
				patches.workingHoursDays = normalizeWeekdays(args.workingHoursDays);

			await ctx.db.patch(config._id, patches);

			// Kill switch: flipping auto-reply OFF must also abort any autonomous
			// send still sitting in its undo window — otherwise a queued send
			// fires seconds after the operator thought they stopped it. Scheduled
			// so the (bounded) scan never blocks the config write; fail-soft.
			if (args.isAutoReplyEnabled === false) {
				await ctx.scheduler.runAfter(
					0,
					internal.inbox.processingLifecycle.cancelPendingAutoSendsForKillSwitch,
					{}
				);
			}

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
			autoSendDelayMs:
				args.autoSendDelayMs === undefined ? undefined : Math.max(0, args.autoSendDelayMs),
			isWorkingHoursEnabled: args.isWorkingHoursEnabled,
			workingHoursTimezone: args.workingHoursTimezone,
			workingHoursStart:
				args.workingHoursStart === undefined ? undefined : clampMinuteOfDay(args.workingHoursStart),
			workingHoursEnd:
				args.workingHoursEnd === undefined ? undefined : clampMinuteOfDay(args.workingHoursEnd),
			workingHoursDays:
				args.workingHoursDays === undefined ? undefined : normalizeWeekdays(args.workingHoursDays),
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

/**
 * ONE-CLICK KILL SWITCH — stop all autonomous auto-sending NOW.
 *
 * Halting auto-send previously took TWO separate settings: disabling the
 * `ai.autonomy` feature flag AND flipping `agentConfig.isAutoReplyEnabled` off
 * (either one alone leaves a send path open). This mutation does BOTH atomically
 * plus cancels every autonomous send still sitting in its undo window, so a
 * single button reverts the deployment to DRAFT-ONLY in seconds:
 *
 *   1. Disable the `ai.autonomy` flag (per-category graduated autonomy tier).
 *   2. Set `agentConfig.isAutoReplyEnabled = false` (legacy global tier).
 *   3. Schedule the bulk cancel of in-flight delayed auto-sends, routing each
 *      queued reply back to human review (coordinates with the send-delay/undo
 *      window — a reply that already left the queue is left alone).
 *
 * The agent itself (`ai.agent`) stays ON, so inbound mail is still classified
 * and DRAFTED for human review — only the unattended SEND is stopped. Nothing
 * is dropped; every held reply lands in the review queue. Owner/admin only.
 */
export const killSwitch = adminMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const { userId } = await requireAdminContext(ctx);
		const now = Date.now();

		// 1. Disable the ai.autonomy feature flag via the shared cascade so any
		//    dependent flags resolve consistently (same writer as setFeatureFlag).
		const stored = await getStoredFlags(ctx);
		const { next } = applyToggle(stored, 'ai.autonomy', false, FEATURE_FLAG_REGISTRY);
		const settings = await ctx.db.query('instanceSettings').first();
		if (settings) {
			await ctx.db.patch(settings._id, { featureFlags: next, updatedAt: now });
		} else {
			await ctx.db.insert('instanceSettings', {
				featureFlags: next,
				createdAt: now,
				updatedAt: now,
			});
		}

		// 2. Force the legacy global auto-reply toggle off.
		const configs = await ctx.db.query('agentConfig').take(1);
		if (configs.length > 0) {
			await ctx.db.patch(configs[0]!._id, { isAutoReplyEnabled: false, updatedAt: now });
		} else {
			await ctx.db.insert('agentConfig', {
				isAutoReplyEnabled: false,
				confidenceThreshold: 0.8,
				maxDailyAutoReplies: 100,
				coalesceWindowMs: 30000,
				createdAt: now,
				updatedAt: now,
			});
		}

		// 3. Cancel every autonomous send still in its undo window, routing each
		//    back to human review. Scheduled so a large scan never blocks this
		//    write; fail-soft per message.
		await ctx.scheduler.runAfter(
			0,
			internal.inbox.processingLifecycle.cancelPendingAutoSendsForKillSwitch,
			{}
		);

		await recordAuditLog(ctx, {
			userId,
			action: 'agent.kill_switch',
			resource: 'agent_config',
			details: { revertedToDraftOnly: true },
		});

		return null;
	},
});
