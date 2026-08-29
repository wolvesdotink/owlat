/**
 * Sieve-style inbound mail filters.
 *
 * Architecture:
 *   - Filters are stored as structured JSON (conditions + actions). NO `eval`,
 *     no shell-out — the evaluator below is a pure-JS dispatcher over a fixed
 *     allowlist of operators.
 *   - Conditions inside one filter are grouped by `matchType`: `all` AND-s them
 *     (the default, and what every filter written before the toggle means),
 *     `any` OR-s them. ONE grouping level only — mixed trees are a second
 *     grammar, and "define two filters" is still the escape hatch.
 *   - Filters run in `priority` ascending order. A matching filter whose
 *     `stopProcessing=true` halts further evaluation.
 *   - Actions accumulate (e.g. `markRead` + `addLabel` is one filter, two
 *     actions). The delivery pipeline applies the final state in one place.
 */

import { v } from 'convex/values';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import type { Id } from '../_generated/dataModel';
import { requireMailboxAccess } from './permissions';
import { getOrThrow, throwForbidden, throwInvalidInput } from '../_utils/errors';
import { removeFilterRunJob } from './filterRun';
import { evalMessageFromRow, filterConditionsMatch } from './filtersEval';

// ── Public CRUD ───────────────────────────────────────────────────

// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const list = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) return [];
		return ctx.db
			.query('mailFilters')
			.withIndex('by_mailbox_and_priority', (q) => q.eq('mailboxId', args.mailboxId))
			.collect(); // bounded: one mailbox's filters
	},
});

const conditionValidator = v.object({
	field: v.union(
		v.literal('from'),
		v.literal('to'),
		v.literal('cc'),
		v.literal('subject'),
		v.literal('body'),
		v.literal('header'),
		v.literal('size'),
		v.literal('hasAttachment')
	),
	headerName: v.optional(v.string()),
	op: v.union(
		v.literal('contains'),
		v.literal('notContains'),
		v.literal('equals'),
		v.literal('matches'),
		v.literal('greaterThan'),
		v.literal('lessThan'),
		v.literal('isTrue')
	),
	value: v.optional(v.string()),
	valueNumber: v.optional(v.number()),
});

/** One grouping level: `all` AND-s the conditions, `any` OR-s them. */
const matchTypeValidator = v.union(v.literal('all'), v.literal('any'));

const actionValidator = v.object({
	type: v.union(
		v.literal('moveToFolder'),
		v.literal('addLabel'),
		v.literal('markRead'),
		v.literal('markFlagged'),
		v.literal('forward'),
		v.literal('delete'),
		v.literal('pinToSection'),
		v.literal('discard')
	),
	folderId: v.optional(v.id('mailFolders')),
	labelId: v.optional(v.id('mailLabels')),
	forwardTo: v.optional(v.string()),
	sectionName: v.optional(v.string()),
});

/**
 * Longest section name we persist. The name IS the section's identity (there is
 * no section table — the inbox's sections are derived from the enabled filters
 * that name one), so it is bounded here rather than only in the UI: an unbounded
 * name would become an unbounded index key on every message it files.
 */
export const MAX_SECTION_NAME_LENGTH = 60;

/**
 * Normalise a section name to the form stored on the message row and used as the
 * section's identity: trimmed, inner whitespace collapsed, length-capped. Two
 * filters that name "Deploys" and " Deploys " are the same section — which is
 * what a user typing the name twice means.
 */
export function normalizeSectionName(name: string): string {
	return name.replace(/\s+/g, ' ').trim().slice(0, MAX_SECTION_NAME_LENGTH);
}

/**
 * Canonicalise the actions of a filter before they are persisted. Only
 * `pinToSection` has anything to canonicalise today: its `sectionName` is
 * normalised here — at the ONE write boundary — so the name stored on the filter
 * is byte-identical to the name later stamped onto every message row, and a
 * `pinToSection` with no usable name is rejected rather than silently filing
 * mail into a section nothing can name.
 */
export function normalizeFilterActions<
	T extends { type: string; sectionName?: string | undefined },
>(actions: T[]): T[] {
	return actions.map((action) => {
		if (action.type !== 'pinToSection') return action;
		const sectionName = normalizeSectionName(action.sectionName ?? '');
		if (!sectionName) throwInvalidInput('A pin-to-section action needs a section name');
		return { ...action, sectionName };
	});
}

