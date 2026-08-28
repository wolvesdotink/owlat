/**
 * Attachment share links (plan idea 10) — the DATABASE half.
 *
 * The composer's attachment meter has always nudged people "toward a link for
 * oversized files" and there was no link to reach for. This is it: a file the
 * message cannot carry is taken out of the draft, kept in the storage blob it
 * was already uploaded to, and replaced in the body by a URL that lapses.
 *
 * WHAT LIVES WHERE. Creation is an ACTION (`attachmentSharesActions.ts`),
 * because a file only becomes shareable after the same ClamAV gate the outbound
 * send path runs, and that gate is a `fetch`. Serving is an HTTP action
 * (`attachmentShareHttp.ts`). Expiry is a cron (`attachmentShareRetention.ts`).
 * This module owns the rows: the owner's management list, immediate revoke,
 * scope narrowing, and the two internal mutations the action drives.
 *
 * REVOKE MEANS THE BYTES ARE GONE. A revoke that only flipped a flag would be a
 * promise resting on this code never regressing. It deletes the blob and clears
 * `storageId`, so after it runs there is nothing left to serve even if every
 * check above the storage read were removed. The ROW survives the grace window
 * so the list can still tell the owner what happened to a link a recipient is
 * asking about; the retention sweep deletes the record afterwards.
 *
 * SCOPE NARROWING IS A PARTIAL REVOKE. Moving a link from `anyone` to `mailbox`
 * kills the public URL while keeping the file reachable from inside the app —
 * the "I shared that with the wrong person" move that should not also destroy
 * the only copy of the file.
 */

import { v } from 'convex/values';
import {
	attachmentShareExpiryAt,
	attachmentShareState,
	isAttachmentShareToken,
	resolveAttachmentShareExpiryDays,
	type AttachmentShareState,
} from '@owlat/shared/attachmentShares';
import { internalMutation, internalQuery } from '../_generated/server';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import {
	mailAttachmentShareScanValidator,
	mailAttachmentShareScopeValidator,
} from '../lib/convexValidators';
import { throwForbidden, throwInvalidInput } from '../_utils/errors';
import { logError } from '../lib/runtimeLog';
import { requireMailboxAccess } from './permissions';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';

/**
 * Defensive cap on the management list. Share links are created one deliberate
 * click at a time, so this sits far above any real usage; it exists so the
 * settings query can never become an unbounded read.
 */
export const ATTACHMENT_SHARE_LIST_LIMIT = 200;

/** The row projection every surface reads, plus its state at `now`. */
function projectShare(row: Doc<'mailAttachmentShares'>, now: number) {
	return {
		_id: row._id,
		filename: row.filename,
		contentType: row.contentType,
		size: row.size,
		token: row.token,
		scope: row.scope,
		expiresAt: row.expiresAt,
		revokedAt: row.revokedAt,
		scanVerdict: row.scanVerdict,
		downloadCount: row.downloadCount,
		lastAccessedAt: row.lastAccessedAt,
		createdAt: row.createdAt,
		hasBytes: row.storageId !== undefined,
		state: attachmentShareState(row, now) satisfies AttachmentShareState,
	};
}

/**
 * Release a share's bytes. Convex storage deletes are permanent and the row is
 * the only thing that still knows the id, so this is the single place both
 * revoke and the expiry sweep (`attachmentShareRetention.ts`) go through — and
 * it clears `storageId` in the same patch, because a row pointing at a deleted
 * blob is a lie the serving route would have to re-derive.
 *
 * Tolerant of a blob that is already gone (a retried sweep, a storage delete
 * that raced): the goal is "these bytes are not reachable", and a throw there
 * would leave the row pointing at nothing forever.
 */
export async function releaseShareBytes(
	ctx: MutationCtx,
	row: Doc<'mailAttachmentShares'>,
	patch: { revokedAt?: number }
): Promise<void> {
	if (row.storageId) {
		try {
			await ctx.storage.delete(row.storageId);
		} catch (err) {
			logError(`[attachmentShares] failed to delete blob for ${row._id}: ${String(err)}`);
		}
	}
	await ctx.db.patch(row._id, { ...patch, storageId: undefined, updatedAt: Date.now() });
}

