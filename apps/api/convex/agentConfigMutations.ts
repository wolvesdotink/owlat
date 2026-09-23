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
import { internal } from './_generated/api';
import { publicQuery, adminMutation } from './lib/authedFunctions';
import { recordAuditLog } from './lib/auditLog';
import { requireAdminContext, isActiveOrgMember } from './lib/sessionOrganization';
import { clampHumanApproveUndoDelayMs } from './inbox/processingLifecycle/effects';

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
	// The reply mode (`isAutoReplyEnabled` + `isShadowMode`) is NOT set here:
	// `setReplyMode` is its only writer, so the two can never disagree.
	args: {
		confidenceThreshold: v.optional(v.number()),
		toneDescription: v.optional(v.string()),
		signatureTemplate: v.optional(v.string()),
		maxDailyAutoReplies: v.optional(v.number()),
		coalesceWindowMs: v.optional(v.number()),
		// Undo / send-delay window (ms) for AUTONOMOUS auto-sends. Unset keeps
		// the configured value; 0 restores the legacy immediate send. See
		// inbox/processingLifecycle/effects.ts.
		autoSendDelayMs: v.optional(v.number()),
		// Undo window (ms) after a HUMAN Approve on the review surfaces. Clamped
		// to 0–120000; 0 restores the legacy immediate human send. See
		// inbox/processingLifecycle/effects.ts.
		humanApproveUndoDelayMs: v.optional(v.number()),
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

			if (args.confidenceThreshold !== undefined)
				patches.confidenceThreshold = args.confidenceThreshold;
			if (args.toneDescription !== undefined) patches.toneDescription = args.toneDescription;
			if (args.signatureTemplate !== undefined) patches.signatureTemplate = args.signatureTemplate;
			if (args.maxDailyAutoReplies !== undefined)
				patches.maxDailyAutoReplies = args.maxDailyAutoReplies;
			if (args.coalesceWindowMs !== undefined) patches.coalesceWindowMs = args.coalesceWindowMs;
			if (args.autoSendDelayMs !== undefined)
				patches.autoSendDelayMs = Math.max(0, args.autoSendDelayMs);
			if (args.humanApproveUndoDelayMs !== undefined)
				patches.humanApproveUndoDelayMs = clampHumanApproveUndoDelayMs(
					args.humanApproveUndoDelayMs
				);
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

			await recordAuditLog(ctx, {
				userId,
				action: 'agent.config_updated',
				resource: 'agent_config',
				detailsBlob: JSON.stringify(args),
			});

			return config._id;
		}

		const configId = await ctx.db.insert('agentConfig', {
			isAutoReplyEnabled: false,
			confidenceThreshold: args.confidenceThreshold ?? 0.8,
			toneDescription: args.toneDescription,
			signatureTemplate: args.signatureTemplate,
			maxDailyAutoReplies: args.maxDailyAutoReplies ?? 100,
			coalesceWindowMs: args.coalesceWindowMs ?? 30000,
			autoSendDelayMs:
				args.autoSendDelayMs === undefined ? undefined : Math.max(0, args.autoSendDelayMs),
			humanApproveUndoDelayMs:
				args.humanApproveUndoDelayMs === undefined
					? undefined
					: clampHumanApproveUndoDelayMs(args.humanApproveUndoDelayMs),
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
 * AI REPLIES MODE — the one "Draft only / Send automatically when confident"
 * control on the AI replies page. (Its third choice, Off, is the `ai.agent`
 * feature flag and goes through `setFeatureFlag`.)
 *
 * Two settings decide whether a reply leaves unattended, and before this they
 * lived on different pages: `isAutoReplyEnabled` (the global confidence tier)
 * and `isShadowMode`, which nothing in the UI could set — so an admin could turn
 * "Auto-reply" on and still never see a reply sent. This sets both together:
 *
 *   - `draft`: `isAutoReplyEnabled = false` and shadow ON. Shadow mode routes
 *     every would-be send to human review, so per-category rules
 *     (`ai.autonomy`) cannot send either, while the would-have-sent
 *     observations keep feeding the graduation scorecard. Any autonomous send
 *     still sitting in its undo window is pulled back to review.
 *   - `auto`: `isAutoReplyEnabled = true` and shadow OFF. With `ai.autonomy` on,
 *     the per-category rules decide; with it off, the global threshold and
 *     daily limit do. Every final safety gate (working hours, circuit breakers,
 *     outbound scans) still applies.
 *
 * Owner/admin only.
 */
export const setReplyMode = adminMutation({
	args: { mode: v.union(v.literal('draft'), v.literal('auto')) },
	returns: v.null(),
	handler: async (ctx, args, session) => {
		const now = Date.now();
		const sendsAutomatically = args.mode === 'auto';
		const patch = {
			isAutoReplyEnabled: sendsAutomatically,
			isShadowMode: !sendsAutomatically,
			updatedAt: now,
		};

		const configs = await ctx.db.query('agentConfig').take(1);
		if (configs.length > 0) {
			await ctx.db.patch(configs[0]!._id, patch);
		} else {
			await ctx.db.insert('agentConfig', {
				...patch,
				confidenceThreshold: 0.8,
				maxDailyAutoReplies: 100,
				coalesceWindowMs: 30000,
				createdAt: now,
			});
		}

		// Draft only must mean nothing leaves unattended from now on — including a
		// reply already approved and waiting out its undo delay. Scheduled so the
		// (bounded) scan never blocks this write; fail-soft per message.
		if (!sendsAutomatically) {
			await ctx.scheduler.runAfter(
				0,
				internal.inbox.processingLifecycle.cancelPendingAutoSendsForKillSwitch,
				{}
			);
		}

		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'agent.config_updated',
			resource: 'agent_config',
			details: { replyMode: args.mode },
		});

		return null;
	},
});
