/**
 * Saved replies: what a row may hold, who sees it in a composer and who may
 * change it. The functions are in `savedReplies.ts`; this module holds the
 * rules they share with the previous release's `snippets.ts`, the erasure and
 * migration 0060.
 *
 * The rows live in `mailSnippets`, the table's name from when they were
 * per-mailbox canned responses in the Postbox. A row is one of:
 *
 *  - personal: its owner's alone, in every composer they write in;
 *  - shared: the organization's, in every member's composers, or only in the
 *    composers of the team inboxes it is restricted to. Admins change them.
 *  - legacy (no `scope`): written before saved replies, scoped to `mailboxId`.
 *    It reads as personal to the owner of a personal mailbox and as shared,
 *    restricted to that inbox, on a team inbox. Migration 0060 writes exactly
 *    that onto each row, so a deployment that has not run it yet behaves the
 *    same.
 *
 * `bodyHtml` is sanitized on save with the composer's own allowlist
 * (POSTBOX_SANITIZE_CONFIG), minus images it has no bytes for: it is inserted
 * straight into a draft. Its
 * `{{token}}` variables and `[[...]]` gaps are plain text and survive that;
 * they are resolved client-side at insert time, and nothing on the send path
 * reads this table.
 */

import sanitizeHtml from 'sanitize-html';
import { POSTBOX_SANITIZE_CONFIG } from '@owlat/shared/postboxSanitize';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { hasPermission, type MutationSessionContext } from '../lib/sessionOrganization';
import { STRING_LIMITS, validateStringLength } from '../lib/inputGuards';
import type { MailSnippetVariableSource } from '../lib/validators/mailContent';
import { throwInvalidInput } from '../_utils/errors';
import { isPersonalMailbox } from './permissions';

/**
 * Hard cap on the post-sanitize body size, in characters. Sanitize-html does
 * not bound the length of allowed CSS or attribute values, so a legit reply
 * could embed a multi-MB asset. 64 KB is comfortable for a rich reply but cuts
 * off pathological cases.
 */
const BODY_MAX_CHARS = 64 * 1024;

/** A shortcut is typed after `;` in a composer, so it stays one short word. */
export const SHORTCUT_MAX_CHARS = 32;

/** Team inboxes one shared reply may be restricted to. */
const RESTRICTION_MAX_MAILBOXES = 50;

/** Rows one list reads per source. Saved replies are a curated, small set. */
export const SAVED_REPLY_LIST_CAP = 200;

/**
 * How many variables one reply may declare. A reply with more blanks than
 * this is a form, and the insert-time prompt would be a wall of fields rather
 * than the one-line question it is meant to be.
 */
const MAX_VARIABLES = 20;

/**
 * The composer's allowlist, minus every image source a saved reply could never
 * show (#1293). A pasted image's bytes are a part of its draft, marked with
 * `data-inline-cid`, which the allowlist drops along with the session's `blob:`
 * preview; a `cid:` src names a part of another message. Kept, an image left
 * with no source would be inserted into later drafts and go out empty. So a
 * `cid:` src is removed, and an `<img>` goes only when neither a src nor a
 * (sanitized) srcset is left to show it from.
 */
const SAVED_REPLY_SANITIZE_CONFIG: sanitizeHtml.IOptions = {
	...POSTBOX_SANITIZE_CONFIG,
	transformTags: {
		img: (tagName, attribs) => {
			if (!/^cid:/i.test(attribs['src']?.trim() ?? '')) return { tagName, attribs };
			const { src: _cid, ...rest } = attribs;
			return { tagName, attribs: rest };
		},
	},
	exclusiveFilter: (frame) =>
		frame.tag === 'img' && !frame.attribs['src']?.trim() && !frame.attribs['srcset']?.trim(),
};

