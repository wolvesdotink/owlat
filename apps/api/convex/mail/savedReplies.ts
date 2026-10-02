/**
 * Saved replies: approved answers a person inserts into a reply from the
 * composer's `;` trigger, its picker or the command palette, in the Postbox
 * composer and the Team inbox's alike. Personal ones are their owner's; shared
 * ones are the organization's, edited by admins and optionally limited to some
 * team inboxes. The rules live in `savedReplyRules.ts`.
 *
 * The usage count and last use sort the picker: the replies a person reaches
 * for most come first before they type anything.
 */

import { v } from 'convex/values';
import type { Id } from '../_generated/dataModel';
import { mailSnippetVariableValidator } from '../lib/validators/mailContent';
import { hasPermission, requirePermission } from '../lib/sessionOrganization';
import { getOrThrow, throwForbidden } from '../_utils/errors';
import { savedReplyMutation, savedReplyQuery } from './_helpers';
import { requireMailboxAccess } from './permissions';
import {
	canManageSavedReply,
	canUseSavedReply,
	loadPersonalSavedReplies,
	loadSavedReplyScope,
	loadSharedSavedReplies,
	normalizeSavedReplyName,
	normalizeSavedReplyVariables,
	normalizeShortcut,
	sanitizeSavedReplyBody,
	scopeFields,
	validateRestriction,
	type ScopedSavedReply,
} from './savedReplyRules';

/** What every list returns per reply: the row's content, never its owner ids. */
function toView({ row, scope }: ScopedSavedReply) {
	return {
		_id: row._id,
		name: row.name,
		shortcut: row.shortcut,
		bodyHtml: row.bodyHtml,
		variables: row.variables,
		scope: scope.kind,
		mailboxIds: scope.kind === 'shared' ? scope.mailboxIds : [],
		useCount: row.useCount ?? 0,
		lastUsedAt: row.lastUsedAt ?? null,
		updatedAt: row.updatedAt,
	};
}

function dedupe(replies: ScopedSavedReply[]): ScopedSavedReply[] {
	const seen = new Set<Id<'mailSnippets'>>();
	return replies.filter(({ row }) => {
		if (seen.has(row._id)) return false;
		seen.add(row._id);
		return true;
	});
}

/**
 * Everything the caller may insert in one composer: their personal replies and
 * the organization's shared ones that are not limited to other inboxes.
 * `mailboxId` is the mailbox the Postbox composer writes from; absent for a
 * Team inbox reply. A mailbox the caller cannot write in counts as absent.
 */
export const listForComposer = savedReplyQuery({
	args: { mailboxId: v.optional(v.id('mailboxes')) },
	handler: async (ctx, args, session) => {
		const access = args.mailboxId
			? await requireMailboxAccess(ctx, args.mailboxId, 'member', session)
			: null;
		const mailbox = access?.ok ? access.mailbox : null;
		const replies = dedupe([
			...(await loadPersonalSavedReplies(ctx, session.userId)),
			...(await loadSharedSavedReplies(ctx, session.activeOrganizationId, mailbox)),
		]);
		return replies
			.filter(({ scope }) => canUseSavedReply(scope, session, mailbox?._id ?? null))
			.map(toView);
	},
});

/** The caller's personal replies, for Preferences → Saved replies. */
// authz: self-scope — only rows owned by the caller (or on the caller's own mailboxes).
export const listMine = savedReplyQuery({
	args: {},
	handler: async (ctx, _args, session) =>
		dedupe(await loadPersonalSavedReplies(ctx, session.userId)).map(toView),
});

/**
 * The organization's shared replies, for the admin page. Every member may read
 * them (they insert them anyway); `canManage` says whether this caller may
 * change them.
 */
// all-members: every member inserts shared replies; changing them needs settings:manage.
export const listShared = savedReplyQuery({
	args: {},
	handler: async (ctx, _args, session) => ({
		canManage: hasPermission(session.role, 'settings:manage'),
		replies: dedupe(await loadSharedSavedReplies(ctx, session.activeOrganizationId, 'all')).map(
			toView
		),
	}),
});

const editableFields = {
	name: v.string(),
	shortcut: v.string(),
	bodyHtml: v.string(),
	variables: v.optional(v.array(mailSnippetVariableValidator)),
};

