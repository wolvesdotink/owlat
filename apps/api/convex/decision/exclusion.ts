/**
 * The per-mailbox opt-out from hosted decisions (ADR-0060 §9): a mailbox, or
 * the Team Inbox, whose mail must never reach a decision provider outside the
 * operator's own hardware. TypeSafe, the language-backed adapter and any other
 * hosted endpoint (`lib/llm/endpointLocality.ts`) are refused; only the local
 * decision engine may judge it. Absent ⇒ not excluded, so nothing changes for
 * an existing install.
 *
 * Enforced twice: when a bundle is scheduled (`./schedule.ts` through
 * `./context.ts schedulingGate`) and again inside the claim mutation right
 * before the call (`./artifacts.ts claim`), against the endpoint the call is
 * about to use. An excluded mailbox keeps today's behaviour: no bundle call
 * and no shadow.
 */

import { v } from 'convex/values';
import type { Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { adminMutation } from '../lib/authedFunctions';
import { recordAuditLog } from '../lib/auditLog';
import { getOrThrow } from '../_utils/errors';
import { AGENT_CONFIG_INSERT_DEFAULTS } from '../lib/agentConfigDefaults';

/** A Team message is the Team Inbox's; a Postbox message its mailbox's. */
export type ExclusionScope =
	| { readonly kind: 'team_inbox' }
	| { readonly kind: 'mailbox'; readonly mailboxId: Id<'mailboxes'> };

/** Whether `scope`'s mail is excluded from hosted decision providers. */
export async function isExcludedFromHostedDecisions(
	ctx: { db: QueryCtx['db'] },
	scope: ExclusionScope
): Promise<boolean> {
	if (scope.kind === 'team_inbox') {
		const config = await ctx.db.query('agentConfig').first(); // bounded: singleton
		return config?.isExcludedFromHostedDecisions === true;
	}
	return (await ctx.db.get(scope.mailboxId))?.isExcludedFromHostedDecisions === true;
}

/**
 * Exclude a mailbox or the Team Inbox from hosted decision providers, or
 * readmit it. Admin only, audited. The web settings toggle calls this.
 */
export const setHostedDecisionExclusion = adminMutation({
	args: {
		target: v.union(
			v.object({ kind: v.literal('team_inbox') }),
			v.object({ kind: v.literal('mailbox'), mailboxId: v.id('mailboxes') })
		),
		isExcluded: v.boolean(),
	},
	returns: v.null(),
	handler: async (ctx, args, session) => {
		const now = Date.now();
		if ((await isExcludedFromHostedDecisions(ctx, args.target)) === args.isExcluded) return null;
		if (args.target.kind === 'mailbox') {
			await getOrThrow(ctx, args.target.mailboxId, 'Mailbox');
			await ctx.db.patch(args.target.mailboxId, {
				isExcludedFromHostedDecisions: args.isExcluded,
				updatedAt: now,
			});
		} else {
			const config = await ctx.db.query('agentConfig').first(); // bounded: singleton
			if (config) {
				await ctx.db.patch(config._id, {
					isExcludedFromHostedDecisions: args.isExcluded,
					updatedAt: now,
				});
			} else {
				await ctx.db.insert('agentConfig', {
					isAutoReplyEnabled: false,
					...AGENT_CONFIG_INSERT_DEFAULTS,
					isExcludedFromHostedDecisions: args.isExcluded,
					createdAt: now,
					updatedAt: now,
				});
			}
		}
		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'ai_decision_exclusion.updated',
			resource: 'ai_routing_policy',
			resourceId: args.target.kind === 'mailbox' ? args.target.mailboxId : 'team_inbox',
			details: { target: args.target.kind, isExcluded: args.isExcluded },
		});
		return null;
	},
});
