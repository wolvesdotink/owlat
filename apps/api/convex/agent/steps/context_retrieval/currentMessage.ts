/**
 * Current-message assembly for the `context_retrieval` step.
 *
 * Split out of `index.ts` (domain sibling) so the step file stays under the
 * file-size gate. Holds the two pieces that turn the raw inbound body into the
 * `[CURRENT MESSAGE]` briefing section:
 *   - `inboundBodyForContext` — the hidden-content-stripped, remote-image-
 *     neutralized body the model is allowed to read, and
 *   - `buildCurrentMessageSection` — the quarantined STRUCTURED extraction
 *     wiring that renders the sender's body as facts + questions rather than raw
 *     prose (fail-soft to the stripped raw body).
 */

import { internal } from '../../../_generated/api';
import type { ActionCtx } from '../../../_generated/server';
import { stripRemoteImages } from '@owlat/shared/postboxTrackers';
import { stripHiddenContent } from '../security_scan/patterns';

/**
 * The message body the LLM steps should read, with remote images / tracking
 * pixels neutralized. The agent reads EVERY inbound automatically, so an
 * HTML-only message (no text/plain part) whose body reached the model verbatim
 * would carry live remote-image URLs — merely assembling them into context is a
 * privacy hazard and a remote-resource-resolution vector. Prefer the plain-text
 * part (no images to strip); otherwise strip remote images from the HTML before
 * it becomes context. Fails soft (see `stripRemoteImages`): a strip error leaves
 * the HTML as-is, matching prior behaviour, and never blocks retrieval.
 */
export function inboundBodyForContext(message: {
	textBody?: string | null;
	htmlBody?: string | null;
}): string | undefined {
	// Strip hidden content (HTML comments / display:none / zero-width smuggling)
	// before the body becomes model context, so a hidden instruction never
	// reaches the draft even when the message scored below the quarantine
	// threshold. `stripHiddenContent` is a no-op on already-clean text (the
	// plain-text part passes through verbatim).
	if (message.textBody != null) return stripHiddenContent(message.textBody);
	if (message.htmlBody != null)
		return stripHiddenContent(stripRemoteImages(message.htmlBody).html);
	return undefined;
}

/**
 * Build the `[CURRENT MESSAGE]` briefing section — the sender's body rendered as
 * a QUARANTINED STRUCTURED extraction (facts + the sender's actual questions)
 * rather than raw prose, so the draft/clarify steps never consume the sender's
 * free text verbatim in an instruction-adjacent slot. A no-tool quarantined LLM
 * pass produces the structured form; FAIL-SOFT: extraction unavailable (empty
 * body, model error, or a throwing/absent seam in tests) falls back to the
 * hidden-stripped raw body — exactly today's behaviour. Wrapped in try/catch so
 * a guard hiccup never blocks retrieval.
 */
export async function buildCurrentMessageSection(
	ctx: ActionCtx,
	message: { from: string; to: string; subject?: string; receivedAt: number },
	inboundBody: string | undefined,
): Promise<string> {
	let currentMessageBody = inboundBody ?? '(no body)';
	if (inboundBody != null && inboundBody.trim().length > 0) {
		try {
			const structured = await ctx.runAction(
				internal.agent.steps.context_retrieval.quarantine.extract,
				{ text: inboundBody },
			);
			if (typeof structured === 'string' && structured.trim().length > 0) {
				currentMessageBody = structured;
			}
		} catch {
			// Fail soft — keep the hidden-stripped raw body.
		}
	}
	return (
		'[CURRENT MESSAGE]\n' +
		`From: ${message.from}\n` +
		`To: ${message.to}\n` +
		`Subject: ${message.subject}\n` +
		`Date: ${new Date(message.receivedAt).toISOString()}\n` +
		`Body:\n${currentMessageBody}`
	);
}
