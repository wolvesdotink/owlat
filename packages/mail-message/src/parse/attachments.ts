/**
 * Attachment extraction from a parsed MIME tree.
 *
 * Attachment leaves are returned in DOCUMENT ORDER — the same order the current
 * `@owlat/shared/mailMime.extractAttachments` assigns (and therefore the same
 * `partIndex` recorded on stored message metadata), because both walk the tree
 * with the shared {@link walkLeaves} traversal and the shared
 * {@link isAttachmentPart} predicate. Filenames are decoded, bodies are
 * transfer-decoded into Buffers, and the whole thing tolerates broken input
 * without throwing.
 */

import {
	parseMimeTree,
	walkLeaves,
	isAttachmentPart,
	partFilename,
	partDisposition,
	transferDecode,
	type MimeNode,
} from './body';

/** A decoded attachment leaf. */
export interface MessageAttachment {
	/** Decoded filename; falls back to `attachment` when the part names none. */
	filename: string;
	/** Lowercased `type/subtype` (e.g. `image/png`). */
	contentType: string;
	/** `Content-ID` with surrounding angle brackets stripped, or `undefined`. */
	contentId: string | undefined;
	/** `inline` or `attachment` per the part's Content-Disposition. */
	disposition: 'attachment' | 'inline';
	/** Transfer-decoded bytes. */
	content: Buffer;
	/** Byte length of {@link content}. */
	size: number;
}

/** `Content-ID` value with a single pair of surrounding angle brackets removed. */
function stripBrackets(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.replace(/[<>]/g, '').trim();
	return trimmed === '' ? undefined : trimmed;
}

/** Build a {@link MessageAttachment} from an attachment leaf node. */
function toAttachment(node: MimeNode): MessageAttachment {
	const bytes = transferDecode(node.rawBody, node.headers.get('content-transfer-encoding'));
	const content = Buffer.from(bytes);
	return {
		filename: partFilename(node) || 'attachment',
		contentType: node.contentType.value,
		contentId: stripBrackets(node.headers.get('content-id')),
		disposition: partDisposition(node),
		content,
		size: content.length,
	};
}

/** Extract every attachment leaf of a parsed MIME tree, in document order. */
export function extractAttachmentsFromTree(root: MimeNode): MessageAttachment[] {
	const out: MessageAttachment[] = [];
	walkLeaves(root, (leaf) => {
		if (isAttachmentPart(leaf)) out.push(toAttachment(leaf));
	});
	return out;
}

/**
 * Extract every attachment of a raw message (binary string), in document order.
 * The i-th element corresponds to `partIndex === String(i)` on the read side.
 */
export function extractAttachments(raw: string): MessageAttachment[] {
	return extractAttachmentsFromTree(parseMimeTree(raw));
}
