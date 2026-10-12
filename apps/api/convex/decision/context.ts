/**
 * What a decision bundle run and the block-only auto-send gate read from the
 * database (ADR-0073): the routing policy, the `ai.decisionPlane` flag, the
 * configured decision plane's identity, and the verdicts that feed auto-send.
 * Queries only; actions reach them through `ctx.runQuery`.
 */

import { v } from 'convex/values';
import type { ResolvedRoutingPolicy } from '@owlat/shared/aiRouting';
import { internalQuery } from '../_generated/server';
import { isFeatureEnabled } from '../lib/featureFlags';
import { loadRoutingPolicy } from '../aiRouting/policy';
import { configVersionOf, isLocalDecisionEngine } from '../lib/decision/configIdentity';
import { isExcludedFromHostedDecisions } from './exclusion';
import type { StoredVerdict } from '../lib/decision/calibration';
import { aiTaskNameValidator } from '../lib/validators/aiRouting';
import { isItemCoverageEnforced } from '../mail/interpret/planGate';

/** Verdicts one message can hold per task: one per policy version. Bounded. */
const VERDICTS_PER_TASK = 32;

export interface RoutingContext {
	readonly policy: ResolvedRoutingPolicy;
	readonly isDecisionPlaneOn: boolean;
	/**
	 * The `aiProviderConfig` row's version (`configVersionOf`) in the same read
	 * (absent without a row): the configuration the rung is decided on. The run
	 * refuses a resolution read from any other one, and the claim refuses once
	 * it has changed.
	 */
	readonly configVersion?: string;
}

/** Everything a bundle run decides its plan and rung on, in one read. */
export const routingContext = internalQuery({
	args: {},
	handler: async (ctx): Promise<RoutingContext> => {
		const config = await ctx.db.query('aiProviderConfig').first(); // bounded: singleton
		return {
			policy: await loadRoutingPolicy(ctx),
			isDecisionPlaneOn: await isFeatureEnabled(ctx, 'ai.decisionPlane'),
			...(config ? { configVersion: configVersionOf(config) } : {}),
		};
	},
});

/**
 * The scheduling check (ADR-0060 §9): the policy, and whether a bundle may be
 * scheduled for this message's mailbox at all. An excluded mailbox, or the
 * excluded Team Inbox, may only be judged by the local decision engine; every
 * other plane is hosted. `./artifacts.ts claim` checks again at dispatch.
 */
export const schedulingGate = internalQuery({
	args: { threadId: v.optional(v.id('mailThreads')) },
	handler: async (ctx, args): Promise<{ policy: ResolvedRoutingPolicy; isAllowed: boolean }> => {
		const policy = await loadRoutingPolicy(ctx);
		// The gate today's classifier honours: the Team Inbox's agent (which
		// requires `ai`), or Postbox's `ai`. `./artifacts.ts claim` reads it again.
		const gate = args.threadId === undefined ? 'ai.agent' : 'ai';
		if (!(await isFeatureEnabled(ctx, gate))) return { policy, isAllowed: false };
		let mailboxId;
		if (args.threadId !== undefined) {
			const thread = await ctx.db.get(args.threadId);
			if (!thread) return { policy, isAllowed: false };
			mailboxId = thread.mailboxId;
		}
		const isExcluded = await isExcludedFromHostedDecisions(
			ctx,
			mailboxId === undefined ? { kind: 'team_inbox' } : { kind: 'mailbox', mailboxId }
		);
		if (!isExcluded) return { policy, isAllowed: true };
		const isDecisionPlaneOn = await isFeatureEnabled(ctx, 'ai.decisionPlane');
		const row = await ctx.db.query('aiProviderConfig').first(); // bounded: singleton
		return { policy, isAllowed: isLocalDecisionEngine(row, isDecisionPlaneOn) };
	},
});

/**
 * The gate's inputs: every artifact of `tasks` about the message, of any kind
 * and state (a stale one blocks too), plus what they are compared with now.
 * `isTruncated`: more than the bound exist, and the gate holds rather than
 * judge a partial set. `isItemCoverageEnforced`: the prerequisite of any
 * decision-driven autonomous input (`lib/decision/autoSendContract.ts`).
 */
export const autoSendVerdictInputs = internalQuery({
	args: { inboundMessageId: v.id('inboundMessages'), tasks: v.array(aiTaskNameValidator) },
	handler: async (ctx, args) => {
		const verdicts: StoredVerdict[] = [];
		let isTruncated = false;
		for (const task of args.tasks) {
			const rows = await ctx.db
				.query('decisionArtifacts')
				.withIndex('by_inbound_message', (q) =>
					q.eq('inboundMessageId', args.inboundMessageId).eq('task', task)
				)
				.take(VERDICTS_PER_TASK + 1);
			isTruncated ||= rows.length > VERDICTS_PER_TASK;
			verdicts.push(...rows.slice(0, VERDICTS_PER_TASK));
		}
		const isCoverageEnforced = await isItemCoverageEnforced(ctx);
		if (verdicts.length === 0) {
			return { verdicts, isTruncated, isItemCoverageEnforced: isCoverageEnforced, current: null };
		}
		const message = await ctx.db.get(args.inboundMessageId);
		return {
			verdicts,
			isTruncated,
			isItemCoverageEnforced: isCoverageEnforced,
			current: {
				policyVersion: (await loadRoutingPolicy(ctx)).policyVersion,
				isDecisionPlaneOn: await isFeatureEnabled(ctx, 'ai.decisionPlane'),
				language: message?.classification?.language,
			},
		};
	},
});

/** Artifacts of one task one message's read covers when looking for applied verdicts. Bounded. */
const APPLIED_SCAN = 256;

/**
 * The applied-decision gate's inputs (`agent/steps/route/appliedDecisionGate.ts`):
 * the ADVISORY artifacts of `tasks` about the message (enforced verdicts that
 * were applied; shadow observations are left out), and what they are compared
 * with now. `isTruncated`: more artifacts than the bound, and the gate holds.
 */
export const appliedVerdictInputs = internalQuery({
	args: { inboundMessageId: v.id('inboundMessages'), tasks: v.array(aiTaskNameValidator) },
	handler: async (ctx, args) => {
		const applied: StoredVerdict[] = [];
		let isTruncated = false;
		for (const task of args.tasks) {
			const rows = await ctx.db
				.query('decisionArtifacts')
				.withIndex('by_inbound_message', (q) =>
					q.eq('inboundMessageId', args.inboundMessageId).eq('task', task).eq('kind', 'advisory')
				)
				.take(APPLIED_SCAN + 1);
			// Shadow observations are never read, so they never count toward the bound.
			isTruncated ||= rows.length > APPLIED_SCAN;
			applied.push(...rows.slice(0, APPLIED_SCAN));
		}
		const isCoverageEnforced = await isItemCoverageEnforced(ctx);
		if (applied.length === 0) {
			return { applied, isTruncated, isItemCoverageEnforced: isCoverageEnforced, current: null };
		}
		const message = await ctx.db.get(args.inboundMessageId);
		return {
			applied,
			isTruncated,
			isItemCoverageEnforced: isCoverageEnforced,
			current: {
				policyVersion: (await loadRoutingPolicy(ctx)).policyVersion,
				isDecisionPlaneOn: await isFeatureEnabled(ctx, 'ai.decisionPlane'),
				language: message?.classification?.language,
			},
		};
	},
});
