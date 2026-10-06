/**
 * Attachment limits — the single source of truth shared by client-side compose
 * gating and server-side enforcement (and the MTA/scanner caps), so the limit a
 * user sees in the composer can never diverge from what the backend enforces.
 */

/** Per-message compose limits (transactional API + the attachment panels). */
export const ATTACHMENT_COMPOSE_LIMITS = {
	/** Max number of attachments per message. */
	maxCount: 10,
	/** Max combined size of all attachments on one message, in bytes. */
	maxTotalBytes: 10 * 1024 * 1024,
} as const;

/**
 * Max size of a single attachment file, in bytes — the per-file upload cap, the
 * scanner's default `maxFileSize`, and the MTA submission wire cap all reference
 * this so they move together.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Hard cap on a WHOLE inbound message, in bytes: what the port-25 MX listener
 * advertises via EHLO SIZE and enforces on its DATA loop
 * (`apps/mta/src/bounce/server.ts`), which is the only way mail reaches either
 * inbound route.
 *
 * It lives beside the attachment ceilings because it bounds them: a limit above
 * what the wire can deliver is not a limit.
 */
export const MAX_INBOUND_MESSAGE_BYTES = 10 * 1024 * 1024;

/**
 * Per-attachment ceiling for AI INGESTION — the summary, the embedding and the
 * knowledge extraction that `semanticFiles.ingest` schedules.
 *
 * Deliberately below {@link MAX_ATTACHMENT_BYTES}: a file above this still
 * delivers, still appears in the message's attachment list and is still
 * downloadable out of the raw `.eml`. It is only not fed to a model, and the
 * message row records that it was not, so the reader can say so.
 *
 * The number is chosen to sit UNDER the largest part the wire can deliver: an
 * attachment travels base64 (4 bytes sent per 3 bytes of content) inside a
 * message {@link MAX_INBOUND_MESSAGE_BYTES} bounds, so nothing over about three
 * quarters of that can ever arrive, and a ceiling above it would be decoration
 * rather than a gate (`__tests__/attachmentCeilings.test.ts` pins the
 * relationship). Where it sits inside that range is a cost judgement:
 * extraction plus two completions plus one embedding per knowledge entry is a
 * fan-out with no cap of its own, and a document worth summarising is rarely
 * over a few megabytes, while a multi-megabyte scan is mostly pixels the
 * extractor cannot read anyway.
 */
export const MAX_AI_INGEST_ATTACHMENT_BYTES = 4 * 1024 * 1024;

/**
 * Max size of a single file uploaded into the file library / media library, in
 * bytes — the ceiling shared by the upload modal copy, the client-side upload
 * guard, and the server-side `semanticFiles.create` / `mediaAssets.create`
 * checks, so the advertised limit can never diverge from what is enforced.
 */
export const MAX_LIBRARY_FILE_BYTES = 50 * 1024 * 1024;

/** The library file ceiling expressed in whole MB, for user-facing copy. */
export const MAX_LIBRARY_FILE_MB = MAX_LIBRARY_FILE_BYTES / 1024 / 1024;

/** A Content-ID compared the way a `cid:` reference names it: no angle brackets, any case. */
function normalizeContentId(id: string): string {
	return id.trim().replace(/^<|>$/g, '').toLowerCase();
}

/**
 * The Content-IDs an HTML body shows as images: `cid:` in an `<img src>`. A
 * `cid:` link (`<a href="cid:…">`) points at a file, it does not show one.
 * Scans tag by tag (no backtracking over the body).
 */
export function inlineImageContentIds(html: string): Set<string> {
	const ids = new Set<string>();
	const lower = html.toLowerCase();
	let at = lower.indexOf('<img');
	while (at !== -1) {
		const end = lower.indexOf('>', at);
		if (end === -1) break;
		const src = /\ssrc\s*=\s*["']?\s*cid:([^"'\s>]+)/i.exec(html.slice(at, end));
		if (src?.[1]) {
			let id = src[1];
			try {
				id = decodeURIComponent(id);
			} catch {
				// A malformed escape names the id as written.
			}
			ids.add(normalizeContentId(id));
		}
		at = lower.indexOf('<img', end);
	}
	return ids;
}

/**
 * Whether a received part is a file a forward carries, judged from what a
 * message row records (no Content-Disposition): every part except an image the
 * body shows inline. Errs towards carrying: a part this cannot place is
 * forwarded, never dropped. The composer, which parses the raw message, picks
 * by disposition instead and names its parts.
 */
export function isForwardedPart(
	part: { contentType: string; contentId?: string },
	inlineImages: ReadonlySet<string>
): boolean {
	if (!part.contentId || !part.contentType.toLowerCase().startsWith('image/')) return true;
	return !inlineImages.has(normalizeContentId(part.contentId));
}
