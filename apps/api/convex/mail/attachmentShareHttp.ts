/**
 * Attachment share links (plan idea 10) — the SERVING half.
 * `GET /attachment-share/{token}` streams the shared file's bytes.
 *
 * Modelled on `mail/sealedBlobHttp.ts`, with one deliberate difference. The
 * sealed-blob proxy serves a capability minted for a caller the query site had
 * ALREADY authorized, so it only re-checks a signature. This route has no such
 * upstream: the person clicking it is a stranger reading a mail somewhere else,
 * and the token in the path is the whole of the access control. Everything that
 * makes a link legitimate therefore has to be decided HERE, on every request:
 *
 *   - the token is well-formed (a cheap structural filter before any read),
 *   - a row exists for it,
 *   - it has not been revoked and has not expired,
 *   - it is scoped to `anyone` (a link narrowed to `mailbox` is dead out here),
 *   - the bytes still exist.
 *
 * That decision lives in `attachmentShares.consumeShareToken`, which also
 * counts the hit — an owner has to be able to tell a link nobody opened from
 * one that was forwarded around, and a serving path that forgets to count makes
 * the management list quietly untrue.
 *
 * EVERY REFUSAL IS THE SAME 404. Revoked, expired, narrowed, never-existed and
 * malformed are indistinguishable from outside, so the route cannot be used to
 * enumerate which tokens are real or to learn that a file was once there.
 *
 * The response is forced to a DOWNLOAD (`Content-Disposition: attachment` and
 * `X-Content-Type-Options: nosniff`) rather than rendered inline. The bytes are
 * user-supplied and served from the deployment's own origin; an HTML or SVG
 * "attachment" rendered in that origin would be stored XSS against every share
 * recipient. Nothing about the file is trusted enough to display.
 */

import { httpAction } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { ATTACHMENT_SHARE_PATH, isAttachmentShareToken } from '@owlat/shared/attachmentShares';
import { getClientIp, rateLimitedResponse } from '../publicRateLimit';
import { logError } from '../lib/runtimeLog';

/**
 * Filename for the `Content-Disposition` header. Quotes, backslashes and
 * anything that could terminate the header (CR/LF) are stripped rather than
 * escaped: the stored name came from a client-supplied upload, and a header
 * split here would let an uploader inject response headers into a download that
 * other people fetch.
 */
function dispositionFilename(filename: string): string {
	const cleaned = filename.replace(/[\r\n"\\]/g, '').trim();
	return cleaned.length > 0 ? cleaned.slice(0, 200) : 'attachment';
}

/** Uniform refusal. One shape for every reason, so none of them is a signal. */
function notFound(): Response {
	return new Response('Not found', {
		status: 404,
		headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
	});
}

export const serveAttachmentShare = httpAction(async (ctx, request) => {
	const path = new URL(request.url).pathname;
	const raw = path.startsWith(ATTACHMENT_SHARE_PATH)
		? path.slice(ATTACHMENT_SHARE_PATH.length)
		: '';
	let token: string;
	try {
		token = decodeURIComponent(raw);
	} catch {
		return notFound(); // a malformed percent-escape is not a token
	}
	if (!isAttachmentShareToken(token)) return notFound();

	// The token space is 192 bits, so this is not what stops guessing — it stops
	// a live token from being turned into a bandwidth tap, and it bounds the
	// damage of a leaked link before its owner notices and revokes.
	const limit = await ctx.runMutation(internal.publicRateLimit.checkPublicRateLimit, {
		limitType: 'subscriptionManagement',
		key: `${getClientIp(request)}:${token}`,
	});
	if (!limit.ok) return rateLimitedResponse(limit.retryAfter);

	// Resolves AND counts, or refuses. Every gate is inside.
	const share = await ctx.runMutation(internal.mail.attachmentShares.consumeShareToken, {
		token,
	});
	if (!share) return notFound();

	try {
		const blob = await ctx.storage.get(share.storageId as Id<'_storage'>);
		if (!blob) return notFound();
		return new Response(blob, {
			status: 200,
			headers: {
				'Content-Type': share.contentType || 'application/octet-stream',
				'Content-Disposition': `attachment; filename="${dispositionFilename(share.filename)}"`,
				'X-Content-Type-Options': 'nosniff',
				// A shared link's bytes are private to whoever holds the URL and the
				// link can be revoked at any moment; nothing in between may keep a
				// copy that outlives the revoke.
				'Cache-Control': 'no-store, private',
			},
		});
	} catch (err) {
		logError(`[attachmentShare] failed to serve ${share.storageId}: ${String(err)}`);
		return new Response('Internal Server Error', {
			status: 500,
			headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
		});
	}
});