export const create = authedMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		name: v.string(),
		isEnabled: v.optional(v.boolean()),
		priority: v.optional(v.number()),
		conditions: v.array(conditionValidator),
		actions: v.array(actionValidator),
		matchType: v.optional(matchTypeValidator),
		stopProcessing: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		// Mail filters change how a mailbox routes/labels incoming mail for
		// everyone who uses it — owner-grade.
		const owned = await requireMailboxAccess(ctx, args.mailboxId, 'owner');
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		const trimmed = args.name.trim();
		if (!trimmed) throwInvalidInput('Filter name required');
		if (args.conditions.length === 0) {
			throwInvalidInput('At least one condition is required');
		}
		if (args.actions.length === 0) {
			throwInvalidInput('At least one action is required');
		}
		const actions = normalizeFilterActions(args.actions);
		// Validate any folder/label refs belong to this mailbox
		for (const action of actions) {
			if (action.folderId) {
				const folder = await ctx.db.get(action.folderId);
				if (!folder || folder.mailboxId !== args.mailboxId) {
					throwInvalidInput('moveToFolder action references unknown folder');
				}
			}
			if (action.labelId) {
				const label = await ctx.db.get(action.labelId);
				if (!label || label.mailboxId !== args.mailboxId) {
					throwInvalidInput('addLabel action references unknown label');
				}
			}
		}

		const now = Date.now();
		// If priority not provided, append at end
		let priority = args.priority;
		if (priority === undefined) {
			const existing = await ctx.db
				.query('mailFilters')
				.withIndex('by_mailbox_and_priority', (q) => q.eq('mailboxId', args.mailboxId))
				.collect(); // bounded: one mailbox's filters
			priority = existing.length === 0 ? 100 : Math.max(...existing.map((f) => f.priority)) + 100;
		}
		return ctx.db.insert('mailFilters', {
			mailboxId: args.mailboxId,
			name: trimmed,
			isEnabled: args.isEnabled ?? true,
			priority,
			conditions: args.conditions,
			actions,
			// Absent means `all` — the pre-toggle meaning — so an omitted arg
			// stores nothing rather than stamping a default onto every row.
			...(args.matchType && args.matchType !== 'all' ? { matchType: args.matchType } : {}),
			stopProcessing: args.stopProcessing ?? false,
			createdAt: now,
			updatedAt: now,
		});
	},
});

export const update = authedMutation({
	args: {
		filterId: v.id('mailFilters'),
		name: v.optional(v.string()),
		isEnabled: v.optional(v.boolean()),
		priority: v.optional(v.number()),
		conditions: v.optional(v.array(conditionValidator)),
		actions: v.optional(v.array(actionValidator)),
		matchType: v.optional(matchTypeValidator),
		stopProcessing: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		const filter = await getOrThrow(ctx, args.filterId, 'Filter');
		const owned = await requireMailboxAccess(ctx, filter.mailboxId, 'owner');
		if (!owned.ok) throwForbidden('Filter not accessible');

		const patch: Record<string, unknown> = { updatedAt: Date.now() };
		if (args.name !== undefined) patch['name'] = args.name.trim();
		if (args.isEnabled !== undefined) patch['isEnabled'] = args.isEnabled;
		if (args.priority !== undefined) patch['priority'] = args.priority;
		if (args.conditions !== undefined) patch['conditions'] = args.conditions;
		if (args.actions !== undefined) patch['actions'] = normalizeFilterActions(args.actions);
		// `all` clears the field rather than storing it, keeping "absent = today's
		// behavior" true for a filter that is toggled back.
		if (args.matchType !== undefined) {
			patch['matchType'] = args.matchType === 'all' ? undefined : args.matchType;
		}
		if (args.stopProcessing !== undefined) patch['stopProcessing'] = args.stopProcessing;
		await ctx.db.patch(args.filterId, patch);
	},
});

export const remove = authedMutation({
	args: { filterId: v.id('mailFilters') },
	handler: async (ctx, args) => {
		const filter = await ctx.db.get(args.filterId);
		if (!filter) return;
		const owned = await requireMailboxAccess(ctx, filter.mailboxId, 'owner');
		if (!owned.ok) throwForbidden('Filter not accessible');
		// The retroactive-run job is bookkeeping ABOUT this filter; leaving it
		// behind would strand a "running" row whose next batch stops on a missing
		// filter and can never be started or cancelled again.
		await removeFilterRunJob(ctx, args.filterId);
		await ctx.db.delete(args.filterId);
	},
});

