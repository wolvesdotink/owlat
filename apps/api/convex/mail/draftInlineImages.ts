/**
 * Display URLs for the images pasted into a draft's body (#1285).
 *
 * The Simple composer stores a pasted image as an inline part on the draft row
 * and marks its place in the body with `<img data-inline-cid="X">`. The saved
 * body carries no usable `src`: the preview URL the editor showed while pasting
 * only lives as long as that browser session (older bodies still hold that dead
 * `blob:` URL). A reopened draft asks here for each inline part's storage URL,
 * and the editor fills its images in from the answer. The send path never reads
 * any of this: it rewrites every marked image to `cid:X` (`outbound/build.ts`).
 *
 * Same gate as `drafts.get`: a caller who cannot open the draft gets nothing.
 */

import { v } from 'convex/values';
import type { Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { publicQuery } from '../lib/authedFunctions';
import { requireMailboxAccess } from './permissions';

export interface DraftInlineImageUrl {
	contentId: string;
	url: string;
}

export async function draftInlineImageUrlsHandler(
	ctx: QueryCtx,
	args: { draftId: Id<'mailDrafts'> }
): Promise<DraftInlineImageUrl[]> {
	const draft = await ctx.db.get(args.draftId);
	if (!draft) return [];
	const owned = await requireMailboxAccess(ctx, draft.mailboxId);
	if (!owned.ok) return [];
	const urls: DraftInlineImageUrl[] = [];
	for (const att of draft.attachments) {
		// Only the parts the body can show: inline images with a Content-ID.
		if (!att.isInline || !att.contentId) continue;
		if (!att.contentType.toLowerCase().startsWith('image/')) continue;
		const url = await ctx.storage.getUrl(att.storageId);
		if (url) urls.push({ contentId: att.contentId, url });
	}
	return urls;
}

// public: soft-auth — returns [] for anonymous; mailbox access is still enforced in-handler
// authz: gate lives in draftInlineImageUrlsHandler (requireMailboxAccess).
export const urls = publicQuery({
	args: { draftId: v.id('mailDrafts') },
	handler: draftInlineImageUrlsHandler,
});
