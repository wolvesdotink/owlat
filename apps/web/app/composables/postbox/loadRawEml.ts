import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/**
 * Fetch a message's raw .eml (signed URL) and decode it binary-safely (latin1,
 * one char per byte) so the @owlat/shared/mailMime extractor can pull parts.
 * Shared by the reader (attachment download), the composer (Forward clone), and
 * the invite card (ICS).
 *
 * A small bounded cache dedupes the common same-message refetch (an invite card
 * mounts and parses the .ics, then the user downloads an attachment). Raw .eml
 * blobs are immutable, so the cached content can't go stale.
 */
const CACHE_LIMIT = 3;
const cache = new Map<string, Promise<string | null>>();

async function fetchRawEml(messageId: string): Promise<string | null> {
	const url = await requireConvex().query(api.mail.mailbox.getMessageRawUrl, {
		messageId: messageId as Id<'mailMessages'>,
	});
	if (!url) return null;
	const buf = await (await fetch(url)).arrayBuffer();
	return new TextDecoder('latin1').decode(new Uint8Array(buf));
}

export function loadRawEml(messageId: string): Promise<string | null> {
	const hit = cache.get(messageId);
	if (hit) return hit;

	const pending = fetchRawEml(messageId);
	cache.set(messageId, pending);
	// Drop on failure so a retry can re-fetch; evict oldest past the cap.
	void pending.catch(() => cache.delete(messageId));
	if (cache.size > CACHE_LIMIT) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	return pending;
}
