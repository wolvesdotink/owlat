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
 * The minted URLs are kept until shortly before their token expires. The proxy
 * lets the browser cache a part privately for the token's lifetime, and only
 * the SAME URL can hit that cache, so reopening a file in the lightbox or
 * downloading it after previewing it is served locally.
 */

/** Stop reusing a URL this long before its token expires. */
const EXPIRY_MARGIN_MS = 60_000;
/** How many minted part URLs are remembered. */
const URL_CACHE_LIMIT = 50;

type MintPartUrl = (messageId: string, att: AttachmentMeta) => Promise<string | null>;

/** The `exp` a sealed-blob URL carries, or null for any other URL. */
function tokenExpiry(url: string): number | null {
	try {
		const exp = Number(new URL(url).searchParams.get('exp'));
		return Number.isFinite(exp) && exp > 0 ? exp : null;
	} catch {
		return null;
	}
}

export function createMessagePartLoader(mint: MintPartUrl, now: () => number = Date.now) {
	const urls = new Map<string, { url: string; expiresAt: number }>();

	async function urlFor(key: string, messageId: string, att: AttachmentMeta) {
		const hit = urls.get(key);
		if (hit && hit.expiresAt - EXPIRY_MARGIN_MS > now()) return hit.url;
		urls.delete(key);
		const url = await mint(messageId, att);
		const expiresAt = url ? tokenExpiry(url) : null;
		if (url && expiresAt !== null) {
			urls.set(key, { url, expiresAt });
			if (urls.size > URL_CACHE_LIMIT) {
				const oldest = urls.keys().next().value;
				if (oldest !== undefined) urls.delete(oldest);
			}
		}
		return url;
	}

	return async function loadMessagePart(
		messageId: string,
		att: AttachmentMeta
	): Promise<Blob | null> {
		const key = `${messageId}:${att.partIndex ?? '0'}:${att.filename}`;
		const url = await urlFor(key, messageId, att);
		if (!url) return null;
		const res = await fetch(url);
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
