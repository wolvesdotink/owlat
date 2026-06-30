/**
 * Sieve-style inbound mail filters.
 *
 * Architecture:
 *   - Filters are stored as structured JSON (conditions + actions). NO `eval`,
 *     no shell-out — the evaluator below is a pure-JS dispatcher over a fixed
 *     allowlist of operators.
 *   - Conditions inside one filter are AND-ed. To OR, define multiple filters.
 *   - Filters run in `priority` ascending order. A matching filter whose
 *     `stopProcessing=true` halts further evaluation.
 *   - Actions accumulate (e.g. `markRead` + `addLabel` is one filter, two
 *     actions). The delivery pipeline applies the final state in one place.
 */

import { v } from 'convex/values';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import type { Doc, Id } from '../_generated/dataModel';
import { loadOwnedMailbox } from './permissions';
import { throwForbidden, throwInvalidInput, throwNotFound } from '../_utils/errors';

// ── Public CRUD ───────────────────────────────────────────────────

// public: soft-auth — returns empty for anonymous; mailbox ownership is still enforced in-handler
export const list = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const owned = await loadOwnedMailbox(ctx, args.mailboxId);
		if (!owned.ok) return [];
		return ctx.db
			.query('mailFilters')
			.withIndex('by_mailbox_and_priority', (q) => q.eq('mailboxId', args.mailboxId))
			.collect();
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
		stopProcessing: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		const owned = await loadOwnedMailbox(ctx, args.mailboxId);
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
				.withIndex('by_mailbox_and_priority', (q) =>
					q.eq('mailboxId', args.mailboxId)
				)
				.collect();
			priority = existing.length === 0 ? 100 : Math.max(...existing.map((f) => f.priority)) + 100;
		}
		return ctx.db.insert('mailFilters', {
			mailboxId: args.mailboxId,
			name: trimmed,
			isEnabled: args.isEnabled ?? true,
			priority,
			conditions: args.conditions,
			actions: args.actions,
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
		stopProcessing: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		const filter = await ctx.db.get(args.filterId);
		if (!filter) throwNotFound('Filter');
		const owned = await loadOwnedMailbox(ctx, filter.mailboxId);
		if (!owned.ok) throwForbidden('Filter not accessible');

		const patch: Record<string, unknown> = { updatedAt: Date.now() };
		if (args.name !== undefined) patch['name'] = args.name.trim();
		if (args.isEnabled !== undefined) patch['isEnabled'] = args.isEnabled;
		if (args.priority !== undefined) patch['priority'] = args.priority;
		if (args.conditions !== undefined) patch['conditions'] = args.conditions;
		if (args.actions !== undefined) patch['actions'] = args.actions;
		if (args.stopProcessing !== undefined) patch['stopProcessing'] = args.stopProcessing;
		await ctx.db.patch(args.filterId, patch);
	},
});

export const remove = authedMutation({
	args: { filterId: v.id('mailFilters') },
	handler: async (ctx, args) => {
		const filter = await ctx.db.get(args.filterId);
		if (!filter) return;
		const owned = await loadOwnedMailbox(ctx, filter.mailboxId);
		if (!owned.ok) throwForbidden('Filter not accessible');
		await ctx.db.delete(args.filterId);
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
	type:
		| 'moveToFolder'
		| 'addLabel'
		| 'markRead'
		| 'markFlagged'
		| 'forward'
		| 'delete'
		| 'discard';
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
 * Evaluate a filter list against an inbound message. Pure function — safe
 * to call from inside an internalMutation.
 */
export function evaluateFilters(
	filters: Doc<'mailFilters'>[],
	message: EvalMessage
): EvalResult {
	const ordered = [...filters]
		.filter((f) => f.isEnabled)
		.sort((a, b) => a.priority - b.priority);

	const matched: Id<'mailFilters'>[] = [];
	const actions: EvalResultAction[] = [];
	let stopped = false;

	for (const filter of ordered) {
		if (filter.conditions.length === 0) continue;
		const allMatch = filter.conditions.every((c) => conditionMatches(c, message));
		if (!allMatch) continue;

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