/**
 * Load a share the CALLER is allowed to administer. Two gates, both required:
 * access to the mailbox the file came from, and authorship of the link itself.
 * The second matters in a shared team inbox — every member can read the
 * mailbox, but "revoke this link" is the creator's decision about something
 * they handed to a person outside the company, and the member list is not a
 * list of people who should be able to break it.
 */
async function requireOwnShare(
	ctx: MutationCtx,
	shareId: Id<'mailAttachmentShares'>
): Promise<Doc<'mailAttachmentShares'>> {
	const row = await ctx.db.get(shareId);
	if (!row) throwInvalidInput('Share link not found');
	const owned = await requireMailboxAccess(ctx, row.mailboxId);
	if (!owned.ok || owned.userId !== row.userId) throwForbidden('Share link not accessible');
	return row;
}

/**
 * This person's share links for one mailbox, newest first.
 *
 * Deliberately NOT filtered to live links: a link that expired last week is
 * exactly what someone comes here to check when a recipient says the download
 * is broken, and hiding it turns a two-second answer into a mystery.
 */
// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const list = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) return [];
		const rows = await ctx.db
			.query('mailAttachmentShares')
			.withIndex('by_mailbox_user', (q) =>
				q.eq('mailboxId', args.mailboxId).eq('userId', owned.userId)
			)
			.take(ATTACHMENT_SHARE_LIST_LIMIT);
		const now = Date.now();
		return rows.map((row) => projectShare(row, now)).sort((a, b) => b.createdAt - a.createdAt);
	},
});

/**
 * Kill a link now. Idempotent — a second click on an already-revoked row is a
 * no-op rather than an error, because the button stays on screen while the
 * query round-trips and a double-click must not surface a failure.
 */
// authz: requireOwnShare — mailbox access AND authorship of this link.
export const revoke = authedMutation({
	args: { shareId: v.id('mailAttachmentShares') },
	handler: async (ctx, args) => {
		const row = await requireOwnShare(ctx, args.shareId);
		if (row.revokedAt !== undefined) return { ok: true as const, revoked: false };
		await releaseShareBytes(ctx, row, { revokedAt: Date.now() });
		return { ok: true as const, revoked: true };
	},
});

/**
 * Narrow (or re-widen) who may fetch a link.
 *
 * Narrowing to `mailbox` is the partial revoke — the public URL stops
 * resolving, the file survives. Re-widening is allowed only while the bytes are
 * still there: once revoke or the sweep has reclaimed them, `anyone` would be a
 * link that resolves to nothing, which is a worse answer than refusing.
 */
// authz: requireOwnShare — mailbox access AND authorship of this link.
export const setScope = authedMutation({
	args: {
		shareId: v.id('mailAttachmentShares'),
		scope: mailAttachmentShareScopeValidator,
	},
	handler: async (ctx, args) => {
		const row = await requireOwnShare(ctx, args.shareId);
		if (args.scope === 'anyone' && row.storageId === undefined) {
			throwInvalidInput('This share link no longer has a file behind it');
		}
		if (row.scope !== args.scope) {
			await ctx.db.patch(row._id, { scope: args.scope, updatedAt: Date.now() });
		}
		return { ok: true as const, scope: args.scope };
	},
});

// ─── Internal: the create path the action drives ─────────────────────────────

/**
 * Authorize + describe one draft attachment before it is scanned.
 *
 * Split out of the insert so the ACTION can refuse an inaccessible draft
 * without first pulling the bytes and paying for a ClamAV round trip; the
 * insert re-checks everything anyway, because the two run in separate
 * transactions and the draft can change in between.
 */
