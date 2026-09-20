import type { AttachmentMeta } from '~/utils/attachmentMeta';

/**
 * Parse `inboundMessages.attachmentMeta`.
 *
 * UNTRUSTED INPUT. Unlike the structured `mailMessages.attachments`, this
 * column is an unvalidated JSON STRING written straight from data that came off
 * the wire, so every field is checked before it is believed and anything that
 * fails simply is not an attachment. A malformed blob renders as no
 * attachments rather than breaking the thread view.
 *
 * Its own module rather than a function inside `<script setup>` so it can be
 * tested directly: this is the boundary where a sender-controlled string
 * becomes props, and "renders nothing weird" is a claim worth pinning.
 *
 * Note what is NOT sanitised here: `filename` is passed through verbatim
 * (including `../` and control-ish characters). It is only ever rendered as
 * TEXT and used as an `<a download>` hint, where the browser flattens paths —
 * stripping it would silently rename people's files.
 */
export function parseInboundAttachmentMeta(raw?: string): AttachmentMeta[] {
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.flatMap((entry): AttachmentMeta[] => {
		if (typeof entry !== 'object' || entry === null) return [];
		const att = entry as Record<string, unknown>;
		// `contentType` is the one field with no sane default — a row without it
		// cannot describe what it holds, so it is not an attachment.
		if (typeof att['contentType'] !== 'string') return [];
		return [
			{
				filename: typeof att['filename'] === 'string' ? att['filename'] : 'attachment',
				contentType: att['contentType'],
				size: typeof att['size'] === 'number' ? att['size'] : 0,
				...(typeof att['partIndex'] === 'string' ? { partIndex: att['partIndex'] } : {}),
			},
		];
	});
}
