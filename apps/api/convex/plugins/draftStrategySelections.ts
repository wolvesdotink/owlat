import { v } from 'convex/values';
import { authedMutation, authedQuery } from '../lib/authedFunctions';
import { internalQuery, type QueryCtx } from '../_generated/server';
import {
	requireAdminContext,
	requireOrgPermission,
	getSingletonOrganizationId,
} from '../lib/sessionOrganization';
import { DRAFT_STRATEGY_CATALOG, isRegisteredDraftStrategy } from './draftStrategyCatalog';

const scopeValidator = v.union(
	v.object({ type: v.literal('mailbox'), id: v.id('mailboxes') }),
	v.object({ type: v.literal('contact'), id: v.id('contacts') }),
	v.object({ type: v.literal('classification'), id: v.string() })
);

export interface DraftStrategySelectionScope {
	readonly mailboxId?: string;
	readonly contactId?: string;
	readonly classification: string;
}

/** Contact overrides mailbox, which overrides classification; absence means default. */
export async function resolveDraftStrategySelection(
	ctx: QueryCtx,
	organizationId: string,
	scope: DraftStrategySelectionScope
): Promise<string> {
	const candidates = [
		scope.contactId ? (['contact', scope.contactId] as const) : undefined,
		scope.mailboxId ? (['mailbox', scope.mailboxId] as const) : undefined,
		['classification', scope.classification] as const,
	].filter(
		(candidate): candidate is readonly ['contact' | 'mailbox' | 'classification', string] =>
			candidate !== undefined
	);
	for (const [scopeType, scopeId] of candidates) {
		const row = await ctx.db
			.query('draftStrategySelections')
			.withIndex('by_organization_scope', (q) =>
				q.eq('organizationId', organizationId).eq('scopeType', scopeType).eq('scopeId', scopeId)
			)
			.unique();
		if (row) return row.strategyKind;
	}
	return 'default';
}

export const resolveForDraft = internalQuery({
	args: {
		mailboxId: v.optional(v.string()),
		contactId: v.optional(v.string()),
		classification: v.string(),
	},
	handler: async (ctx, args) =>
		resolveDraftStrategySelection(ctx, await getSingletonOrganizationId(ctx), args),
});

export const listCatalog = authedQuery({
	args: {},
	handler: async (ctx) => {
		await requireOrgPermission(ctx, 'settings:manage');
		return DRAFT_STRATEGY_CATALOG;
	},
});

export const setSelection = authedMutation({
	args: { scope: scopeValidator, strategyKind: v.string() },
	handler: async (ctx, args) => {
		await requireAdminContext(ctx);
		if (!isRegisteredDraftStrategy(args.strategyKind))
			throw new TypeError('Unknown draft strategy');
		if (args.scope.type === 'classification' && !/^[a-z][a-z0-9_-]{0,63}$/.test(args.scope.id))
			throw new TypeError('Invalid draft classification scope');
		if (args.scope.type !== 'classification' && !(await ctx.db.get(args.scope.id)))
			throw new TypeError('Unknown draft strategy scope');
		const organizationId = await getSingletonOrganizationId(ctx);
		const scopeId = String(args.scope.id);
		const existing = await ctx.db
			.query('draftStrategySelections')
			.withIndex('by_organization_scope', (q) =>
				q
					.eq('organizationId', organizationId)
					.eq('scopeType', args.scope.type)
					.eq('scopeId', scopeId)
			)
			.unique();
		if (args.strategyKind === 'default') {
			if (existing) await ctx.db.delete(existing._id);
			return null;
		}
		const now = Date.now();
		if (existing)
			await ctx.db.patch(existing._id, { strategyKind: args.strategyKind, updatedAt: now });
		else
			await ctx.db.insert('draftStrategySelections', {
				organizationId,
				scopeType: args.scope.type,
				scopeId,
				strategyKind: args.strategyKind,
				createdAt: now,
				updatedAt: now,
			});
		return null;
	},
});
