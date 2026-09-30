/**
 * Backfill the maintained counts (plan 3.1, migration 0048).
 *
 * Starts the counter walk for every scope that existed before its counters did:
 * the label, section and new-mail counters of each mailbox, and the campaign,
 * template and automation facet counters and subscriber growth. Each walk runs
 * in the background as a chain of bounded mutations
 * (`maintenance/counterBackfill.ts`); until a scope is ready its readers keep
 * their old bounded scans, so nothing waits on this.
 *
 *   npx convex run migrations/0048_backfill_counters:run
 *   npx convex run migrations/0048_backfill_counters:status
 *
 * Idempotent: a ready scope is left alone and a scope still walking is resumed
 * from its stored cursor. `'{"rebuild": true}'` drops every scope first and
 * counts again from scratch — the repair for a counter found out of step.
 */

import { v } from 'convex/values';
import { internalAction, internalQuery, type QueryCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import {
	clearCounterScope,
	counterScopeKey,
	startCounterScope,
	type CounterKind,
} from '../lib/counters';
import { logInfo } from '../lib/runtimeLog';
import { counterKindValidator } from '../schema/counters';

const PAGE_SIZE = 100;
const GLOBAL_KINDS: readonly CounterKind[] = [
	'campaignStatus',
	'templateType',
	'automationStatus',
	'contactCreatedDay',
];

type ScopeRef = { kind: CounterKind; ownerId?: string };

export const mailboxPage = internalQuery({
	args: { cursor: v.union(v.string(), v.null()) },
	handler: async (ctx, { cursor }) => {
		const result = await ctx.db.query('mailboxes').paginate({ numItems: PAGE_SIZE, cursor });
		return {
			mailboxIds: result.page.map((mailbox) => mailbox._id),
			cursor: result.continueCursor,
			isDone: result.isDone,
		};
	},
});

/** The per-mailbox scopes: labels mailbox-wide, sections and arrivals on the inbox. */
export const mailboxScopes = internalQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, { mailboxId }): Promise<ScopeRef[]> => {
		const inbox = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mailboxId).eq('role', 'inbox'))
			.first();
		const scopes: ScopeRef[] = [{ kind: 'mailLabelUnread', ownerId: mailboxId }];
		if (inbox) {
			scopes.push({ kind: 'mailSectionUnread', ownerId: inbox._id });
			scopes.push({ kind: 'mailFolderArrivals', ownerId: inbox._id });
		}
		return scopes;
	},
});

const scopeRefValidator = v.object({
	kind: counterKindValidator,
	ownerId: v.optional(v.string()),
});

/** Drop up to one batch of a scope; true while there is more to drop. */
export const clearScope = internalMutation({
	args: { scope: scopeRefValidator },
	handler: async (ctx, { scope }) =>
		clearCounterScope(ctx, counterScopeKey(scope.kind, scope.ownerId)),
});

/** Whether the mailbox or folder a per-owner scope belongs to still exists. */
async function scopeOwnerExists(ctx: QueryCtx, scope: ScopeRef): Promise<boolean> {
	if (scope.ownerId === undefined) return true;
	if (scope.kind === 'mailLabelUnread') {
		const mailboxId = ctx.db.normalizeId('mailboxes', scope.ownerId);
		return mailboxId !== null && (await ctx.db.get(mailboxId)) !== null;
	}
	const folderId = ctx.db.normalizeId('mailFolders', scope.ownerId);
	return folderId !== null && (await ctx.db.get(folderId)) !== null;
}

/**
 * Start (or resume) each scope's walk. A new scope gets its state row and a
 * first step; a scope still walking gets another step, which is how a chain
 * that died is picked up again; a ready scope is left alone.
 */
export const startScopes = internalMutation({
	args: { scopes: v.array(scopeRefValidator) },
	handler: async (ctx, { scopes }) => {
		const outcomes = { started: 0, running: 0, ready: 0 };
		for (const scope of scopes) {
			// The mailbox may have been purged since `mailboxPage` listed it; a scope
			// started now would outlive it with nothing left to delete it.
			if (!(await scopeOwnerExists(ctx, scope))) continue;
			const outcome = await startCounterScope(ctx, scope.kind, scope.ownerId);
			outcomes[outcome] += 1;
			if (outcome === 'ready') continue;
			await ctx.scheduler.runAfter(0, internal.maintenance.counterBackfill.step, {
				scope: counterScopeKey(scope.kind, scope.ownerId),
			});
		}
		return outcomes;
	},
});

export const run = internalAction({
	args: { rebuild: v.optional(v.boolean()) },
	handler: async (ctx, args): Promise<{ started: number; running: number; ready: number }> => {
		const totals = { started: 0, running: 0, ready: 0 };
		const startAll = async (scopes: ScopeRef[]) => {
			if (args.rebuild) {
				for (const scope of scopes) {
					let hasMore = true;
					while (hasMore) {
						hasMore = await ctx.runMutation(
							internal.migrations['0048_backfill_counters'].clearScope,
							{ scope }
						);
					}
				}
			}
			const outcome = await ctx.runMutation(
				internal.migrations['0048_backfill_counters'].startScopes,
				{ scopes }
			);
			totals.started += outcome.started;
			totals.running += outcome.running;
			totals.ready += outcome.ready;
		};

		await startAll(GLOBAL_KINDS.map((kind) => ({ kind })));

		let cursor: string | null = null;
		for (;;) {
			const page: { mailboxIds: Id<'mailboxes'>[]; cursor: string; isDone: boolean } =
				await ctx.runQuery(internal.migrations['0048_backfill_counters'].mailboxPage, { cursor });
			for (const mailboxId of page.mailboxIds) {
				const scopes: ScopeRef[] = await ctx.runQuery(
					internal.migrations['0048_backfill_counters'].mailboxScopes,
					{ mailboxId }
				);
				await startAll(scopes);
			}
			if (page.isDone) break;
			cursor = page.cursor;
		}
		logInfo('migration.0048_backfill_counters', totals);
		return totals;
	},
});

/** How far the walks are: scopes ready and still walking (first 5,000 scopes). */
export const status = internalQuery({
	args: {},
	handler: async (ctx) => {
		const scopes = await ctx.db.query('counterScopes').take(5000);
		const walking = scopes.filter((scope) => !scope.isReady);
		return {
			ready: scopes.length - walking.length,
			walking: walking.length,
			walkingScopes: walking.slice(0, 20).map((scope) => scope.scope),
		};
	},
});
