/**
 * Feature flags (module) — sole writer of the singleton
 * `instanceSettings` row's `featureFlags` map. Sibling of
 * **Organization settings (module)** (which owns the settings columns),
 * **Abuse status (module)** (which owns the abuse-status columns), and
 * the **Organization deletion (module)** walker.
 *
 * Five entry points:
 *   - `getFeatureFlags`     — public query, returns the resolved flag
 *                            map. No auth gate (nav rendering needs
 *                            this on the public setup page).
 *   - `getResolvedFlags`    — internal-query mirror of the above for
 *                            action callers (`ctx.runQuery`).
 *   - `setFeatureFlag`      — admin mutation, toggles one flag with
 *                            cascade rules. Owns the per-flag
 *                            side-effect surface: `ai.agent` kicks off
 *                            the message-extraction knowledge backfill,
 *                            and `ai.knowledge.autoLink` kicks off the
 *                            one-shot graph EDGE backfill.
 *   - `setFeaturePack`      — admin mutation, toggles every flag in a
 *                            pack at once.
 *   - `setAllFeatureFlags`  — admin mutation, replaces the whole flag
 *                            map (used by the setup wizard).
 *
 * The `ai.agent` backfill kick-off semantic is explicit-only: a
 * cascade-driven enable (e.g. via `inbox.codeTasks` requiring
 * `ai.agent`) does NOT trigger the backfill. Only a direct
 * false→true `setFeatureFlag({ flag: 'ai.agent', value: true })`
 * does, and only when no prior backfill job exists.
 *
 * See docs/adr/0026-organization-settings-modules.md.
 */

import { v } from 'convex/values';
import { internalQuery, internalMutation, type MutationCtx } from '../_generated/server';
import { publicQuery, authedQuery, authedMutation } from '../lib/authedFunctions';
import { isDeliveryConfigured } from '../lib/sendProviders/capability';
import { isEnvPresent } from '../lib/env';
import { internal } from '../_generated/api';
import { requireAdminContext } from '../lib/sessionOrganization';
import {
	applyToggle,
	applyPackToggle,
	resolveFlags,
	SENDING_FLAGS_REQUIRING_DELIVERY,
	type FeatureFlagKey,
	type FeatureFlagState,
	type FeaturePackKey,
	FEATURE_FLAGS,
	FEATURE_PACKS,
} from '@owlat/shared/featureFlags';
import { getStoredFlags } from '../lib/featureFlags';
import { recordAuditLog } from '../lib/auditLog';
import { throwInvalidInput } from '../_utils/errors';

// public: pre-auth setup/nav rendering needs flags before login
export const getFeatureFlags = publicQuery({
	args: {},
	handler: async (ctx) => {
		const stored = await getStoredFlags(ctx);
		return resolveFlags(stored);
	},
});

// Whether a delivery provider is actually configured. Sending flags
// (campaigns/transactional/automations) declare no `requiredEnvVars` because the
// provider is env+capability rather than a flag dependency, so the admin
// features UI drives its "missing config" hint for those flags from this instead.
// all-members: whether a delivery provider is configured is a non-sensitive
// deployment status (a single boolean, no credentials), shown to any member in
// the Features settings UI — mirrors the public getFeatureFlags above.
export const deliveryConfigured = authedQuery({
	args: {},
	handler: async (ctx) => {
		return await isDeliveryConfigured(ctx);
	},
});

export const getResolvedFlags = internalQuery({
	args: {},
	handler: async (ctx) => {
		const stored = await getStoredFlags(ctx);
		return resolveFlags(stored);
	},
});

// Per-flag configuration gaps: for every flag whose requirements are not met,
// the list of missing requirements (absent `requiredEnvVars`, or — for sending
// flags — "a configured delivery provider"). The admin Features UI joins this
// against the resolved flag state to badge flags that are ENABLED but not yet
// configured ("needs config"). Reporting the gap independently of the on/off
// state keeps this a pure deployment-config reporter; the UI owns the join.
//
// all-members: like `deliveryConfigured` above, this returns only presence
// booleans / variable *names* (never values), and the same names are already
// rendered to every member by the flag list's "Requires env:" line. No secrets.
export const getFlagsConfigStatus = authedQuery({
	args: {},
	handler: async (ctx) => {
		const deliveryConfigured = await isDeliveryConfigured(ctx);
		const status: Record<string, string[]> = {};
		for (const def of Object.values(FEATURE_FLAGS)) {
			const missing: string[] = [];
			for (const envVar of def.requiredEnvVars ?? []) {
				if (!isEnvPresent(envVar)) missing.push(envVar);
			}
			if (
				(SENDING_FLAGS_REQUIRING_DELIVERY as readonly string[]).includes(def.key) &&
				!deliveryConfigured
			) {
				missing.push('A configured delivery provider');
			}
			if (missing.length > 0) status[def.key] = missing;
		}
		return status;
	},
});

/**
 * Side effect: an explicit false→true toggle of `ai.agent` kicks off the
 * one-shot knowledge-graph backfill (first time only — gated by the existence
 * of any prior backfill job). Cascade-driven enables do NOT trigger the
 * backfill — the explicit-only semantic is load-bearing.
 */
