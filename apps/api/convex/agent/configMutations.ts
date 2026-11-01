/**
 * Agent Config Mutations
 *
 * CRUD for the agent pipeline's *operational tuning* (threshold, tone,
 * signature, rate limits). The agent's master on/off lives on the `ai.agent`
 * feature flag — see `organizations.featureFlags.setFeatureFlag` for the toggle
 * and its one-shot knowledge-backfill side effect.
 *
 * Each builder's body is an exported helper so the previous-release shims at
 * the old root path (`agentConfigMutations.ts`) run the same code.
 */

import { v, type ObjectType } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { publicQuery, adminMutation } from '../lib/authedFunctions';
import { recordAuditLog } from '../lib/auditLog';
import { isActiveOrgMember } from '../lib/sessionOrganization';
import { clampHumanApproveUndoDelayMs } from '../inbox/processingLifecycle/effects';
import { optionalFields, pick } from '../lib/validators/fields';
import { agentConfigFields } from '../schema/autonomy';
import { AGENT_CONFIG_INSERT_DEFAULTS } from '../lib/agentConfigDefaults';
import { throwInvalidInput } from '../_utils/errors';
import { AUTO_SEND_VERDICT_TASKS } from '../lib/decision/calibration';
import { decisionAutonomyProblem } from '../lib/decision/autoSendContract';

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
		return await readAgentConfig(ctx);
	},
});

/** The singleton agent config row, or null before anyone saved one. */
export async function readAgentConfig(ctx: QueryCtx): Promise<Doc<'agentConfig'> | null> {
	const configs = await ctx.db.query('agentConfig').take(1);
	return configs.length > 0 ? configs[0]! : null;
}

// Every field is optional: an omitted one keeps its configured value. The
// reply mode (`isAutoReplyEnabled` + `isShadowMode`) is NOT set here:
// `setReplyMode` is its only writer, so the two can never disagree. The
// daily counters and `clarificationTimeoutMs` are not set here either.
// schema/autonomy.ts documents what each field means.
const UPDATE_CONFIG_ARGS = optionalFields(
	pick(agentConfigFields, [
		'confidenceThreshold',
		'toneDescription',
		'signatureTemplate',
		'maxDailyAutoReplies',
		'coalesceWindowMs',
		'autoSendDelayMs',
		'humanApproveUndoDelayMs',
		'isWorkingHoursEnabled',
		'workingHoursTimezone',
		'workingHoursStart',
		'workingHoursEnd',
		'workingHoursDays',
		'isItemCoverageEnforced',
	])
);

/** The tuning fields `updateConfig` accepts, every one optional. */
export type AgentConfigUpdate = ObjectType<typeof UPDATE_CONFIG_ARGS>;

/**
 * Update or create agent configuration tuning. The on/off toggle is the
 * `ai.agent` feature flag — set it via `organizations.featureFlags.setFeatureFlag`.
 *
 * Admin-only: the signature template and auto-reply settings are exfiltration /
 * brand-impersonation vectors, and the rate-limit knobs gate spend. Restrict
 * to owners/admins via `adminMutation`.
 */
export const updateConfig = adminMutation({
	args: UPDATE_CONFIG_ARGS,
	handler: async (ctx, args, { userId }) => await writeAgentConfig(ctx, args, userId),
});

/**
 * Patch the tuning fields that are set (clamping the ones a bad client value
 * could wedge), or create the row with defaults for the rest.
 */
export async function writeAgentConfig(
	ctx: MutationCtx,
	args: AgentConfigUpdate,
	userId: string
): Promise<Id<'agentConfig'>> {
	const configs = await ctx.db.query('agentConfig').take(1);
	const now = Date.now();

	// Decision-driven autonomous input needs item coverage enforced: while a
	// decision verdict feeds auto-send, coverage cannot be switched off
	// (lib/decision/autoSendContract.ts). No verdict feeds it today.
	if (args.isItemCoverageEnforced === false) {
		const problem = decisionAutonomyProblem({
			verdictTasks: AUTO_SEND_VERDICT_TASKS,
			isItemCoverageEnforced: false,
		});
		if (problem) throwInvalidInput(problem);
	}

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
			patches.humanApproveUndoDelayMs = clampHumanApproveUndoDelayMs(args.humanApproveUndoDelayMs);
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
		if (args.isItemCoverageEnforced !== undefined)
			patches.isItemCoverageEnforced = args.isItemCoverageEnforced;

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
		isItemCoverageEnforced: args.isItemCoverageEnforced,
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
}

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
		await writeReplyMode(ctx, args.mode, session.userId);
		return null;
	},
});

/**
 * Set `isAutoReplyEnabled` and `isShadowMode` together for the chosen mode,
 * and pull any pending autonomous send back to review when it is `draft`.
 */
export async function writeReplyMode(
	ctx: MutationCtx,
	mode: 'draft' | 'auto',
	userId: string
): Promise<void> {
	const now = Date.now();
	const sendsAutomatically = mode === 'auto';
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
			...AGENT_CONFIG_INSERT_DEFAULTS,
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
		userId,
		action: 'agent.config_updated',
		resource: 'agent_config',
		details: { replyMode: mode },
	});
}
