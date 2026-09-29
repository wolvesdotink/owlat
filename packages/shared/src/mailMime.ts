/**
 * Attachment extraction for raw RFC822 messages, shaped for the Postbox reader,
 * the inbound attachment scan and the E2EE inbound seal.
 *
 * Every function here is a thin adapter over the `@owlat/mail-message` MIME
 * walker (`parseMimeTree` / `walkLeaves` / `isAttachmentPart` /
 * `transferDecode`), so this module carries no parser of its own. That walker is
 * depth- and part-bounded and never throws, and it is the same one the writers
 * (mail-sync ingest, the MTA inbound route) use to record each attachment's
 * `partIndex`, so a stored index always addresses the same leaf here.
 *
 * Attachment leaves are returned in document order. Input should be a binary
 * string (one char per byte, e.g. `new TextDecoder('latin1').decode(bytes)`) so
 * binary parts survive.
 */

// Directional subpaths only: `/parse/body` pulls in the header, content-type and
// charset helpers and nothing Node-specific, so the web bundle that consumes
// this extractor stays small. `decodeEncodedWords` stays re-exported for
// `apps/imap`.
import { decodeEncodedWords } from '@owlat/mail-message/parse/headers';
import {
	parseMimeTree,
	parseMimeTreeWithBounds,
	walkLeaves,
	isAttachmentPart,
	partFilename,
	partDisposition,
	transferDecode,
	type MimeNode,
} from '@owlat/mail-message/parse/body';

export { decodeEncodedWords };

export interface ExtractedAttachment {
	filename: string;
	contentType: string;
	contentId?: string;
	disposition: 'attachment' | 'inline';
	bytes: Uint8Array<ArrayBuffer>;
}

function stripBrackets(s: string | undefined): string | undefined {
	return s ? s.replace(/[<>]/g, '').trim() || undefined : undefined;
}

function toExtracted(leaf: MimeNode, fallbackName: string): ExtractedAttachment {
	return {
		filename: partFilename(leaf) || fallbackName,
		contentType: leaf.contentType.value,
		contentId: stripBrackets(leaf.headers.last('content-id')),
		disposition: partDisposition(leaf),
		bytes: transferDecode(leaf.rawBody, leaf.headers.last('content-transfer-encoding')),
	};
}

/** The attachment leaves of a raw message and whether the walk was cut short. */
export interface AttachmentExtraction {
	attachments: ExtractedAttachment[];
	/**
	 * The walker's depth or part bound left content out, so `attachments` may
	 * be missing leaves that a mail client would still show. A caller that
	 * vouches for the whole message (the inbound malware scan) must not treat
	 * the list as complete.
	 */
	truncated: boolean;
}

/**
 * {@link extractAttachments}, also reporting whether the walker's bounds cut
 * any content off.
 */
export function extractAttachmentsWithBounds(rawEml: string): AttachmentExtraction {
	const { root, truncated } = parseMimeTreeWithBounds(rawEml);
	const attachments: ExtractedAttachment[] = [];
	walkLeaves(root, (leaf) => {
		if (isAttachmentPart(leaf)) attachments.push(toExtracted(leaf, 'attachment'));
	});
	return { attachments, truncated };
}

/** All attachment leaves of a raw message, in document order. */
export function extractAttachments(rawEml: string): ExtractedAttachment[] {
	return extractAttachmentsWithBounds(rawEml).attachments;
}

/**
 * Find the first MIME leaf whose content-type starts with `typePrefix` (e.g.
 * `text/calendar`), INCLUDING inline parts that carry no disposition/filename —
 * which `extractAttachments` skips. Google/Outlook ship invites as an inline
 * `text/calendar` part, so the RSVP card relies on this rather than a partIndex.
 */
export function extractFirstPartByType(
	rawEml: string,
	typePrefix: string
): ExtractedAttachment | null {
	const prefix = typePrefix.toLowerCase();
	let found = null as MimeNode | null;
	walkLeaves(parseMimeTree(rawEml), (leaf) => {
		if (found) return;
		const type = leaf.contentType.value;
		// A `multipart/*` node with no usable boundary is a childless leaf; it is
		// a container, never a part to hand back.
		if (type.startsWith('multipart/') || !type.startsWith(prefix)) return;
		found = leaf;
	});
	return found ? toExtracted(found, 'part') : null;
}

/**
 * Pick one attachment by the recorded `partIndex` (document order), with a
 * filename fallback for robustness against minor ordering drift.
 */
export function extractAttachmentAt(
	rawEml: string,
	partIndex: string,
	filename?: string
): ExtractedAttachment | null {
	const all = extractAttachments(rawEml);
	const idx = Number.parseInt(partIndex, 10);
	if (Number.isInteger(idx) && idx >= 0 && idx < all.length) {
		const byIdx = all[idx]!;
		if (!filename || byIdx.filename === filename) return byIdx;
	}
	if (filename) {
		const byName = all.find((a) => a.filename === filename);
		if (byName) return byName;
	}
	return Number.isInteger(idx) && idx >= 0 && idx < all.length ? all[idx]! : null;
}