export const setFeatureFlag = authedMutation({
	args: {
		flag: v.string(),
		value: v.boolean(),
	},
	handler: async (ctx, args) => {
		const session = await requireAdminContext(ctx);

		if (!(args.flag in FEATURE_FLAGS)) {
			throwInvalidInput(`Unknown feature flag: ${args.flag}`);
		}
		const flag = args.flag as FeatureFlagKey;

		const stored = await getStoredFlags(ctx);
		const { next, cascaded } = applyToggle(stored, flag, args.value);

		const now = Date.now();
		const existing = await ctx.db.query('instanceSettings').first();
		const patch = { featureFlags: next, updatedAt: now };

		if (existing) {
			await ctx.db.patch(existing._id, patch);
		} else {
			await ctx.db.insert('instanceSettings', {
				...patch,
				createdAt: now,
			});
		}

		const aiAgentExplicitlyTurningOn =
			flag === 'ai.agent' && args.value === true && stored['ai.agent'] !== true;
		if (aiAgentExplicitlyTurningOn) {
			const alreadyHasJob = await ctx.runQuery(internal.agent.knowledgeBackfill.hasAnyJob, {});
			if (!alreadyHasJob) {
				const jobId = await ctx.runMutation(internal.agent.knowledgeBackfill.createJob, {
					triggeredBy: session.userId,
				});
				await ctx.scheduler.runAfter(0, internal.agent.knowledgeBackfill.runChunk, {
					jobId,
					chunkSize: 30,
				});
				await recordAuditLog(ctx, {
					userId: session.userId,
					action: 'agent.backfill_started',
					resource: 'agent_config',
					details: { jobId },
				});
			}
		}

		// Side effect: an explicit false→true toggle of `ai.knowledge.autoLink`
		// kicks off the one-shot knowledge-graph EDGE backfill — the LLM inference
		// pass only fires on fresh ingestion, so without this retroactive walk the
		// existing corpus has no inferred edges for graph retrieval to traverse.
		// Same first-run / explicit-only semantic as the agent backfill above
		// (gated on a separate job table so the two backfills don't share a gate).
		const autoLinkExplicitlyTurningOn =
			flag === 'ai.knowledge.autoLink' &&
			args.value === true &&
			stored['ai.knowledge.autoLink'] !== true;
		if (autoLinkExplicitlyTurningOn) {
			const alreadyHasJob = await ctx.runQuery(internal.knowledge.edgeBackfill.hasAnyJob, {});
			if (!alreadyHasJob) {
				const jobId = await ctx.runMutation(internal.knowledge.edgeBackfill.createJob, {
					triggeredBy: session.userId,
				});
				await ctx.scheduler.runAfter(0, internal.knowledge.edgeBackfill.runEdgeBackfill, { jobId });
				await recordAuditLog(ctx, {
					userId: session.userId,
					action: 'knowledge.edge_backfill_started',
					resource: 'knowledge_config',
					details: { jobId },
				});
			}
		}

		return { flags: next, cascaded };
	},
});

export const setFeaturePack = authedMutation({
	args: {
		pack: v.string(),
		value: v.boolean(),
	},
	handler: async (ctx, args) => {
		await requireAdminContext(ctx);

		if (!(args.pack in FEATURE_PACKS)) {
			throwInvalidInput(`Unknown feature pack: ${args.pack}`);
		}
		const packKey = args.pack as FeaturePackKey;

		const stored = await getStoredFlags(ctx);
		const { next, cascaded } = applyPackToggle(stored, packKey, args.value);

		const now = Date.now();
		const existing = await ctx.db.query('instanceSettings').first();
		const patch = { featureFlags: next, updatedAt: now };

		if (existing) {
			await ctx.db.patch(existing._id, patch);
		} else {
			await ctx.db.insert('instanceSettings', {
				...patch,
				createdAt: now,
			});
		}

		return { flags: next, cascaded };
	},
});

/** Validate, cascade-resolve, and persist the whole flag map onto the
 * singleton instanceSettings row. Shared by the admin mutation and the
 * setup-seed internal mutation so both stay the sole writer of the map. */
async function writeAllFlags(ctx: MutationCtx, flags: FeatureFlagState) {
	for (const key of Object.keys(flags)) {
		if (!(key in FEATURE_FLAGS)) {
			throwInvalidInput(`Unknown feature flag: ${key}`);
		}
	}

	const resolved = resolveFlags(flags);
	const now = Date.now();
	const existing = await ctx.db.query('instanceSettings').first();
	const patch = {
		featureFlags: resolved,
		updatedAt: now,
	};

	if (existing) {
		await ctx.db.patch(existing._id, patch);
		return existing._id;
	}
	return await ctx.db.insert('instanceSettings', { ...patch, createdAt: now });
}

export const setAllFeatureFlags = authedMutation({
	args: {
		flags: v.record(v.string(), v.boolean()),
	},
	handler: async (ctx, args) => {
		await requireAdminContext(ctx);
		return writeAllFlags(ctx, args.flags as FeatureFlagState);
	},
});

/**
 * Persist the setup wizard's chosen flags during first-run seeding. Called by
 * the `/seed/admin` HTTP action (no session yet), so it skips the admin gate —
 * it is reachable only from the instance-secret-protected seed path. Without
 * this, instanceSettings.featureFlags stays unset and every wizard selection is
 * silently discarded in favour of the compiled-in defaults.
 */
export const setAllInternal = internalMutation({
	args: {
		flags: v.record(v.string(), v.boolean()),
	},
	handler: async (ctx, args) => writeAllFlags(ctx, args.flags as FeatureFlagState),
});