export function sanitizeSavedReplyBody(html: string): string {
	const cleaned = sanitizeHtml(html, SAVED_REPLY_SANITIZE_CONFIG);
	if (cleaned.length > BODY_MAX_CHARS) {
		throwInvalidInput(
			`Reply text exceeds the maximum allowed size (${BODY_MAX_CHARS} characters).`
		);
	}
	return cleaned;
}

/** Trimmed and required; the picker and the lists show it. */
export function normalizeSavedReplyName(raw: string): string {
	const name = raw.trim();
	if (!name) throwInvalidInput('Name required');
	validateStringLength(name, STRING_LIMITS.NAME, 'Name');
	return name;
}

/**
 * What a person typed into the shortcut field, as the `;` trigger matches it:
 * no leading `;` or `/` (people type the trigger along), no spaces (a space
 * ends the trigger), lower case. Empty means "no shortcut".
 */
export function normalizeShortcut(raw: string): string {
	const shortcut = raw
		.trim()
		.replace(/^[;/]+/, '')
		.replace(/\s+/g, '-')
		.toLowerCase();
	validateStringLength(shortcut, SHORTCUT_MAX_CHARS, 'Shortcut');
	return shortcut;
}

type SavedReplyVariable = { token: string; source: MailSnippetVariableSource; label?: string };

/**
 * Trim, drop unusable declarations and collapse duplicates. A token is the name
 * inside `{{…}}`, so it has to match the grammar the composer resolves with
 * (`\w+`); anything else could never be substituted and would sit in the row
 * looking like it does something. Returns undefined for an empty result so the
 * row reads exactly like one without declarations.
 */
export function normalizeSavedReplyVariables(
	variables: SavedReplyVariable[] | undefined
): SavedReplyVariable[] | undefined {
	if (variables === undefined) return undefined;
	const seen = new Set<string>();
	const cleaned: SavedReplyVariable[] = [];
	for (const variable of variables) {
		const token = variable.token.trim();
		if (!/^\w+$/.test(token) || seen.has(token)) continue;
		seen.add(token);
		const label = variable.label?.trim();
		cleaned.push(
			label ? { token, source: variable.source, label } : { token, source: variable.source }
		);
		if (cleaned.length >= MAX_VARIABLES) break;
	}
	return cleaned.length > 0 ? cleaned : undefined;
}

/** Who a row belongs to, with a legacy row read through its mailbox. */
export type SavedReplyScope =
	| { kind: 'personal'; ownerUserId: string }
	/** `mailboxIds` empty ⇒ every composer in the organization. */
	| { kind: 'shared'; organizationId: string; mailboxIds: Id<'mailboxes'>[] };

/**
 * The scope a row has, or null when it has none any more (a legacy row whose
 * mailbox is gone or is a deliverability seed): such a row is nobody's and
 * shows nowhere. `legacyMailbox` is the row's `mailboxId` doc; only read for a
 * row without a scope.
 */
export function savedReplyScope(
	row: Doc<'mailSnippets'>,
	legacyMailbox: Doc<'mailboxes'> | null
): SavedReplyScope | null {
	if (row.scope === 'personal') {
		return row.ownerUserId ? { kind: 'personal', ownerUserId: row.ownerUserId } : null;
	}
	if (row.scope === 'shared') {
		return row.organizationId
			? { kind: 'shared', organizationId: row.organizationId, mailboxIds: row.mailboxIds ?? [] }
			: null;
	}
	if (!legacyMailbox || legacyMailbox._id !== row.mailboxId) return null;
	if (legacyMailbox.status === 'deleted') return null;
	if (isPersonalMailbox(legacyMailbox)) {
		return { kind: 'personal', ownerUserId: legacyMailbox.userId };
	}
	if (legacyMailbox.scope !== 'shared') return null;
	return {
		kind: 'shared',
		organizationId: legacyMailbox.organizationId,
		mailboxIds: [legacyMailbox._id],
	};
}

