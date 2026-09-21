/**
 * "Share as link instead" (idea 10) — the pure half of the composer swap and
 * the settings list.
 *
 * Two jobs, both kept out of Vue so they can be tested without mounting a
 * Convex-backed composer:
 *
 *  1. {@link shareLinkBlockHtml} — the block that REPLACES the attachment in
 *     the body. This is the only part of the feature a recipient ever sees, and
 *     it is going out over SMTP into mail clients with hostile CSS support, so
 *     it is a plain anchor plus text and nothing else.
 *  2. {@link postboxShareLinkStatusKey} and friends — the copy the management
 *     list resolves. Module scope cannot call `useI18n`, so everything here
 *     returns a `{key, params}` pair the caller resolves at its render boundary.
 */

import { escapeHtml } from '@owlat/shared/html';
import type { AttachmentShareScope, AttachmentShareState } from '@owlat/shared/attachmentShares';

/** A catalog key plus the interpolations its message expects. */
export interface ShareLinkMessage {
	key: string;
	params?: Record<string, string | number>;
}

/** Everything the body block needs, with its copy already resolved. */
export interface ShareLinkBlockInput {
	/** The public URL. */
	url: string;
	/** The original attachment's filename, as the user knows it. */
	filename: string;
	/** Already-localized "Shared file" style heading. */
	heading: string;
	/** Already-localized meta line ("2.4 MB · link expires 12 March"). */
	meta: string;
}

/**
 * The HTML block inserted into the draft body in place of the attachment.
 *
 * Deliberately dumb markup. A share block is the one piece of this feature that
 * leaves the building: it renders in Outlook, in Gmail's stripped HTML, in a
 * plain-text client's degraded view, and inside a quoted reply three hops later.
 * So: a bordered `div`, an anchor whose visible text is the filename, and the
 * URL repeated nowhere clever. No background image, no flex, no custom
 * property, nothing a mail client will eat.
 *
 * The URL is EMITTED RAW into `href` after being escaped for attribute context.
 * It comes from our own backend (`attachmentShareUrl` over an
 * `INSTANCE_SECRET`-free token), never from user input, but the filename beside
 * it does come from a file the user picked, so both go through `escapeHtml` —
 * the block is written into a body that is later rendered and quoted, and a
 * filename containing `<script>` must not survive that trip.
 */
export function shareLinkBlockHtml(input: ShareLinkBlockInput): string {
	const url = escapeHtml(input.url);
	return [
		'<div class="owlat-share-link" style="margin:12px 0;padding:12px 14px;border:1px solid #d4d4d8;border-radius:6px">',
		`<div style="font-weight:600">${escapeHtml(input.heading)}</div>`,
		`<div><a href="${url}">${escapeHtml(input.filename)}</a></div>`,
		`<div style="color:#71717a;font-size:12px">${escapeHtml(input.meta)}</div>`,
		'</div>',
	].join('');
}

/**
 * Append the block to a draft body.
 *
 * Appended, never prepended: the file was an attachment, which sits below the
 * message, and dropping a download box above someone's first sentence changes
 * what the mail is about. An empty body still gets the block — a message that
 * is nothing but a shared file is a perfectly ordinary thing to send.
 */
export function appendShareLinkBlock(bodyHtml: string, block: string): string {
	return bodyHtml.trim().length === 0 ? block : `${bodyHtml}${block}`;
}

/** The three states a link can be in, as the list labels them. */
export function postboxShareLinkStatusKey(state: AttachmentShareState): string {
	return `shared.postboxShareLink.state.${state}`;
}

/** Label key for a link's access scope. */
export function postboxShareLinkScopeKey(scope: AttachmentShareScope): string {
	return `shared.postboxShareLink.scope.${scope}`;
}

/**
 * The one-line summary under a row's filename, as `{key, params}`.
 *
 * Takes the state the SERVER resolved rather than re-deriving it from the
 * timestamps: the row already carries the answer, and a client that recomputes
 * it can disagree with the route that actually refuses the download.
 *
 * The distinction that matters in the copy: a link nobody has opened reads
 * differently from one that has been fetched forty times, and an owner deciding
 * whether to revoke wants that number before anything else.
 */
export function postboxShareLinkSummary(
	state: AttachmentShareState,
	downloadCount: number
): ShareLinkMessage {
	return {
		key: `shared.postboxShareLink.summary.${state}`,
		params: { downloads: downloadCount },
	};
}

/**
 * Whether the meter is worried enough to offer the swap.
 *
 * The button appears exactly when the meter turns amber, which is the moment
 * the composer's own copy starts talking about links — offering it earlier
 * makes every ordinary attachment a decision, and offering it later means the
 * first time anyone sees it is after a bounce.
 */
export function shouldOfferShareLink(meter: { amber: boolean; over: boolean }): boolean {
	return meter.amber || meter.over;
}