/**
 * Priority step between adjacent filters after a reorder. Kept wide (matching
 * the append step in `create`) so a later single-filter insert has room between
 * two neighbours without rewriting the run.
 */
const PRIORITY_STEP = 100;

/**
 * Write a new run order in one transaction.
 *
 * `priority` decided evaluation order from day one — and `stopProcessing` makes
 * that order load-bearing — but there was no way to change it, so a rule that
 * needed to run first could only be recreated. The caller sends the ids in the
 * order it wants and gets 100, 200, 300…; ids from another mailbox are skipped
 * rather than fatal, so a stale list cannot sink the whole reorder.
 */
export const reorder = authedMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		/** Filter ids, first to run to last. */
		filterIds: v.array(v.id('mailFilters')),
	},
	handler: async (ctx, args): Promise<void> => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId, 'owner');
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		const now = Date.now();
		let slot = 0;
		for (const filterId of args.filterIds) {
			const filter = await ctx.db.get(filterId);
			if (!filter || filter.mailboxId !== args.mailboxId) continue;
			slot += 1;
			const priority = slot * PRIORITY_STEP;
			if (filter.priority === priority) continue;
			await ctx.db.patch(filterId, { priority, updatedAt: now });
		}
	},
});

/**
 * How much recent mail the dry-run preview evaluates. A preview is a sanity
 * check ("does this catch what I think it catches?"), not a search, so it reads
 * a fixed recent window and says so.
 */
export const PREVIEW_SCAN_WINDOW = 300;

/** Rows the preview hands back — enough to recognise a message, no body. */
export interface FilterPreviewMatch {
	messageId: Id<'mailMessages'>;
	fromAddress: string;
	subject: string;
	receivedAt: number;
}

/**
 * Dry-run: which of the mailbox's recent messages would this rule match?
 *
 * Takes the DRAFT conditions rather than a saved filter id, so the preview runs
 * against what is on screen — the point is to see the rule before committing to
 * it. Runs the exact same `filterConditionsMatch` the delivery pipeline uses;
 * a preview computed by a second, parallel implementation would be worth less
 * than no preview at all.
 */
// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const preview = publicQuery({
	args: {
		mailboxId: v.id('mailboxes'),
		conditions: v.array(conditionValidator),
		matchType: v.optional(matchTypeValidator),
		limit: v.optional(v.number()),
	},
	handler: async (
		ctx,
		args
	): Promise<{ matches: FilterPreviewMatch[]; scanned: number; matchCount: number }> => {
		const empty = { matches: [], scanned: 0, matchCount: 0 };
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) return empty;
		if (args.conditions.length === 0) return empty;

		const scanned = await ctx.db
			.query('mailMessages')
			.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', args.mailboxId))
			.order('desc')
			.take(PREVIEW_SCAN_WINDOW);

		const draft = { conditions: args.conditions, matchType: args.matchType };
		const matching: typeof scanned = [];
		for (const m of scanned) {
			if (filterConditionsMatch(draft, await evalMessageFromRow(m))) matching.push(m);
		}
		const limit = Math.min(Math.max(1, args.limit ?? 20), 100);
		return {
			matches: matching.slice(0, limit).map((m) => ({
				messageId: m._id,
				fromAddress: m.fromAddress,
				subject: m.subject,
				receivedAt: m.receivedAt,
			})),
			scanned: scanned.length,
			// The honest total inside the window, so the panel can say "12 of the
			// last 300" instead of implying the preview is the whole answer.
			matchCount: matching.length,
		};
	},
});

// ── Pure evaluator ────────────────────────────────────────────────
//
// Lives in ./filtersEval (this file was over the size cap). Re-exported here so
// every existing importer — delivery, the preview, the retroactive sweep —
// keeps reaching it through `mail/filters`.
export { filterConditionsMatch, evalMessageFromRow, evaluateFilters } from './filtersEval';
export type { EvalMessage, EvalResult, EvalResultAction } from './filtersEval';
