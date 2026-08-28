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
import type { Doc, Id } from '../_generated/dataModel';
import { requireMailboxAccess } from './permissions';
import { getOrThrow, throwForbidden, throwInvalidInput } from '../_utils/errors';
import { removeFilterRunJob } from './filterRun';
import { openMailMessageInlineBody } from '../lib/messageBody';

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
		v.literal('discard')
	),
	folderId: v.optional(v.id('mailFolders')),
	labelId: v.optional(v.id('mailLabels')),
	forwardTo: v.optional(v.string()),
});

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
		// Validate any folder/label refs belong to this mailbox
		for (const action of args.actions) {
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
			actions: args.actions,
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
		if (args.actions !== undefined) patch['actions'] = args.actions;
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

export interface EvalMessage {
	from: string;
	to: string[];
	cc: string[];
	subject: string;
	bodyText?: string;
	bodyHtml?: string;
	headers?: Record<string, string | undefined>;
	size: number;
	hasAttachment: boolean;
}

export interface EvalResultAction {
	type: 'moveToFolder' | 'addLabel' | 'markRead' | 'markFlagged' | 'forward' | 'delete' | 'discard';
	folderId?: Id<'mailFolders'>;
	labelId?: Id<'mailLabels'>;
	forwardTo?: string;
}

export interface EvalResult {
	matchedFilterIds: Id<'mailFilters'>[];
	actions: EvalResultAction[];
	stopped: boolean;
}

function fieldValue(message: EvalMessage, field: string, headerName?: string): unknown {
	switch (field) {
		case 'from':
			return message.from.toLowerCase();
		case 'to':
			return message.to.join(' ').toLowerCase();
		case 'cc':
			return message.cc.join(' ').toLowerCase();
		case 'subject':
			return (message.subject ?? '').toLowerCase();
		case 'body':
			return ((message.bodyText ?? '') + ' ' + (message.bodyHtml ?? '')).toLowerCase();
		case 'header':
			if (!headerName) return '';
			return (message.headers?.[headerName.toLowerCase()] ?? '').toLowerCase();
		case 'size':
			return message.size;
		case 'hasAttachment':
			return message.hasAttachment;
		default:
			return '';
	}
}

function compileRegex(pattern: string): RegExp | null {
	try {
		return new RegExp(pattern, 'i');
	} catch {
		return null;
	}
}

function conditionMatches(
	condition: Doc<'mailFilters'>['conditions'][number],
	message: EvalMessage
): boolean {
	const lhs = fieldValue(message, condition.field, condition.headerName);
	const value = (condition.value ?? '').toLowerCase();
	switch (condition.op) {
		case 'contains':
			return typeof lhs === 'string' && value.length > 0 && lhs.includes(value);
		case 'notContains':
			return typeof lhs === 'string' && (value.length === 0 || !lhs.includes(value));
		case 'equals':
			return typeof lhs === 'string' && lhs === value;
		case 'matches': {
			if (typeof lhs !== 'string') return false;
			const re = compileRegex(condition.value ?? '');
			return re ? re.test(lhs) : false;
		}
		case 'greaterThan':
			return typeof lhs === 'number' && lhs > (condition.valueNumber ?? 0);
		case 'lessThan':
			return typeof lhs === 'number' && lhs < (condition.valueNumber ?? 0);
		case 'isTrue':
			return Boolean(lhs);
		default:
			return false;
	}
}

/**
 * Does one filter's condition group match?
 *
 * The one place `matchType` is interpreted, so the delivery pipeline, the
 * dry-run preview and the run-on-existing-mail sweep can never disagree about
 * what a rule means. `matchType` absent is `all`, which is what every filter
 * written before the toggle meant.
 *
 * A filter with no conditions matches NOTHING — under `any` an empty group
 * would otherwise vacuously match every message in the mailbox.
 */
export function filterConditionsMatch(
	filter: Pick<Doc<'mailFilters'>, 'conditions' | 'matchType'>,
	message: EvalMessage
): boolean {
	if (filter.conditions.length === 0) return false;
	return filter.matchType === 'any'
		? filter.conditions.some((c) => conditionMatches(c, message))
		: filter.conditions.every((c) => conditionMatches(c, message));
}

/**
 * Project a stored message row onto the evaluator's input.
 *
 * ASYNC because the inline body columns are SEALED at rest (E8b): matching a
 * `body:` condition against the sealed bytes would silently never fire, so the
 * row goes through `openMailMessageInlineBody` rather than being read directly.
 *
 * The stored row has no raw headers (they live inside the .eml blob), so
 * `header:` conditions see an empty map and simply do not match — which is the
 * honest answer for a retroactive run, not a silent claim that they did.
 */
export async function evalMessageFromRow(
	message: Pick<
		Doc<'mailMessages'>,
		| 'fromAddress'
		| 'toAddresses'
		| 'ccAddresses'
		| 'subject'
		| 'snippet'
		| 'textBodyInline'
		| 'htmlBodyInline'
		| 'rawSize'
		| 'hasAttachments'
	>
): Promise<EvalMessage> {
	const body = await openMailMessageInlineBody(message);
	return {
		from: message.fromAddress,
		to: message.toAddresses,
		cc: message.ccAddresses,
		subject: message.subject,
		// Falls back to the snippet when the body was blobbed out of the row, so
		// `body:` still has something true to match rather than nothing at all.
		bodyText: body.text ?? message.snippet,
		bodyHtml: body.html,
		size: message.rawSize,
		hasAttachment: message.hasAttachments,
	};
}

/**
 * Evaluate a filter list against an inbound message. Pure function — safe
 * to call from inside an internalMutation.
 */
export function evaluateFilters(filters: Doc<'mailFilters'>[], message: EvalMessage): EvalResult {
	const ordered = [...filters].filter((f) => f.isEnabled).sort((a, b) => a.priority - b.priority);

	const matched: Id<'mailFilters'>[] = [];
	const actions: EvalResultAction[] = [];
	let stopped = false;

	for (const filter of ordered) {
		if (!filterConditionsMatch(filter, message)) continue;

		matched.push(filter._id);
		for (const action of filter.actions) {
			actions.push({
				type: action.type,
				folderId: action.folderId,
				labelId: action.labelId,
				forwardTo: action.forwardTo,
			});
		}
		if (filter.stopProcessing) {
			stopped = true;
			break;
		}
	}

	return { matchedFilterIds: matched, actions, stopped };
}
