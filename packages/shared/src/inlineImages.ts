/**
 * Inline-image content-ID rewriting for outbound personal mail.
 *
 * The Postbox Simple composer embeds pasted/dropped images directly in the
 * body: it inserts `<img src="blob:…preview…" data-inline-cid="<id>">` at the
 * caret and uploads the (downscaled) bytes as an INLINE draft attachment keyed
 * by that same `contentId`. The editor keeps the ephemeral blob/preview URL —
 * durable only for the session — so the send path is the single place that
 * rewrites each referenced `<img>` to a `cid:` reference matching the MIME
 * `Content-ID` of its inline part.
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
 * `src`, then inject `src="cid:<contentId>"`. Other attributes are preserved
 * verbatim so the sanitized alt/width/style survive to the wire.
 */
function rewriteTag(tag: string, contentId: string): string {
	let out = tag.replace(DATA_CID_RE, '');
	out = out.replace(SRC_RE, '');
	// Insert the cid src immediately after `<img` (there is always exactly one).
	return out.replace(/<img\b/i, `<img src="cid:${contentId}"`);
}

export function rewriteInlineImageCids(html: string): InlineCidRewriteResult {
	const referenced = new Set<string>();
	const rewritten = html.replace(IMG_TAG_RE, (tag) => {
		const cid = extractCid(tag);
		if (!cid) return tag;
		referenced.add(cid);
		return rewriteTag(tag, cid);
	});
	return { html: rewritten, referencedCids: [...referenced] };
}

/**
 * Whether an inline part with `contentId` is still referenced by the body.
 * A part with no contentId is never an embeddable inline image, so it is
 * treated as unreferenced by this predicate (callers keep real attachments via
 * the `isInline` flag, not this helper).
 */
export function isInlineImageReferenced(
	referencedCids: readonly string[],
	contentId: string | undefined,
): boolean {
	return contentId != null && referencedCids.includes(contentId);
}
