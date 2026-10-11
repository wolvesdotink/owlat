/**
 * The AI routing policy (ADR-0073, SPEC §3): read and save.
 *
 * One stored row (`aiRoutingPolicy`), absent until an admin first saves; a
 * missing row means every default, and every default is today's behaviour.
 * Every lane reads the policy through {@link loadRoutingPolicy} (a query or
 * mutation) or `internal.aiRouting.policy.getResolved` (an action), which both
 * return the complete typed `ResolvedRoutingPolicy` from
 * `@owlat/shared/aiRouting`.
 *
 * Saving is admin-only, validated, compare-and-set on `policyVersion` (two
 * admins cannot silently overwrite each other), and audited. Every save that
 * changes something bumps `policyVersion`, which artifacts and ledger rows
 * record so a policy change invalidates what was decided under the old one.
 */

import { v } from 'convex/values';
import {
	resolveRoutingPolicy,
	routingPolicyProblem,
	ROUTING_CAP_MAX,
	ROUTING_CAP_MIN,
	ROUTING_SWITCH_KEYS,
	SHADOW_FRACTION_MAXIMA,
	shadowAllowanceUsd,
	shadowedSwitches,
	type ResolvedRoutingPolicy,
	type RoutingPolicyRow,
} from '@owlat/shared/aiRouting';
import type { Doc } from '../_generated/dataModel';
import { internalQuery, type QueryCtx } from '../_generated/server';
import { adminMutation, adminQuery } from '../lib/authedFunctions';
import { recordAuditLog } from '../lib/auditLog';
import { throwConflict, throwInvalidInput } from '../_utils/errors';
import { resolveBudgetConfig } from '../analytics/spendBudget';
import { taskPolicy } from '../lib/llm/taskPolicy';
import { aiTaskNameValidator, routingSwitchFields } from '../lib/validators/aiRouting';

type PolicyRow = Doc<'aiRoutingPolicy'>;

/** The stored row, or null when no admin has saved a policy. */
export async function readRoutingPolicyRow(ctx: { db: QueryCtx['db'] }): Promise<PolicyRow | null> {
	return ctx.db.query('aiRoutingPolicy').first();
}

/** The complete policy for a query or mutation. A missing row reads as the defaults. */
export async function loadRoutingPolicy(ctx: {
	db: QueryCtx['db'];
}): Promise<ResolvedRoutingPolicy> {
	return resolveRoutingPolicy(await readRoutingPolicyRow(ctx));
}

/** The complete policy for an action (`ctx.runQuery`). */
export const getResolved = internalQuery({
	args: {},
	handler: (ctx): Promise<ResolvedRoutingPolicy> => loadRoutingPolicy(ctx),
});

/**
 * The settings page's read: the policy, the defaults beside it, and what the
 * shadow allowance comes to under the configured daily ceiling right now.
 */
export const get = adminQuery({
	args: {},
	handler: async (ctx) => {
		const row = await readRoutingPolicyRow(ctx);
		const policy = resolveRoutingPolicy(row);
		const budget = resolveBudgetConfig();
		return {
			policy,
			defaults: resolveRoutingPolicy(null),
			isStored: row !== null,
			dailyCeilingUsd: budget.dailyUsd,
			monthlyCeilingUsd: budget.monthlyUsd,
			shadowedSwitches: shadowedSwitches(policy),
			shadowAllowanceUsd: shadowAllowanceUsd(policy, budget.dailyUsd),
			capBounds: { min: ROUTING_CAP_MIN, max: ROUTING_CAP_MAX },
			shadowFractionMaxima: SHADOW_FRACTION_MAXIMA,
		};
	},
});

/** The stored fields a save may change: the row minus its bookkeeping. */
type EditableFields = Omit<
	PolicyRow,
	'_id' | '_creationTime' | 'policyVersion' | 'updatedAt' | 'updatedBy'
>;
type EditableKey = keyof EditableFields;

/** Nullable settings: `null` clears the stored value back to unset. */
const CLEARABLE_KEYS = [
	'knowledgeEntryCapPerMessage',
	'verifyClaimCapPerMessage',
	'shadowCapUsd',
] as const;

