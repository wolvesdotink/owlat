/**
 * Inline-image content-ID rewriting for outbound personal mail.
 *
 * The Postbox Simple composer embeds pasted/dropped images directly in the
 * body: it inserts `<img src="blob:…preview…" data-inline-cid="<id>">` at the
 * caret and uploads the (downscaled) bytes as an INLINE draft attachment keyed
 * by that same `contentId`. The display src is the editor's own business (a
 * session preview, or a URL for the part on a reopen) and the draft is
 * saved with none; bodies saved before that still hold a dead `blob:` preview.
 * So the send path is the single place that rewrites each referenced `<img>` to
 * a `cid:` reference matching the MIME `Content-ID` of its inline part, with or
 * without a src to replace.
 *
 * This module is that one tested mapping: it takes the editor HTML and
 *   1. rewrites every `<img data-inline-cid="X">` to `src="cid:X"` (stripping
 *      the marker attribute and any stale blob/preview src), and
 *   2. reports which content-IDs the body still references, so the send path can
 *      PRUNE inline parts whose image the user deleted from the body (an inline
 *      attachment nobody references must not ship).
 *
 * Pure string work — no DOM — so it runs identically in the Convex send action
 * and in unit tests.
 */

export interface InlineCidRewriteResult {
	/** Body HTML with inline `<img>` srcs rewritten to `cid:<contentId>`. */
	html: string;
	/** Content-IDs the rewritten body actually references, de-duplicated. */
	referencedCids: string[];
}

const IMG_TAG_RE = /<img\b[^>]*>/gi;
const DATA_CID_RE = /\s*data-inline-cid\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i;
const SRC_RE = /\s*src\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i;

function extractCid(tag: string): string | undefined {
	const m = tag.match(DATA_CID_RE);
	if (!m) return undefined;
	const raw = m[2] ?? m[3] ?? m[4] ?? '';
	const cid = raw.trim();
	return cid.length > 0 ? cid : undefined;
}

/**
 * Rewrite one `<img>` tag: drop the `data-inline-cid` marker + any existing
 * `src`, then inject `src` (`cid:<contentId>` on the send path; none when it is
 * undefined). Other attributes are preserved verbatim so the sanitized
 * alt/width/style survive to the wire.
 */
function rewriteTag(tag: string, src: string | undefined): string {
	let out = tag.replace(DATA_CID_RE, '');
	out = out.replace(SRC_RE, '');
	if (src === undefined) return out;
	// Insert the src immediately after `<img` (there is always exactly one).
	return out.replace(/<img\b/i, `<img src="${src}"`);
}

/** A URL as a double-quoted attribute value. */
function attributeValue(url: string): string {
	return url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

export function rewriteInlineImageCids(html: string): InlineCidRewriteResult {
	const referenced = new Set<string>();
	const rewritten = html.replace(IMG_TAG_RE, (tag) => {
		const cid = extractCid(tag);
		if (!cid) return tag;
		referenced.add(cid);
		return rewriteTag(tag, `cid:${cid}`);
	});
	return { html: rewritten, referencedCids: [...referenced] };
}

/**
 * The same images pointed at a URL the browser can load, for showing a body
 * before it is sent ("Preview as sent", #1301): each `<img data-inline-cid="X">`
 * gets `src` = `resolve(X)`, without the marker. An image whose URL is not known
 * yet gets no src at all, as in the editor. Ordinary images are left alone.
 */
export function resolveInlineImageSrcs(
	html: string,
	resolve: (contentId: string) => string | undefined
): string {
	return html.replace(IMG_TAG_RE, (tag) => {
		const cid = extractCid(tag);
		if (!cid) return tag;
		const url = resolve(cid);
		return rewriteTag(tag, url ? attributeValue(url) : undefined);
	});
}

/**
 * The body without its inline images. Their bytes are parts of one draft, so
 * a copy of the body kept anywhere else (a saved reply, #1293) cannot carry them.
 */
export function stripInlineImages(html: string): { html: string; removed: number } {
	let removed = 0;
	const stripped = html.replace(IMG_TAG_RE, (tag) => {
		if (!extractCid(tag)) return tag;
		removed += 1;
		return '';
	});
	return { html: stripped, removed };
}

/**
 * Whether an inline part with `contentId` is still referenced by the body.
 * A part with no contentId is never an embeddable inline image, so it is
 * treated as unreferenced by this predicate (callers keep real attachments via
 * the `isInline` flag, not this helper).
 */
export function isInlineImageReferenced(
	referencedCids: readonly string[],
	contentId: string | undefined
): boolean {
	return contentId != null && referencedCids.includes(contentId);
}
