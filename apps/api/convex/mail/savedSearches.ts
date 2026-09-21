/**
 * Saved searches — named, re-runnable Postbox queries.
 *
 * Stores the raw query string rather than a parsed payload, so a saved search
 * re-parses on every run and inherits parser fixes and new operators instead of
 * freezing the grammar of the day it was saved. That string is also the `?q=`
 * the search page reads, which makes a saved search and a bookmarked URL the
 * same artifact.
 *
 * Mailbox-scoped like labels (`labels.ts`) and snippets (`snippets.ts`): a
 * query naming this mailbox's folders and labels means nothing in another one.
 * Every function re-checks mailbox access; nothing here trusts an id argument.
 */

import { v } from 'convex/values';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import { requireMailboxAccess } from './permissions';
import {
	getOrThrow,
	throwAlreadyExists,
	throwForbidden,
	throwInvalidInput,
} from '../_utils/errors';

/**
 * Hard caps. A saved search is a shortcut, not a document: a name has to fit a
 * rail row and a query the user could have typed. Bounding both keeps the
 * unbounded-string surface out of a table the rail reads on every render.
 */
const NAME_MAX_CHARS = 80;
const QUERY_MAX_CHARS = 512;
/** Per-mailbox ceiling — the rail and the manage list both render the lot. */
const MAX_SAVED_SEARCHES = 100;

function normalizeName(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) throwInvalidInput('Saved search name required');
	if (trimmed.length > NAME_MAX_CHARS) {
		throwInvalidInput(`Saved search name exceeds ${NAME_MAX_CHARS} characters`);
	}
	return trimmed;
}

function normalizeQuery(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) throwInvalidInput('Saved search query required');
	if (trimmed.length > QUERY_MAX_CHARS) {
		throwInvalidInput(`Saved search query exceeds ${QUERY_MAX_CHARS} characters`);
	}
	return trimmed;
}

// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const list = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) return [];
		const rows = await ctx.db
			.query('mailSavedSearches')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.take(MAX_SAVED_SEARCHES);
		// Sorted here rather than by index: `order` is a manual rail position and
		// the rail plus the manage list are the only readers, both of which want
		// the same order. Creation time breaks ties so a duplicated `order` (two
		// devices saving at once) still renders deterministically.
		return rows.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
	},
});

export const create = authedMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		name: v.string(),
		rawQuery: v.string(),
		isPinned: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not accessible');

		const name = normalizeName(args.name);
		const rawQuery = normalizeQuery(args.rawQuery);

		const existing = await ctx.db
			.query('mailSavedSearches')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.take(MAX_SAVED_SEARCHES);
		if (existing.length >= MAX_SAVED_SEARCHES) {
			throwInvalidInput(`A mailbox can hold at most ${MAX_SAVED_SEARCHES} saved searches`);
		}
		if (existing.some((row) => row.name.toLowerCase() === name.toLowerCase())) {
			throwAlreadyExists(`Saved search "${name}" already exists`);
		}

		const now = Date.now();
		return ctx.db.insert('mailSavedSearches', {
			mailboxId: args.mailboxId,
			name,
			rawQuery,
			isPinned: args.isPinned ?? false,
			// Append: one past the current maximum, so a new entry never displaces
			// the rail order the user already arranged.
			order: existing.reduce((max, row) => Math.max(max, row.order), -1) + 1,
			createdAt: now,
			updatedAt: now,
		});
	},
});

export const update = authedMutation({
	args: {
		savedSearchId: v.id('mailSavedSearches'),
		name: v.optional(v.string()),
		rawQuery: v.optional(v.string()),
		isPinned: v.optional(v.boolean()),
		order: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const saved = await getOrThrow(ctx, args.savedSearchId, 'Saved search');
		const owned = await requireMailboxAccess(ctx, saved.mailboxId);
		if (!owned.ok) throwForbidden('Saved search not accessible');

		const patch: Record<string, unknown> = {};
		if (args.name !== undefined) {
			const name = normalizeName(args.name);
			const siblings = await ctx.db
				.query('mailSavedSearches')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', saved.mailboxId))
				.take(MAX_SAVED_SEARCHES);
			if (
				siblings.some(
					(row) => row._id !== saved._id && row.name.toLowerCase() === name.toLowerCase()
				)
			) {
				throwAlreadyExists(`Saved search "${name}" already exists`);
			}
			patch['name'] = name;
		}
		if (args.rawQuery !== undefined) patch['rawQuery'] = normalizeQuery(args.rawQuery);
		if (args.isPinned !== undefined) patch['isPinned'] = args.isPinned;
		if (args.order !== undefined) {
			if (!Number.isFinite(args.order)) throwInvalidInput('Order must be a finite number');
			patch['order'] = args.order;
		}
		if (Object.keys(patch).length === 0) return;
		patch['updatedAt'] = Date.now();
		await ctx.db.patch(args.savedSearchId, patch);
	},
});

export const remove = authedMutation({
	args: { savedSearchId: v.id('mailSavedSearches') },
	handler: async (ctx, args) => {
		const saved = await ctx.db.get(args.savedSearchId);
		if (!saved) return;
		const owned = await requireMailboxAccess(ctx, saved.mailboxId);
		if (!owned.ok) throwForbidden('Saved search not accessible');
		await ctx.db.delete(args.savedSearchId);
	},
});
