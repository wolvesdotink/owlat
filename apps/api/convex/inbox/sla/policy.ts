/**
 * Team Inbox response targets (SLA) — the stored policy: read, save, and the
 * reader every clock writer uses.
 *
 * One row per workspace (`inboxSlaPolicies`); absent = off. Saving is
 * owner/admin, behind the `inbox` flag, and audited. Switching targets on
 * starts a clock on every open thread already waiting; switching them off
 * clears the running ones (`./apply.ts`). Changing the targets or hours of an
 * enabled policy applies to clocks started from then on.
 */

import type { QueryCtx } from '../../_generated/server';
import type { Doc } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import { adminMutation, adminQuery, featureGated } from '../../lib/authedFunctions';
import { recordAuditLog } from '../../lib/auditLog';
import { omit } from '../../lib/validators/fields';
import { inboxSlaPolicyFields } from '../../lib/validators/inboxSla';
import { throwInvalidInput } from '../../_utils/errors';
import { normalizeSlaPolicy, slaPolicyProblem, slaPolicyView } from './policyRules';
import type { SlaPolicyView } from './clock';

/** Owner/admin reads behind the `inbox` flag: the Team Inbox's own floor. */
export const teamInboxAdminQuery = featureGated(adminQuery, 'inbox');
/** Owner/admin writes behind the `inbox` flag. */
export const teamInboxAdminMutation = featureGated(adminMutation, 'inbox');

/** The stored policy row, or null when none was ever saved. */
export async function readSlaPolicyRow(ctx: {
	db: QueryCtx['db'];
}): Promise<Doc<'inboxSlaPolicies'> | null> {
	return ctx.db.query('inboxSlaPolicies').first();
}

/** The policy the clock runs on, or null when targets are off. */
export async function loadSlaPolicy(ctx: { db: QueryCtx['db'] }): Promise<SlaPolicyView | null> {
	return slaPolicyView(await readSlaPolicyRow(ctx));
}

/** The saved policy for the settings page; `null` = never saved (the page shows its defaults). */
export const getPolicy = teamInboxAdminQuery({
	args: {},
	handler: async (ctx) => {
		const row = await readSlaPolicyRow(ctx);
		if (!row) return null;
		const { _id, _creationTime, ...policy } = row;
		return policy;
	},
});

/** Save the policy. Validated, audited; schedules the sweep in `./apply.ts`. */
export const savePolicy = teamInboxAdminMutation({
	args: omit(inboxSlaPolicyFields, ['updatedAt']),
	handler: async (ctx, args, session) => {
		const problem = slaPolicyProblem(args);
		if (problem) throwInvalidInput(problem);
		const policy = normalizeSlaPolicy(args);
		const now = Date.now();
		const existing = await readSlaPolicyRow(ctx);
		if (existing) await ctx.db.patch(existing._id, { ...policy, updatedAt: now });
		else await ctx.db.insert('inboxSlaPolicies', { ...policy, updatedAt: now });

		// Every save supersedes a sweep still walking (`./apply.ts` checks the
		// generation), so every save starts its own; re-running one is harmless.
		await ctx.scheduler.runAfter(0, internal.inbox.sla.apply.applyPage, {
			generation: now,
			cursor: null,
		});

		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'settings.inbox_sla_updated',
			resource: 'settings',
			details: {
				isEnabled: policy.isEnabled,
				firstResponseMinutes: policy.firstResponseMinutes,
				nextResponseMinutes: policy.nextResponseMinutes,
				hoursMode: policy.hoursMode,
				timeZone: policy.timeZone,
			},
		});
		return { success: true as const };
	},
});
