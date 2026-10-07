/**
 * Current-message assembly for the `context_retrieval` step.
 *
 * Split out of `index.ts` (domain sibling) so the step file stays under the
 * file-size gate. Holds the two pieces that turn the raw inbound body into the
 * `[CURRENT MESSAGE]` briefing section:
 *   - `inboundBodyForContext` — the hidden-content-stripped, remote-image-
 *     neutralized body the model is allowed to read, and
 *   - `buildCurrentMessageSection` — renders the sender's body as the thread's
 *     structured actions from interpretation (`mail/interpret/`) rather than
 *     raw prose (fail-soft to the stripped raw body).
 */

import { internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import type { ActionCtx } from '../../../_generated/server';
import { stripRemoteImages } from '@owlat/shared/postboxTrackers';
import {
	openInboundMessageBody,
	type InboundMessageBodyFields,
} from '../../../lib/messageBodyInbound';
import type { BlobGet } from '../../../lib/sealedBlob';
import { stripHiddenContent } from '../security_scan/patterns';
import { renderBriefingActions } from '../../../mail/interpret/teamActions';

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
export async function inboundBodyForContext(
	message: InboundMessageBodyFields,
	storage: BlobGet | null
): Promise<string | undefined> {
	// Strip hidden content (HTML comments / display:none / zero-width smuggling)
	// before the body becomes model context, so a hidden instruction never
	// reaches the draft even when the message scored below the quarantine
	// threshold. The plain-text part keeps any markup it quotes, since a reader
	// sees it as written; only the HTML part has its hidden elements removed.
	const { text, html } = await openInboundMessageBody(message, storage);
	if (text != null) return stripHiddenContent(text);
	if (html != null) return stripHiddenContent(stripRemoteImages(html).html, { html: true });
	return undefined;
}

/**
 * Build the `[CURRENT MESSAGE]` briefing section: the sender's body rendered as
 * the thread's STRUCTURED actions (SPEC §5 "Team pipeline") rather than raw
 * prose, so the draft and clarify steps never consume the sender's free text
 * verbatim in an instruction-adjacent slot.
 *
 * The actions come from interpretation in `actions` mode
 * (`mail/interpret/run.ts`), which grounds every item in a verbatim quote and
 * screens it for injection. A stored extraction of this message is reused, so
 * a repeated assembly (a retry, Answer mode) costs no model call; only a
 * message with no current extraction runs it.
 *
 * FAIL-SOFT: interpretation unavailable (empty body, AI off, a failed or
 * partial run, a throwing seam in tests) falls back to the hidden-stripped raw
 * body for the DRAFT context. The autonomy hold for the same case is the
 * `interpretation_incomplete` gate (D3), not this function.
 */
export async function buildCurrentMessageSection(
	ctx: ActionCtx,
	message: {
		_id: Id<'inboundMessages'>;
		from: string;
		to: string;
		subject?: string;
		receivedAt: number;
	},
	inboundBody: string | undefined
): Promise<string> {
	let currentMessageBody = inboundBody ?? '(no body)';
	if (inboundBody != null && inboundBody.trim().length > 0) {
		const structured = await structuredActions(ctx, message._id);
		if (structured !== null) currentMessageBody = structured;
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

/**
 * The rendered actions of a completely interpreted message, or null (fall
 * back to the raw body). Runs interpretation only when the message has no
 * current extraction, or its extraction is an older extractor's or due for a
 * repair. Never throws.
 */
async function structuredActions(
	ctx: ActionCtx,
	inboundMessageId: Id<'inboundMessages'>
): Promise<string | null> {
	try {
		let read = await ctx.runQuery(internal.mail.interpret.teamActions.briefingActions, {
			inboundMessageId,
		});
		if (!read.interpretation || read.interpretation.isRerunDue) {
			const canRun = await ctx.runMutation(internal.mail.interpret.teamActions.captureInbound, {
				inboundMessageId,
			});
			if (!canRun) return null;
			await ctx.runAction(internal.mail.interpret.run.interpretMessage, {
				source: { kind: 'inbound', id: inboundMessageId },
			});
			read = await ctx.runQuery(internal.mail.interpret.teamActions.briefingActions, {
				inboundMessageId,
			});
		}
		if (read.interpretation?.status !== 'complete') return null;
		return renderBriefingActions(read.items);
	} catch {
		// Fail soft — keep the hidden-stripped raw body.
		return null;
	}
}
