/**
 * The envelope of a reply to an inbound message: who it goes to, the RFC 5322
 * threading headers that land it under the customer's message, and the HTML
 * the plain-text body ships as.
 *
 * Shared by the two paths that answer an inbound message: the approved reply
 * (`agent/agentPipeline.sendApprovedReply`) and a person's follow-up on a
 * thread that was already answered (`inbox/followUps.ts`). Pure, so both the
 * action and the mutation runtime can import it.
 */

import { escapeHtmlWithBreaks } from '@owlat/shared/html';
import { parseAddress } from '@owlat/shared';

/**
 * Escape a plain-text reply body into a minimal HTML fragment. The body is
 * final, non-templated text (the agent's signature is already folded in by the
 * `draft` step), so we escape it and convert newlines to `<br>` rather than
 * running it through the block renderer.
 */
export function replyBodyToHtml(text: string): string {
	// escapeHtmlWithBreaks escapes all five HTML metacharacters (the old inline
	// version omitted the apostrophe) and converts newlines to <br>.
	return `<div>${escapeHtmlWithBreaks(text.replace(/\r\n/g, '\n'))}</div>`;
}

/**
 * Build the RFC 5322 threading headers for a reply. `In-Reply-To` points at
 * the inbound message's own `Message-ID`; `References` appends it to the
 * original chain so clients thread the reply under the customer's message.
 * Message-IDs are wrapped in angle brackets if the provider stored them bare.
 */
export function buildThreadingHeaders(inbound: {
	messageId?: string;
	references?: string;
}): Record<string, string> {
	const headers: Record<string, string> = {};
	if (!inbound.messageId) return headers;
	const wrapped = inbound.messageId.startsWith('<') ? inbound.messageId : `<${inbound.messageId}>`;
	headers['In-Reply-To'] = wrapped;
	const prior = (inbound.references ?? '').trim();
	headers['References'] = prior ? `${prior} ${wrapped}` : wrapped;
	return headers;
}

/**
 * Extract the reply recipient address from an inbound `from` field. Handles
 * the "Name <email>" form and a bare address; returns undefined when nothing
 * address-shaped is present. Routed through the shared `parseAddress` so the
 * reply target agrees with inbound sender resolution / thread matching.
 */
export function extractRecipient(fromField: string): string | undefined {
	return parseAddress(fromField)?.address;
}
