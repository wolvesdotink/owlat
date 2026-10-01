/**
 * Inline (`cid:`) images in a received message body — the pure half.
 *
 * An HTML mail can carry its logo as a MIME part and point at it with
 * `<img src="cid:logo@sender">`. Nothing in a browser can fetch a `cid:` URL,
 * and the body iframe's CSP only admits `https:` and `data:` images, so those
 * images rendered as broken icons, trusted sender or not. The reader loads the
 * referenced parts (see `usePostboxCidImages`) and this module swaps each
 * reference for the part's `data:` URL.
 *
 * Inline parts never phone home — they arrived with the message — so they are
 * shown whether or not remote images are allowed, like every other client does.
 */

/** The attachment fields an inline image is matched and loaded by. */
export interface CidAttachment {
	filename: string;
	contentType: string;
	size: number;
	partIndex?: string;
	contentId?: string;
}

/** Inline parts larger than this stay unresolved; a `data:` URL is held in memory. */
export const MAX_CID_IMAGE_BYTES = 5 * 1024 * 1024;

/** `src="cid:…"` on an `<img>`; the sanitized body always quotes attributes. */
const CID_SRC_RE = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])cid:([^"']*)\2/gi;

/**
 * A Content-ID as both sides compare it: no angle brackets, lowercased, and
 * URL-decoded (RFC 2392 percent-encodes the `cid:` URL form).
 */
export function normalizeContentId(id: string): string {
	let value = id.trim().replace(/^<|>$/g, '');
	try {
		value = decodeURIComponent(value);
	} catch {
		// A stray `%` is not an encoding; compare the id as written.
	}
	return value.toLowerCase();
}

/** Every Content-ID an `<img>` in the body points at. */
export function cidReferences(html: string | null | undefined): Set<string> {
	const ids = new Set<string>();
	if (!html) return ids;
	for (const match of html.matchAll(CID_SRC_RE)) {
		const id = match[3];
		if (id) ids.add(normalizeContentId(id));
	}
	return ids;
}

/** The image parts the body references, each once, small enough to inline. */
export function inlineImageParts<T extends CidAttachment>(
	attachments: readonly T[] | null | undefined,
	html: string | null | undefined
): T[] {
	const wanted = cidReferences(html);
	if (wanted.size === 0 || !attachments) return [];
	const parts: T[] = [];
	const seen = new Set<string>();
	for (const att of attachments) {
		if (!att.contentId) continue;
		const id = normalizeContentId(att.contentId);
		if (!wanted.has(id) || seen.has(id)) continue;
		if (!att.contentType.toLowerCase().startsWith('image/')) continue;
		if (att.size > MAX_CID_IMAGE_BYTES) continue;
		seen.add(id);
		parts.push(att);
	}
	return parts;
}

/**
 * Point every resolved `cid:` reference at its `data:` URL. References with no
 * entry are left as they are (they stay broken, as before).
 */
export function resolveCidImages(html: string, urls: ReadonlyMap<string, string>): string {
	if (urls.size === 0) return html;
	return html.replace(CID_SRC_RE, (match, prefix: string, quote: string, id: string) => {
		const url = urls.get(normalizeContentId(id));
		return url ? `${prefix}${quote}${url}${quote}` : match;
	});
}
