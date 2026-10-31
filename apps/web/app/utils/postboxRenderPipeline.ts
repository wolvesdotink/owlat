/**
 * The string half of the Postbox message-body render: everything that turns a
 * raw mail body into sanitized, theme-adapted, link-checked HTML.
 *
 * It runs in a dedicated worker (workers/postboxRender.worker.ts) so a long
 * newsletter's sanitize-html parse and dark-mode pass never block the reader,
 * and on the main thread only when no worker can run. Both run this exact
 * function, so the output is identical either way. That is why this module
 * must stay DOM-free: no `document`, `window`, `DOMParser` or anything that
 * reaches for them, in this file or in what it imports. The remaining stage,
 * remote-image consent (utils/postboxRemoteResources), parses into an inert
 * `<template>` and stays on the main thread.
 *
 * Order matters and is the security boundary: sanitization runs before every
 * other transform, so dark adaptation, `cid:` substitution and the link passes
 * only ever read sanitized markup.
 */

import sanitizeHtml from 'sanitize-html';
import { POSTBOX_SANITIZE_CONFIG } from '@owlat/shared/postboxSanitize';
import { applyLinkTransparency } from '@owlat/shared/postboxLinkTransparency';
import { splitQuotedHtml, splitQuotedText } from '@owlat/shared/quotedText';
import { adaptEmailHtml, type EmailHtmlKind, type PostboxRenderScheme } from './postboxDarkMode';
import { trimTrailingBlankBlocks } from './postboxBodyTidy';
import { resolveCidImages } from './postboxCidImages';

export interface PostboxRenderStageInput {
	/** The body's HTML part; empty when the message has none. */
	html: string;
	/** The text part, rendered when there is no HTML part. */
	text: string;
	/** Include the quoted reply chain below the fresh content. */
	showQuoted: boolean;
	/** Scheme the app asks for (the body may still render light). */
	scheme: PostboxRenderScheme;
	/** Resolved inline images: normalized Content-ID → `data:` URL. */
	cidUrls: ReadonlyMap<string, string>;
	/**
	 * Tag the divider above the quoted chain with {@link POSTBOX_QUOTE_DIVIDER_ATTR},
	 * so a reader of the output can tell the fresh text from the quoted. Only
	 * find in conversation's index asks; the body the iframe shows never carries it.
	 */
	markQuoteDivider?: boolean;
}

export interface PostboxRenderStageOutput {
	/** Sanitized, adapted, link-checked body, before remote-image consent. */
	html: string;
	/** Scheme the iframe renders with ("designed" mail stays light). */
	scheme: PostboxRenderScheme;
	kind: EmailHtmlKind;
	/** The body has a quoted reply chain to fold away. */
	hasQuote: boolean;
}

/** A render request posted to the worker. */
export interface PostboxRenderWorkerRequest {
	id: number;
	input: PostboxRenderStageInput;
}

/** The worker's answer to one request. */
export type PostboxRenderWorkerResponse =
	| { id: number; ok: true; output: PostboxRenderStageOutput }
	| { id: number; ok: false; error: string };

const QUOTE_DIVIDER_STYLE = 'margin:1.25em 0;border:0;border-top:1px solid rgba(128,128,128,0.3)';
const QUOTE_DIVIDER = `<hr style="${QUOTE_DIVIDER_STYLE}">`;

/**
 * Marks the divider when {@link PostboxRenderStageInput.markQuoteDivider} asks.
 * The sanitizer drops every `data-*` attribute, so mail cannot forge it.
 */
export const POSTBOX_QUOTE_DIVIDER_ATTR = 'data-owlat-quote-divider';
const MARKED_QUOTE_DIVIDER = `<hr ${POSTBOX_QUOTE_DIVIDER_ATTR}="" style="${QUOTE_DIVIDER_STYLE}">`;

function sanitize(html: string): string {
	return sanitizeHtml(html, POSTBOX_SANITIZE_CONFIG);
}

function escapeText(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/\n/g, '<br>');
}

/** Split off the quoted reply chain; a text body becomes HTML of the same shape. */
function splitBody(input: PostboxRenderStageInput) {
	if (input.html) return splitQuotedHtml(input.html);
	const split = splitQuotedText(input.text);
	return {
		fresh: `<pre style="white-space:pre-wrap;font-family:inherit;margin:0;">${escapeText(split.fresh)}</pre>`,
		quoted: split.quoted
			? `<pre style="white-space:pre-wrap;font-family:inherit;margin:0;color:#666;">${escapeText(split.quoted)}</pre>`
			: '',
		hasQuote: split.hasQuote,
	};
}

/** Every `<a>` opens a new browsing context with no referrer and no opener. */
function rewriteLinks(html: string): string {
	return html.replace(/<a\s+([^>]*)>/gi, (_match, attrs: string) => {
		const cleaned = attrs
			.replace(/\s+target\s*=\s*"[^"]*"/gi, '')
			.replace(/\s+rel\s*=\s*"[^"]*"/gi, '');
		return `<a ${cleaned} target="_blank" rel="noreferrer noopener">`;
	});
}

export function renderPostboxBodyStage(input: PostboxRenderStageInput): PostboxRenderStageOutput {
	const split = splitBody(input);
	// Blank padding above a folded-away quote is all that would be left at the
	// bottom of the body, so it goes; with the quote shown it separates the two.
	const fresh = input.showQuoted
		? sanitize(split.fresh)
		: trimTrailingBlankBlocks(sanitize(split.fresh));
	const quoted = input.showQuoted ? sanitize(split.quoted) : '';
	const divider = input.markQuoteDivider ? MARKED_QUOTE_DIVIDER : QUOTE_DIVIDER;
	const combined = quoted ? `${fresh}${divider}${quoted}` : fresh;
	// Adaptive dark rendering reads the sanitized string only; for a light app
	// (or a message forced light) it is a pass-through.
	const adapted = adaptEmailHtml(combined, input.scheme);
	const resolved = resolveCidImages(adapted.html, input.cidUrls);
	// Link transparency (real-host tooltips, phish-mismatch markers, tracking
	// param stripping) runs on sanitized output only and fails soft to a no-op.
	const html = rewriteLinks(applyLinkTransparency(resolved));
	return { html, scheme: adapted.scheme, kind: adapted.kind, hasQuote: split.hasQuote };
}
