/**
 * "Preview as sent" — the pure half (plan idea 14).
 *
 * The outbound builder derives a `text/plain` alternative the sender never
 * sees, and for a block-built message it is often nothing like the design.
 * Terminal clients, screen readers and every "show original" pane get whatever
 * `resolvePlainText` produced, sight unseen. This shows all three parts side by
 * side, derived through the SAME `renderDraftBodies` the dispatch action calls
 * (`@owlat/email-renderer`), so what the preview claims and what leaves the
 * building cannot drift.
 *
 * Module scope: no Vue, no Convex. Pane labels are catalog KEYS resolved by the
 * component that renders them.
 */

import { renderDraftBodies, type DraftBodySource } from '@owlat/email-renderer';

export type SentPreviewPaneId = 'html' | 'plain' | 'dark';

/** One pane of the preview, in the order they are shown. */
export interface SentPreviewPane {
	id: SentPreviewPaneId;
	/** i18n key for the pane's tab label. */
	labelKey: string;
}

const PANE_KEY_PREFIX = 'components.postbox.postboxPreviewAsSent.panes';

export const SENT_PREVIEW_PANES: readonly SentPreviewPane[] = [
	{ id: 'html', labelKey: `${PANE_KEY_PREFIX}.html` },
	{ id: 'plain', labelKey: `${PANE_KEY_PREFIX}.plain` },
	{ id: 'dark', labelKey: `${PANE_KEY_PREFIX}.dark` },
];

export interface SentPreview {
	/** The rendered HTML part, as a full document. */
	html: string;
	/** The same source rendered dark — what a dark-mode client shows. */
	dark: string;
	/** The REAL text/plain alternative that ships beside the HTML. */
	text: string;
	/** Present only when the design carries an interactive (AMP) block. */
	hasAmp: boolean;
}

/**
 * The three renderings of one draft. Blocks and HTML both flow through the
 * shared derivation, so simple-mode and designer drafts are previewed the same
 * way they are sent.
 */
export function buildSentPreview(draft: DraftBodySource): SentPreview {
	const light = renderDraftBodies(draft);
	const dark = renderDraftBodies(draft, { darkMode: true });
	return { html: light.html, dark: dark.html, text: light.text, hasAmp: light.amp !== undefined };
}

/**
 * The same lockdown the reader's message iframe uses: no script, no frame, no
 * form, no fetch — only images, inline styles and fonts. The preview renders
 * the sender's OWN markup, but it is markup a pasted signature or a template
 * could have carried in from anywhere, so it gets the same sandbox rather than
 * a weaker one on the grounds of authorship.
 */
const META_CSP =
	`<meta http-equiv="Content-Security-Policy" ` +
	`content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src https: data:;">`;

/**
 * Inject the CSP meta into a rendered document's `<head>`. Falls back to
 * prefixing the whole document when the head cannot be found, which still puts
 * the policy in front of every element the parser has yet to see.
 */
export function sentPreviewSrcdoc(html: string): string {
	const headOpen = /<head\b[^>]*>/i.exec(html);
	if (!headOpen) return `${META_CSP}${html}`;
	const at = headOpen.index + headOpen[0].length;
	return `${html.slice(0, at)}${META_CSP}${html.slice(at)}`;
}

/**
 * How the plain-text pane presents an empty alternative. An empty `text/plain`
 * part is a real (and bad) outcome worth naming rather than rendering as a
 * blank pane the sender reads as "still loading".
 */
export function isEmptyPlainText(text: string): boolean {
	return text.trim().length === 0;
}
