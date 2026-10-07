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
 * Attachment leaves are returned in document order. Input must be a binary
 * string (one char per byte, from {@link bytesToBinaryString}) so binary parts
 * survive; `TextDecoder('latin1')` is windows-1252 and changes 0x80-0x9F.
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
	bodyLeafKind,
	isAttachmentPart,
	partFilename,
	partDisposition,
	transferDecode,
	type MimeNode,
} from '@owlat/mail-message/parse/body';
import { decodeDeclaredCharset } from '@owlat/mail-message/parse/charset';
import { decodeLocated, decodedLength, locateMimeTree } from '@owlat/mail-message/parse/locate';
import { bytesToBinaryString, binaryStringToBytes } from '@owlat/mail-message/parse/binaryString';

export { decodeEncodedWords, bytesToBinaryString, binaryStringToBytes };

export interface ExtractedAttachment {
	filename: string;
	contentType: string;
	contentId?: string;
	disposition: 'attachment' | 'inline';
	/**
	 * The `charset` its `Content-Type` declares, if any. `bytes` are not
	 * charset-decoded, so a text part is read with this.
	 */
	charset?: string;
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
		charset: leaf.contentType.params['charset'],
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
 * A text part's content under the charset it declares. A part that declares
 * none is read as UTF-8 rather than under the RFC 2045 us-ascii default: that is
 * what an iCalendar part means without one (RFC 5545 §3.1.4). A leading
 * byte-order mark never overrides the declared charset (`decodeDeclaredCharset`):
 * an ISO-8859-1 part that happens to start with `EF BB BF` stays ISO-8859-1.
 */
export function decodePartText(part: Pick<ExtractedAttachment, 'bytes' | 'charset'>): string {
	return decodeDeclaredCharset(part.bytes, part.charset ?? 'utf-8');
}

/**
 * The leaves a message's displayed `text/plain` body is assembled from, in
 * document order, transfer-decoded but not charset-decoded: the parser's own
 * body rule (`bodyLeafKind`), so attachments never count.
 */
export function extractBodyTextParts(rawEml: string): ExtractedAttachment[] {
	const parts: ExtractedAttachment[] = [];
	walkLeaves(parseMimeTree(rawEml), (leaf) => {
		if (bodyLeafKind(leaf) === 'text') parts.push(toExtracted(leaf, 'body'));
	});
	return parts;
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

/** One part a forward carries, located but not decoded. */
export interface LocatedForwardedPart {
	/** Document-order index among the message's attachment leaves. */
	partIndex: string;
	filename: string;
	contentType: string;
	contentId?: string;
	/** Decoded size in bytes, counted without decoding. */
	size: number;
	/** Decode it now, into an array of exactly `size` bytes. */
	decode: () => Uint8Array<ArrayBuffer>;
}

/**
 * The parts a forward of this raw message carries, over its BYTES: the rule
 * forwarding has always used, Content-Disposition `attachment` (a leaf with a
 * filename and no disposition counts as one), each keeping its document-order
 * index among the message's attachment leaves, which is its identity on the
 * draft that owes it. Nothing is decoded until `decode` is called, one part at
 * a time, and the message is never turned into a string
 * (`@owlat/mail-message/parse/locate`). `truncated`: the walker's part or depth
 * bound cut the message short, so parts past it were never seen.
 */
export function locateForwardedParts(raw: Uint8Array): {
	parts: LocatedForwardedPart[];
	truncated: boolean;
} {
	const { root, bodies, truncated } = locateMimeTree(raw);
	const parts: LocatedForwardedPart[] = [];
	let index = 0;
	walkLeaves(root, (leaf) => {
		if (!isAttachmentPart(leaf)) return;
		const partIndex = String(index++);
		if (partDisposition(leaf) !== 'attachment') return;
		const body = bodies.get(leaf);
		if (!body) return;
		const encoding = leaf.headers.last('content-transfer-encoding');
		const size = decodedLength(raw, body, encoding);
		parts.push({
			partIndex,
			filename: partFilename(leaf) || 'attachment',
			contentType: leaf.contentType.value,
			contentId: stripBrackets(leaf.headers.last('content-id')),
			size,
			decode: () => decodeLocated(raw, body, encoding, size),
		});
	});
	return { parts, truncated };
}
