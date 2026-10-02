/**
 * Per-mailbox canned responses ("snippets"): the previous release's API for
 * what are now saved replies (`savedReplies.ts`, rules in `savedReplyRules.ts`).
 * Remove after release N+1: v0.6.7 compatibility. Nothing in this release
 * calls it, but Postbox tabs opened before the deploy still do, by path, with
 * these arguments.
 *
 * It keeps reading and writing rows by `mailboxId`. A row written here has no
 * scope, which the saved-reply rules read through its mailbox (personal on a
 * personal mailbox, shared and limited to it on a team inbox). Changing a row
 * follows those rules too, so an old tab cannot edit a shared reply that the
 * new pages would refuse it.
 */

import { v } from 'convex/values';
import { mailSnippetVariableValidator } from '../lib/validators/mailContent';
import { publicQuery } from '../lib/authedFunctions';
import { hasPermission, requirePermission } from '../lib/sessionOrganization';
import { postboxMutation } from './_helpers';
import { requireMailboxAccess } from './permissions';
import { getOrThrow, throwForbidden, throwInvalidInput } from '../_utils/errors';
import {
	canManageSavedReply,
	loadSavedReplyScope,
	normalizeSavedReplyVariables,
	sanitizeSavedReplyBody,
} from './savedReplyRules';

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

export const create = postboxMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		name: v.string(),
		shortcut: v.string(),
		bodyHtml: v.string(),
		variables: v.optional(v.array(mailSnippetVariableValidator)),
	},
	handler: async (ctx, args, session) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId, 'member', session);
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		// A row on a team inbox is a shared reply, which only admins add.
		if (owned.mailbox.scope === 'shared') {
			requirePermission(
				hasPermission(session.role, 'settings:manage'),
				'Only admins can add shared replies'
			);
		}

		const name = args.name.trim();
		if (!name) throwInvalidInput('Snippet name required');
		const shortcut = args.shortcut.trim();

		const now = Date.now();
		return ctx.db.insert('mailSnippets', {
			mailboxId: args.mailboxId,
			name,
			shortcut,
			bodyHtml: sanitizeSavedReplyBody(args.bodyHtml),
			variables: normalizeSavedReplyVariables(args.variables),
			createdAt: now,
			updatedAt: now,
		});
	},
});

export const update = postboxMutation({
	args: {
		snippetId: v.id('mailSnippets'),
		name: v.optional(v.string()),
		shortcut: v.optional(v.string()),
		bodyHtml: v.optional(v.string()),
		variables: v.optional(v.array(mailSnippetVariableValidator)),
	},
	handler: async (ctx, args, session) => {
		const snippet = await getOrThrow(ctx, args.snippetId, 'Snippet');
		// authz: per row — the saved-reply rules (owner, or settings:manage for a shared reply).
		if (!canManageSavedReply(await loadSavedReplyScope(ctx, snippet), session)) {
			throwForbidden('Not accessible');
		}

		const patch: Record<string, unknown> = { updatedAt: Date.now() };
		if (args.name !== undefined) {
			const name = args.name.trim();
			if (!name) throwInvalidInput('Snippet name required');
			patch['name'] = name;
		}
		if (args.shortcut !== undefined) patch['shortcut'] = args.shortcut.trim();
		if (args.bodyHtml !== undefined) patch['bodyHtml'] = sanitizeSavedReplyBody(args.bodyHtml);
		// An explicit empty array clears the declarations (back to implicit
		// tokens); omitting the field leaves whatever the row already carries.
		if (args.variables !== undefined) {
			patch['variables'] = normalizeSavedReplyVariables(args.variables);
		}
		await ctx.db.patch(args.snippetId, patch);
	},
});

export const remove = postboxMutation({
	args: { snippetId: v.id('mailSnippets') },
	handler: async (ctx, args, session) => {
		const snippet = await ctx.db.get(args.snippetId);
		if (!snippet) return;
		// authz: per row — the saved-reply rules (owner, or settings:manage for a shared reply).
		if (!canManageSavedReply(await loadSavedReplyScope(ctx, snippet), session)) {
			throwForbidden('Not accessible');
		}
		await ctx.db.delete(args.snippetId);
	},
});
