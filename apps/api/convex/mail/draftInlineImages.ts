/**
 * Display URLs for the images pasted into a draft's body (#1285).
 *
 * The Simple composer stores a pasted image as an inline part on the draft row
 * and marks its place in the body with `<img data-inline-cid="X">`. The saved
 * body carries no usable `src`: the preview URL the editor showed while pasting
 * only lives as long as that browser session (older bodies still hold that dead
 * `blob:` URL). A reopened draft asks here for each inline part's URL, and the
 * editor fills its images in from the answer. The send path never reads any of
 * this: it rewrites every marked image to `cid:X` (`outbound/build.ts`).
 *
 * The URLs are the same expiring `/sealed-blob` capability the Postbox reader
 * gets for a message part (`lib/sealedBlob.ts`), minted only after the same
 * gate as `drafts.get`. They stop working when their token expires (one hour),
 * so the composer asks again before then; a caller who has lost access to the
 * mailbox gets nothing new. The proxy serves a plaintext draft upload as it is.
 */

import { v } from 'convex/values';
import type { Id } from '../_generated/dataModel';
import { internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';
import { publicAction } from '../lib/authedFunctions';
import { sealedBlobUrl } from '../lib/sealedBlob';
import { requireMailboxAccess } from './permissions';

export interface DraftInlineImageUrl {
	contentId: string;
	url: string;
	/**
	 * How long the URL stays valid, measured on the server's clock at minting.
	 * The client schedules renewal from this rather than from the `exp` in the
	 * URL, so a client clock that is off cannot push renewal past the expiry.
	 * Absent for a URL that does not expire.
	 */
	expiresInMs?: number;
}

/** The `exp` a `/sealed-blob` URL carries, or null for a URL that has none. */
function expiryOf(url: string): number | null {
	try {
		const exp = Number(new URL(url).searchParams.get('exp'));
		return Number.isFinite(exp) && exp > 0 ? exp : null;
	} catch {
		return null;
	}
}

interface ReadableInlineImage {
	contentId: string;
	storageId: Id<'_storage'>;
	contentType: string;
}

/** The inline image parts of a draft the caller may open, or none. */
// public: soft-auth — returns [] for anonymous; mailbox access is still enforced in-handler
export const readableInlineImages = internalQuery({
	args: { draftId: v.id('mailDrafts') },
	handler: async (ctx, args): Promise<ReadableInlineImage[]> => {
		const draft = await ctx.db.get(args.draftId);
		if (!draft) return [];
		const owned = await requireMailboxAccess(ctx, draft.mailboxId);
		if (!owned.ok) return [];
		const parts: ReadableInlineImage[] = [];
		for (const att of draft.attachments) {
			// Only the parts the body can show: inline images with a Content-ID.
			if (!att.isInline || !att.contentId) continue;
			if (!att.contentType.toLowerCase().startsWith('image/')) continue;
			parts.push({
				contentId: att.contentId,
				storageId: att.storageId,
				contentType: att.contentType,
			});
		}
		return parts;
	},
});

/**
 * An expiring URL per inline image on the draft. The bytes of a part never
 * change, so the URL is minted cacheable, like a message part's.
 */
// public: soft-auth — internal source query returns [] for anonymous and enforces mailbox access
// authz: gate lives in internal.mail.draftInlineImages.readableInlineImages (requireMailboxAccess).
export const urls = publicAction({
	args: { draftId: v.id('mailDrafts') },
	handler: async (ctx, args): Promise<DraftInlineImageUrl[]> => {
		const parts: ReadableInlineImage[] = await ctx.runQuery(
			internal.mail.draftInlineImages.readableInlineImages,
			args
		);
		const urls: DraftInlineImageUrl[] = [];
		for (const part of parts) {
			const mintedAt = Date.now();
			const url = await sealedBlobUrl(ctx.storage, part.storageId, part.contentType, {
				cacheable: true,
			});
			if (!url) continue;
			const exp = expiryOf(url);
			urls.push(
				exp === null
					? { contentId: part.contentId, url }
					: { contentId: part.contentId, url, expiresInMs: Math.max(0, exp - mintedAt) }
			);
		}
		return urls;
	},
});