const EDITABLE_KEYS: readonly EditableKey[] = [
	...ROUTING_SWITCH_KEYS,
	...CLEARABLE_KEYS,
	'promptCacheTasks',
	'triageAllowanceFraction',
	'shadowMaxMessageFraction',
	'shadowMaxCeilingFraction',
];

function editableFieldsOf(row: PolicyRow | null): EditableFields {
	if (!row) return {};
	const {
		_id: _rowId,
		_creationTime: _created,
		policyVersion: _version,
		updatedAt: _updatedAt,
		updatedBy: _updatedBy,
		...fields
	} = row;
	return fields;
}

/** Prompt-cache markers are a language-plane concern (L9). */
function promptCacheProblem(tasks: readonly string[] | undefined): string | null {
	for (const task of tasks ?? []) {
		const policy = taskPolicy(task as Parameters<typeof taskPolicy>[0]);
		if (policy.plane !== 'language') return `${task} is not a language task; it cannot be cached.`;
	}
	return null;
}

/**
 * Save the policy. Absent arguments keep their stored value; `null` clears a
 * cap or the shadow cap. `expectedPolicyVersion` must be the version the admin
 * loaded (0 before the first save).
 */
export const update = adminMutation({
	args: {
		expectedPolicyVersion: v.number(),
		...routingSwitchFields,
		knowledgeEntryCapPerMessage: v.optional(v.union(v.number(), v.null())),
		verifyClaimCapPerMessage: v.optional(v.union(v.number(), v.null())),
		shadowCapUsd: v.optional(v.union(v.number(), v.null())),
		promptCacheTasks: v.optional(v.array(aiTaskNameValidator)),
		triageAllowanceFraction: v.optional(v.number()),
		shadowMaxMessageFraction: v.optional(v.number()),
		shadowMaxCeilingFraction: v.optional(v.number()),
	},
	handler: async (ctx, args, session): Promise<ResolvedRoutingPolicy> => {
		const row = await readRoutingPolicyRow(ctx);
		const currentVersion = row?.policyVersion ?? 0;
		if (args.expectedPolicyVersion !== currentVersion) {
			throwConflict('The AI routing policy was changed by someone else. Reload and try again.', {
				currentPolicyVersion: currentVersion,
			});
		}

		const before = editableFieldsOf(row);
		const next: Record<string, unknown> = { ...before };
		for (const key of EDITABLE_KEYS) {
			const value = args[key];
			if (value === undefined) continue;
			if (value === null) delete next[key];
			else next[key] = value;
		}

		const problem =
			routingPolicyProblem(next as RoutingPolicyRow, {
				dailyCeilingUsd: resolveBudgetConfig().dailyUsd,
			}) ?? promptCacheProblem(next['promptCacheTasks'] as readonly string[] | undefined);
		if (problem) throwInvalidInput(problem);

		// Compared as resolved, so storing a default explicitly is no change.
		const resolvedBefore = resolveRoutingPolicy(row);
		const resolvedNext = resolveRoutingPolicy(next as RoutingPolicyRow);
		const changes: Record<string, { from: unknown; to: unknown }> = {};
		for (const key of EDITABLE_KEYS) {
			const from = resolvedBefore[key];
			const to = resolvedNext[key];
			if (JSON.stringify(from) !== JSON.stringify(to)) changes[key] = { from, to };
		}
		const changedFields = Object.keys(changes);
		if (changedFields.length === 0) return resolveRoutingPolicy(row);

		const stored = {
			...(next as EditableFields),
			policyVersion: currentVersion + 1,
			updatedAt: Date.now(),
			updatedBy: session.userId,
		};
		if (row) await ctx.db.replace(row._id, stored);
		else await ctx.db.insert('aiRoutingPolicy', stored);

		await recordAuditLog(ctx, {
			userId: session.userId,
			organizationId: session.activeOrganizationId,
			action: 'ai_routing_policy.updated',
			resource: 'ai_routing_policy',
			details: { policyVersion: stored.policyVersion, changedFields: changedFields.join(',') },
			detailsBlob: JSON.stringify({ changes }),
		});
		return resolveRoutingPolicy(stored);
	},
});
