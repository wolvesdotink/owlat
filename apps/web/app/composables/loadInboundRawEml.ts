import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/**
 * Fetch a team-inbox message's raw .eml (signed URL) and decode it
 * binary-safely (latin1, one char per byte) so the @owlat/shared/mailMime
 * extractor can pull attachment parts out of it.
 *
 * A sibling of `postbox/loadRawEml`, not a caller of it: that one hardcodes
 * `api.mail.mailbox.messages.getMessageRawUrl` and casts to `Id<'mailMessages'>`,
 * so calling it with an inbound id typechecks and then returns null at runtime.
 *
 * A small bounded cache dedupes the same-message refetch (one message with two
 * attachments the reader downloads in turn). Raw .eml blobs are immutable, so
 * the cached content cannot go stale.
 */
const CACHE_LIMIT = 3;
const cache = new Map<string, Promise<string | null>>();

async function fetchInboundRawEml(messageId: string): Promise<string | null> {
	const url = await requireConvex().action(api.inbox.rawMessage.getInboundMessageRawUrl, {
		messageId: messageId as Id<'inboundMessages'>,
	});
	// Null is a real state, not an error: the retention sweep released the bytes,
	// the message arrived before the route carried them, or the instance has a
	// key but no proxy origin to serve it through. The caller renders it as a
	// failure the reader can see rather than a spinner that stops.
	if (!url) return null;
	const buf = await (await fetch(url)).arrayBuffer();
	return new TextDecoder('latin1').decode(new Uint8Array(buf));
}

export function loadInboundRawEml(messageId: string): Promise<string | null> {
	const hit = cache.get(messageId);
	if (hit) return hit;

	const pending = fetchInboundRawEml(messageId);
	cache.set(messageId, pending);
	// Drop on failure so a retry can re-fetch; evict oldest past the cap.
	void pending.catch(() => cache.delete(messageId));
	if (cache.size > CACHE_LIMIT) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	return pending;
}
