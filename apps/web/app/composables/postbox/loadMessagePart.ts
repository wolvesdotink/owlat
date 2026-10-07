import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { AttachmentMeta } from '~/utils/attachmentMeta';

/**
 * Fetch ONE attachment of a Postbox message, without the rest of it.
 *
 * Delivery stores each attachment leaf as its own blob (plan 3.5), so a 200 KB
 * PDF no longer costs the whole 20 MB message. `null` means "not stored on its
 * own" — mail from before that, a message whose parts are still being cut, a
 * part URL that would not load — and the caller extracts it from the raw
 * `.eml` exactly as before.
 *
 * The minted URLs are kept for a while. The proxy lets the browser cache a part
 * privately for the token's lifetime, and only the SAME URL can hit that cache,
 * so reopening a file in the lightbox or downloading it after previewing it is
 * served locally. How long a URL is kept is counted on this device from when it
 * arrived, never by comparing the token's `exp` (server time) with the device
 * clock (#1294): a clock running behind kept expired URLs, one running ahead
 * kept none. A kept URL the proxy refuses anyway is minted once more before the
 * caller falls back to the whole message.
 */

/**
 * Reuse a URL for at most this long after it arrived. The proxy's tokens live
 * an hour from when the server minted it (`lib/sealedBlob.ts`); the ten minutes
 * left over are far more than the answer takes to arrive.
 */
const URL_REUSE_MS = 50 * 60_000;
/** How many minted part URLs are remembered. */
const URL_CACHE_LIMIT = 50;

type MintPartUrl = (messageId: string, att: AttachmentMeta) => Promise<string | null>;

export function createMessagePartLoader(mint: MintPartUrl, now: () => number = Date.now) {
	const urls = new Map<string, { url: string; reuseUntil: number }>();

	async function urlFor(key: string, messageId: string, att: AttachmentMeta) {
		const hit = urls.get(key);
		if (hit && now() < hit.reuseUntil) return { url: hit.url, reused: true };
		urls.delete(key);
		const url = await mint(messageId, att);
		if (url) {
			urls.set(key, { url, reuseUntil: now() + URL_REUSE_MS });
			if (urls.size > URL_CACHE_LIMIT) {
				const oldest = urls.keys().next().value;
				if (oldest !== undefined) urls.delete(oldest);
			}
		}
		return { url, reused: false };
	}

	return async function loadMessagePart(
		messageId: string,
		att: AttachmentMeta
	): Promise<Blob | null> {
		const key = `${messageId}:${att.partIndex ?? '0'}:${att.filename}`;
		let { url, reused } = await urlFor(key, messageId, att);
		if (!url) return null;
		let res = await fetch(url);
		if (!res.ok && reused) {
			// Refused before its time (a clock that jumped, a shorter token): one
			// fresh URL costs far less than the raw `.eml` the caller falls back to.
			urls.delete(key);
			({ url } = await urlFor(key, messageId, att));
			if (!url) return null;
			res = await fetch(url);
		}
		if (!res.ok) {
			urls.delete(key);
			return null;
		}
		const blob = await res.blob();
		// A leaf with no usable type is served as octet-stream; the row's own
		// type is what the raw-.eml path would have labelled it with.
		if ((!blob.type || blob.type === 'application/octet-stream') && att.contentType) {
			return new Blob([blob], { type: att.contentType });
		}
		return blob;
	};
}

export const loadMessagePart = createMessagePartLoader((messageId, att) =>
	requireConvex().action(api.mail.mailbox.parts.getMessagePartUrl, {
		messageId: messageId as Id<'mailMessages'>,
		// The same default the raw-.eml extraction uses for a row without one.
		partIndex: att.partIndex ?? '0',
		filename: att.filename,
	})
);
