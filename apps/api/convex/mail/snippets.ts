/**
 * Per-mailbox canned responses ("snippets").
 *
 * A snippet is a named, shortcut-addressable blob of rich text the user can
 * drop into a draft from the composer's "/" slash-trigger. Snippets are
 * mailbox-scoped — they do not leak across mailboxes within an org.
 *
 * `bodyHtml` is sanitized on save with the same allowlist the composer's
 * message HTML uses (POSTBOX_SANITIZE_CONFIG): a snippet is inserted straight
 * into the draft body, so storing known-good HTML keeps the one untrusted-HTML
 * boundary (the sandboxed reader iframe) as the only place raw markup lives.
 * Snippet bodies may carry plain-text {{firstName}}-style placeholder tokens;
 * those are resolved client-side at insert time and are not HTML, so they
 * survive sanitization untouched.
 */

import { v } from 'convex/values';
import sanitizeHtml from 'sanitize-html';
import { POSTBOX_SANITIZE_CONFIG } from '@owlat/shared/postboxSanitize';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import { requireMailboxAccess } from './permissions';
import { throwForbidden, throwInvalidInput, throwNotFound } from '../_utils/errors';

/**
 * Hard cap on the post-sanitize snippet body size, in characters. Sanitize-html
 * does not bound the length of allowed CSS or attribute values, so a legit
 * snippet could embed a multi-MB asset. 64 KB is comfortable for a rich canned
 * response but cuts off pathological cases.
 */
const SNIPPET_MAX_CHARS = 64 * 1024;

function sanitizeSnippet(html: string): string {
	const cleaned = sanitizeHtml(html, POSTBOX_SANITIZE_CONFIG);
	if (cleaned.length > SNIPPET_MAX_CHARS) {
		throwInvalidInput(
			`Snippet HTML exceeds the maximum allowed size (${SNIPPET_MAX_CHARS} characters).`
		);
	}
	return cleaned;
}

// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const list = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) return [];
		// bounded: snippets per mailbox are naturally small; cap defensively
		return ctx.db
			.query('mailSnippets')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.take(200);
	},
});

export const create = authedMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		name: v.string(),
		shortcut: v.string(),
		bodyHtml: v.string(),
	},
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not accessible');

		const name = args.name.trim();
		if (!name) throwInvalidInput('Snippet name required');
		const shortcut = args.shortcut.trim();

		const now = Date.now();
		return ctx.db.insert('mailSnippets', {
			mailboxId: args.mailboxId,
			name,
			shortcut,
			bodyHtml: sanitizeSnippet(args.bodyHtml),
			createdAt: now,
			updatedAt: now,
		});
	},
});

export const update = authedMutation({
	args: {
		snippetId: v.id('mailSnippets'),
		name: v.optional(v.string()),
		shortcut: v.optional(v.string()),
		bodyHtml: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const snippet = await ctx.db.get(args.snippetId);
		if (!snippet) throwNotFound('Snippet');
		const owned = await requireMailboxAccess(ctx, snippet.mailboxId);
		if (!owned.ok) throwForbidden('Not accessible');

		const patch: Record<string, unknown> = { updatedAt: Date.now() };
		if (args.name !== undefined) {
			const name = args.name.trim();
			if (!name) throwInvalidInput('Snippet name required');
			patch['name'] = name;
		}
		if (args.shortcut !== undefined) patch['shortcut'] = args.shortcut.trim();
		if (args.bodyHtml !== undefined) patch['bodyHtml'] = sanitizeSnippet(args.bodyHtml);
		await ctx.db.patch(args.snippetId, patch);
	},
});

export const remove = authedMutation({
	args: { snippetId: v.id('mailSnippets') },
	handler: async (ctx, args) => {
		const snippet = await ctx.db.get(args.snippetId);
		if (!snippet) return;
		const owned = await requireMailboxAccess(ctx, snippet.mailboxId);
		if (!owned.ok) throwForbidden('Not accessible');
		await ctx.db.delete(args.snippetId);
	},
});