export async function loadSavedReplyScope(
	ctx: Pick<QueryCtx, 'db'>,
	row: Doc<'mailSnippets'>
): Promise<SavedReplyScope | null> {
	const mailbox = row.scope === undefined && row.mailboxId ? await ctx.db.get(row.mailboxId) : null;
	return savedReplyScope(row, mailbox);
}

/** Personal: its owner. Shared: an admin or owner of its organization. */
export function canManageSavedReply(
	scope: SavedReplyScope | null,
	session: MutationSessionContext
): boolean {
	if (!scope) return false;
	if (scope.kind === 'personal') return scope.ownerUserId === session.userId;
	return (
		scope.organizationId === session.activeOrganizationId &&
		hasPermission(session.role, 'settings:manage')
	);
}

/**
 * May the caller insert this reply in a composer writing from
 * `composerMailboxId`? A Team inbox reply (the AI inbox's threads) has no
 * mailbox, so a reply restricted to team inboxes never shows there. The caller
 * has already checked that `composerMailboxId` is one the caller may write in.
 */
export function canUseSavedReply(
	scope: SavedReplyScope | null,
	session: Pick<MutationSessionContext, 'userId' | 'activeOrganizationId'>,
	composerMailboxId: Id<'mailboxes'> | null
): boolean {
	if (!scope) return false;
	if (scope.kind === 'personal') return scope.ownerUserId === session.userId;
	if (scope.organizationId !== session.activeOrganizationId) return false;
	if (scope.mailboxIds.length === 0) return true;
	return composerMailboxId !== null && scope.mailboxIds.includes(composerMailboxId);
}

/**
 * The team inboxes a shared reply may be restricted to: live shared mailboxes
 * of the caller's organization, deduplicated. Anything else is refused rather
 * than dropped, so an admin never saves a restriction that silently means
 * "everywhere". The one exception is `current`, the restriction the row
 * already has: an inbox in it that has since been deleted is dropped, because
 * the editor cannot show (or untick) a deleted inbox and an edit would
 * otherwise be refused forever.
 */
export async function validateRestriction(
	ctx: Pick<QueryCtx, 'db'>,
	mailboxIds: readonly Id<'mailboxes'>[],
	organizationId: string,
	current: readonly Id<'mailboxes'>[] = []
): Promise<Id<'mailboxes'>[]> {
	const unique = [...new Set(mailboxIds)];
	if (unique.length > RESTRICTION_MAX_MAILBOXES) {
		throwInvalidInput(`A reply can be limited to at most ${RESTRICTION_MAX_MAILBOXES} inboxes`);
	}
	const kept: Id<'mailboxes'>[] = [];
	for (const id of unique) {
		const mailbox = await ctx.db.get(id);
		if ((!mailbox || mailbox.status === 'deleted') && current.includes(id)) continue;
		if (
			!mailbox ||
			mailbox.scope !== 'shared' ||
			mailbox.status === 'deleted' ||
			mailbox.organizationId !== organizationId
		) {
			throwInvalidInput('A reply can only be limited to team inboxes of this organization');
		}
		kept.push(id);
	}
	return kept;
}

/**
 * Refuse a new reply once its owner (personal) or organization (shared) has
 * as many as the lists read: one more would exist but show nowhere, not even
 * on the page that deletes it.
 */
export async function assertSavedReplyRoom(
	ctx: Pick<QueryCtx, 'db'>,
	scope: { kind: 'personal'; ownerUserId: string } | { kind: 'shared'; organizationId: string }
): Promise<void> {
	const rows =
		scope.kind === 'personal'
			? await ctx.db
					.query('mailSnippets')
					.withIndex('by_owner', (q) => q.eq('ownerUserId', scope.ownerUserId))
					.take(SAVED_REPLY_LIST_CAP)
			: await ctx.db
					.query('mailSnippets')
					.withIndex('by_organization_and_scope', (q) =>
						q.eq('organizationId', scope.organizationId).eq('scope', 'shared')
					)
					.take(SAVED_REPLY_LIST_CAP);
	if (rows.length >= SAVED_REPLY_LIST_CAP) {
		throwInvalidInput(`There can be at most ${SAVED_REPLY_LIST_CAP} saved replies here`);
	}
}

