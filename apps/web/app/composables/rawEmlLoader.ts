/**
 * Fetch a message's raw `.eml` (signed URL) and decode it binary-safely
 * (latin1, one char per byte) so the `@owlat/shared/mailMime` extractor can
 * pull parts out of it.
 *
 * Parametrized over the URL-minting call, because that is the ONLY thing the
 * two readers differ on: Postbox mints through
 * `api.mail.mailbox.messages.getMessageRawUrl` with a `mailMessages` id, the
 * team inbox through `api.inbox.rawMessage.getInboundMessageRawUrl` with an
 * `inboundMessages` id. Everything else — the latin1 decode and the bounded
 * per-message cache — was copied once and would have been copied again.
 */

/** How many messages' raw bodies stay cached at a time. */
const CACHE_LIMIT = 3;

/**
 * Build a loader with its own cache.
 *
 * `mint` returns `null` for a real state, not an error: the retention sweep
 * released the bytes, the message arrived before its route carried them, the
 * message is quarantined malware, or the instance has a key but no proxy origin
 * to serve it through. Callers render that as a failure the reader can see
 * rather than a spinner that stops.
 */
export function createRawEmlLoader(
	mint: (messageId: string) => Promise<string | null>
): (messageId: string) => Promise<string | null> {
	const cache = new Map<string, Promise<string | null>>();

	async function fetchRaw(messageId: string): Promise<string | null> {
		const url = await mint(messageId);
		if (!url) return null;
		const buf = await (await fetch(url)).arrayBuffer();
		return new TextDecoder('latin1').decode(new Uint8Array(buf));
	}

	return function loadRaw(messageId: string): Promise<string | null> {
		const hit = cache.get(messageId);
		if (hit) return hit;

		const pending = fetchRaw(messageId);
		cache.set(messageId, pending);
		// Drop on failure so a retry can re-fetch; evict oldest past the cap.
		void pending.catch(() => cache.delete(messageId));
		if (cache.size > CACHE_LIMIT) {
			const oldest = cache.keys().next().value;
			if (oldest !== undefined) cache.delete(oldest);
		}
		return pending;
	};
}
