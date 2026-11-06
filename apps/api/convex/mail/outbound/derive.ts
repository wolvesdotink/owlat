/**
 * What a personal-mail send derives from its draft before it builds the
 * message: the threading headers from the message it replies to, and the
 * bodies it renders. Dispatch (`build.ts`) and the approval review of an AI
 * client's send (`mcp/actionReview.ts`) both call these, so the approval card
 * shows what goes out and cannot drift from it.
 *
 * Pure, and free of `'use node'`, so the review can run it in a query.
 */

import { renderDraftBodies, type DraftBodies, type DraftBodySource } from '@owlat/email-renderer';

/** In-Reply-To and References for a reply to `original`; none without one. */
export function threadingHeaders(
	original: { rfc822MessageId: string; references?: string[] } | null
): { inReplyToHeaderValue?: string; referencesHeaderValue?: string } {
	if (!original) return {};
	const references = [...(original.references ?? []), original.rfc822MessageId];
	return {
		inReplyToHeaderValue: `<${original.rfc822MessageId}>`,
		referencesHeaderValue: references.map((id) => `<${id}>`).join(' '),
	};
}

/**
 * The HTML, text and AMP bodies a draft goes out with: its blocks in full
 * mode, its HTML wrapped in a text block otherwise, and its own text/plain
 * override when it has one.
 */
export function renderOutgoingBodies(
	draft: DraftBodySource,
	onBlockParseError?: (err: unknown) => void
): DraftBodies {
	return renderDraftBodies(draft, onBlockParseError ? { onBlockParseError } : {});
}
