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
 * TWO STORED SHAPES, told apart by `inboundMessages.attachmentMetaVersion`,
 * which the caller passes in:
 *   · 0 (the column absent) — `{filename, contentType, size}`, written before
 *     the raw `.eml` was stored. There were no bytes for a `partIndex` to
 *     address, so one is not read even if something put it there: a version-0
 *     row renders without a download, which is the honest state for it;
 *   · 1 — the same fields plus `partIndex`, the address of one part inside the
 *     sealed blob.
 *
 * The VERSION decides, not the presence of a field. Guessing the shape from
 * whether `partIndex` happens to be there is what a stored version exists to
 * replace (CONVENTIONS.md, "Schema evolution"), and it makes the next
 * non-additive change a branch here rather than a new guess.
 *
 * Note what is NOT sanitised here: `filename` is passed through verbatim
 * (including `../` and control-ish characters). It is only ever rendered as
 * TEXT and used as an `<a download>` hint, where the browser flattens paths —
 * stripping it would silently rename people's files.
 */
export function parseInboundAttachmentMeta(raw?: string, version?: number): AttachmentMeta[] {
	if (!raw) return [];
	// Absent is version 0 — the rows written before the column existed.
	const addressable = (version ?? 0) >= 1;
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
				...(addressable && typeof att['partIndex'] === 'string'
					? { partIndex: att['partIndex'] }
					: {}),
			},
		];
	});
}