export const create = savedReplyMutation({
	args: {
		scope: v.union(v.literal('personal'), v.literal('shared')),
		...editableFields,
		/** Shared only: the team inboxes it is limited to; empty or absent ⇒ all. */
		mailboxIds: v.optional(v.array(v.id('mailboxes'))),
	},
	handler: async (ctx, args, session) => {
		const now = Date.now();
		const content = {
			name: normalizeSavedReplyName(args.name),
			shortcut: normalizeShortcut(args.shortcut),
			bodyHtml: sanitizeSavedReplyBody(args.bodyHtml),
			variables: normalizeSavedReplyVariables(args.variables),
			createdAt: now,
			updatedAt: now,
		};
		// authz: a personal reply is the caller's own; a shared one needs settings:manage.
		if (args.scope === 'personal') {
			return ctx.db.insert('mailSnippets', {
				...content,
				...scopeFields({ kind: 'personal', ownerUserId: session.userId }),
			});
		}
		requirePermission(
			hasPermission(session.role, 'settings:manage'),
			'Only admins can add shared replies'
		);
		const mailboxIds = await validateRestriction(
			ctx,
			args.mailboxIds ?? [],
			session.activeOrganizationId
		);
		return ctx.db.insert('mailSnippets', {
			...content,
			...scopeFields({ kind: 'shared', organizationId: session.activeOrganizationId, mailboxIds }),
			authorUserId: session.userId,
		});
	},
});

export const update = savedReplyMutation({
	args: {
		replyId: v.id('mailSnippets'),
		name: v.optional(v.string()),
		shortcut: v.optional(v.string()),
		bodyHtml: v.optional(v.string()),
		variables: v.optional(v.array(mailSnippetVariableValidator)),
		/** Shared only; an empty array lifts the limit. Absent leaves it as it is. */
		mailboxIds: v.optional(v.array(v.id('mailboxes'))),
	},
	handler: async (ctx, args, session) => {
		const row = await getOrThrow(ctx, args.replyId, 'Saved reply');
		const scope = await loadSavedReplyScope(ctx, row);
		// authz: per row — the owner of a personal reply, settings:manage for a shared one.
		if (!scope || !canManageSavedReply(scope, session)) throwForbidden('Not accessible');

		const next =
			scope.kind === 'shared' && args.mailboxIds !== undefined
				? {
						...scope,
						mailboxIds: await validateRestriction(ctx, args.mailboxIds, scope.organizationId),
					}
				: scope;
		const patch: Record<string, unknown> = { updatedAt: Date.now(), ...scopeFields(next) };
		if (args.name !== undefined) patch['name'] = normalizeSavedReplyName(args.name);
		if (args.shortcut !== undefined) patch['shortcut'] = normalizeShortcut(args.shortcut);
		if (args.bodyHtml !== undefined) patch['bodyHtml'] = sanitizeSavedReplyBody(args.bodyHtml);
		// An explicit empty array clears the declarations (back to implicit
		// tokens); omitting the field leaves whatever the row already carries.
		if (args.variables !== undefined) {
			patch['variables'] = normalizeSavedReplyVariables(args.variables);
		}
		await ctx.db.patch(args.replyId, patch);
	},
});

export const remove = savedReplyMutation({
	args: { replyId: v.id('mailSnippets') },
	handler: async (ctx, args, session) => {
		const row = await ctx.db.get(args.replyId);
		if (!row) return;
		// authz: per row — the owner of a personal reply, settings:manage for a shared one.
		if (!canManageSavedReply(await loadSavedReplyScope(ctx, row), session)) {
			throwForbidden('Not accessible');
		}
		await ctx.db.delete(args.replyId);
	},
});

/**
 * A reply went into a composer: count it for the picker's order. Any member
 * may count a reply they can see; a reply limited to some team inboxes is
 * counted without knowing which composer it went into, since the count says
 * nothing about where.
 */
export const recordUse = savedReplyMutation({
	args: { replyId: v.id('mailSnippets') },
	handler: async (ctx, args, session) => {
		const row = await ctx.db.get(args.replyId);
		if (!row) return;
		const scope = await loadSavedReplyScope(ctx, row);
		const unrestricted = scope?.kind === 'shared' ? { ...scope, mailboxIds: [] } : scope;
		// authz: per row — the reply has to be one the caller could insert.
		if (!canUseSavedReply(unrestricted, session, null)) throwForbidden('Not accessible');
		await ctx.db.patch(args.replyId, {
			useCount: (row.useCount ?? 0) + 1,
			lastUsedAt: Date.now(),
		});
	},
});