export const prepareShare = internalQuery({
	args: { draftId: v.id('mailDrafts'), storageId: v.id('_storage') },
	handler: async (ctx, args) => {
		const draft = await ctx.db.get(args.draftId);
		if (!draft) return null;
		const owned = await requireMailboxAccess(ctx, draft.mailboxId);
		if (!owned.ok) return null;
		const attachment = draft.attachments.find((a) => a.storageId === args.storageId);
		// Inline parts are body images with a Content-ID the rendered HTML points
		// at; pulling one out into a link would leave a broken image behind.
		if (!attachment || attachment.isInline) return null;
		const settings = await ctx.db
			.query('mailUserSettings')
			.withIndex('by_user', (q) => q.eq('userId', owned.userId))
			.first();
		return {
			mailboxId: draft.mailboxId,
			userId: owned.userId,
			filename: attachment.filename,
			contentType: attachment.contentType,
			size: attachment.size,
			expiryDays: resolveAttachmentShareExpiryDays(settings?.shareLinkExpiryDays),
		};
	},
});

/**
 * Detach the attachment from the draft and record the share, in one
 * transaction.
 *
 * The two halves cannot be separated. Detaching without inserting orphans the
 * blob (the draft no longer knows the id, so `discard` will never clean it up);
 * inserting without detaching ships the file BOTH as a wire attachment and as a
 * link, which is the bounce this feature exists to prevent. The attachment is
 * removed WITHOUT the storage delete `drafts.removeAttachment` performs — the
 * share row is taking ownership of exactly those bytes.
 */
export const createShare = internalMutation({
	args: {
		draftId: v.id('mailDrafts'),
		storageId: v.id('_storage'),
		token: v.string(),
		expiryDays: v.number(),
		scanVerdict: mailAttachmentShareScanValidator,
	},
	handler: async (ctx, args) => {
		if (!isAttachmentShareToken(args.token)) throwInvalidInput('Malformed share token');
		const draft = await ctx.db.get(args.draftId);
		if (!draft) throwInvalidInput('Draft not found');
		const owned = await requireMailboxAccess(ctx, draft.mailboxId);
		if (!owned.ok) throwForbidden('Draft not accessible');
		const attachment = draft.attachments.find((a) => a.storageId === args.storageId);
		if (!attachment || attachment.isInline) throwInvalidInput('Attachment not found');

		const now = Date.now();
		const expiresAt = attachmentShareExpiryAt(now, args.expiryDays);
		await ctx.db.patch(args.draftId, {
			attachments: draft.attachments.filter((a) => a.storageId !== args.storageId),
			lastEditedAt: now,
		});
		const shareId = await ctx.db.insert('mailAttachmentShares', {
			mailboxId: draft.mailboxId,
			userId: owned.userId,
			storageId: args.storageId,
			filename: attachment.filename,
			contentType: attachment.contentType,
			size: attachment.size,
			token: args.token,
			scope: 'anyone',
			sourceDraftId: args.draftId,
			expiresAt,
			scanVerdict: args.scanVerdict,
			downloadCount: 0,
			createdAt: now,
			updatedAt: now,
		});
		return {
			shareId,
			token: args.token,
			expiresAt,
			filename: attachment.filename,
			size: attachment.size,
		};
	},
});

// ─── Internal: the serving path ──────────────────────────────────────────────

/**
 * Resolve a token for the public route and, when it may be served, record the
 * hit. A MUTATION rather than a query because the download counter is what lets
 * an owner tell a link nobody used from one that leaked, and a serving path
 * that forgets to count is a management list that quietly lies.
 *
 * Every refusal collapses to the same `null`: an expired link, a revoked link,
 * a mailbox-scoped link and a token that never existed are indistinguishable
 * from outside, so the route cannot be used to probe which tokens are real.
 */
export const consumeShareToken = internalMutation({
	args: { token: v.string() },
	handler: async (ctx, args) => {
		if (!isAttachmentShareToken(args.token)) return null;
		const row = await ctx.db
			.query('mailAttachmentShares')
			.withIndex('by_token', (q) => q.eq('token', args.token))
			.first();
		if (!row || !row.storageId) return null;
		if (row.scope !== 'anyone') return null;
		const now = Date.now();
		if (attachmentShareState(row, now) !== 'live') return null;
		await ctx.db.patch(row._id, {
			downloadCount: row.downloadCount + 1,
			lastAccessedAt: now,
			updatedAt: now,
		});
		return {
			storageId: row.storageId,
			filename: row.filename,
			contentType: row.contentType,
		};
	},
});