/** The scope fields a write stores for `scope` (a legacy row gets them on its first edit). */
export function scopeFields(scope: SavedReplyScope) {
	return scope.kind === 'personal'
		? { scope: 'personal' as const, ownerUserId: scope.ownerUserId }
		: {
				scope: 'shared' as const,
				organizationId: scope.organizationId,
				mailboxIds: scope.mailboxIds.length > 0 ? scope.mailboxIds : undefined,
			};
}

export interface ScopedSavedReply {
	row: Doc<'mailSnippets'>;
	scope: SavedReplyScope;
}

async function legacyRows(
	ctx: Pick<QueryCtx, 'db'>,
	mailbox: Doc<'mailboxes'>
): Promise<ScopedSavedReply[]> {
	const rows = await ctx.db
		.query('mailSnippets')
		.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailbox._id))
		.take(SAVED_REPLY_LIST_CAP);
	const out: ScopedSavedReply[] = [];
	for (const row of rows) {
		if (row.scope !== undefined) continue;
		const scope = savedReplyScope(row, mailbox);
		if (scope) out.push({ row, scope });
	}
	return out;
}

/** The member's personal replies, legacy rows on their own personal mailboxes included. */
export async function loadPersonalSavedReplies(
	ctx: Pick<QueryCtx, 'db'>,
	userId: string
): Promise<ScopedSavedReply[]> {
	const owned = await ctx.db
		.query('mailSnippets')
		.withIndex('by_owner', (q) => q.eq('ownerUserId', userId))
		.take(SAVED_REPLY_LIST_CAP);
	const out: ScopedSavedReply[] = owned.flatMap((row) => {
		const scope = savedReplyScope(row, null);
		return scope ? [{ row, scope }] : [];
	});
	const mailboxes = await ctx.db
		.query('mailboxes')
		.withIndex('by_user', (q) => q.eq('userId', userId))
		.take(SAVED_REPLY_LIST_CAP);
	for (const mailbox of mailboxes) {
		if (!isPersonalMailbox(mailbox) || mailbox.status === 'deleted') continue;
		out.push(...(await legacyRows(ctx, mailbox)));
	}
	return out;
}

/**
 * The organization's shared replies. `legacyFrom` names the team inboxes whose
 * legacy rows to include: the composer's own inbox, or every team inbox of the
 * organization for the admin list.
 */
export async function loadSharedSavedReplies(
	ctx: Pick<QueryCtx, 'db'>,
	organizationId: string,
	legacyFrom: 'all' | Doc<'mailboxes'> | null
): Promise<ScopedSavedReply[]> {
	const shared = await ctx.db
		.query('mailSnippets')
		.withIndex('by_organization_and_scope', (q) =>
			q.eq('organizationId', organizationId).eq('scope', 'shared')
		)
		.take(SAVED_REPLY_LIST_CAP);
	const out: ScopedSavedReply[] = shared.flatMap((row) => {
		const scope = savedReplyScope(row, null);
		return scope ? [{ row, scope }] : [];
	});
	if (legacyFrom === null) return out;
	const teamInboxes =
		legacyFrom === 'all'
			? (
					await ctx.db
						.query('mailboxes')
						.withIndex('by_scope', (q) => q.eq('scope', 'shared'))
						.take(SAVED_REPLY_LIST_CAP)
				).filter((m) => m.organizationId === organizationId && m.status !== 'deleted')
			: legacyFrom.scope === 'shared'
				? [legacyFrom]
				: [];
	for (const mailbox of teamInboxes) out.push(...(await legacyRows(ctx, mailbox)));
	return out;
}
