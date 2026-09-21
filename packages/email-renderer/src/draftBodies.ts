import type { EditorBlock } from '@owlat/shared';
import { renderEmailHtml } from './renderer';
import { renderAmpEmail } from './amp';
import { resolvePlainText } from './plaintext';

/**
 * The ONE place a Postbox draft becomes wire bodies.
 *
 * This used to live inside `apps/api/convex/mail/outbound/build.ts`, reachable
 * only from the Node dispatch action — which meant the sender could never be
 * shown what would actually leave the building. In particular the `text/plain`
 * alternative, which terminal clients and screen readers get, was derived
 * entirely out of sight. Idea 14's "Preview as sent" needs the REAL one, so the
 * derivation moved here: dispatch and the composer preview now call the same
 * function, and a preview that disagrees with the send is a bug in one shared
 * implementation rather than a drift between two.
 *
 * Pure and runtime-agnostic (no Convex, no Node, no DOM), so the browser can
 * render exactly what the action renders.
 */

/** The draft fields the bodies are derived from — a structural subset of the row. */
export interface DraftBodySource {
	composerMode?: string;
	/** Rich-text HTML from the Simple composer. */
	bodyHtml?: string;
	/** Serialized EditorBlock[] from the full block designer. */
	bodyBlocks?: string;
	/** The author's manual text/plain override, when they wrote one. */
	bodyText?: string;
	subject?: string;
}

export interface DraftBodies {
	html: string;
	text: string;
	/** Only for block designs that use an interactive block. */
	amp?: string;
}

export interface RenderDraftBodiesOptions {
	/** Render the dark-mode variant (the composer preview's third pane). */
	darkMode?: boolean;
	/**
	 * Called when `bodyBlocks` will not parse, just before falling back to
	 * `bodyHtml`. Dispatch logs it; the preview ignores it.
	 */
	onBlockParseError?: (err: unknown) => void;
}

/**
 * Resolve the final HTML + plain-text (+ optional AMP) bodies for a draft.
 *
 *   - composerMode='full': bodyBlocks holds the block document built by the
 *     @owlat/email-builder; render it through the pipeline directly. Block
 *     designs also get an AMP4Email rendering so interactive blocks (accordion,
 *     carousel) ship as a `text/x-amp-html` alternative for AMP-capable
 *     clients — but only when the design actually uses one, since otherwise the
 *     AMP body is byte-for-byte the static fallback and just inflates the
 *     message.
 *   - composerMode='simple' (or unset): bodyHtml holds rich-text HTML from the
 *     in-house PostboxBasicEditor. Wrap it in a synthetic text block so it
 *     inherits the same boilerplate, CSS inlining and dark-mode handling.
 *     No AMP variant — the simple editor has no interactive blocks.
 */
export function renderDraftBodies(
	draft: DraftBodySource,
	options: RenderDraftBodiesOptions = {}
): DraftBodies {
	const renderOptions = { darkMode: options.darkMode ?? false };
	const wantsFull =
		draft.composerMode === 'full' ||
		(!draft.composerMode && draft.bodyBlocks && draft.bodyBlocks !== '[]');

	if (wantsFull && draft.bodyBlocks) {
		try {
			const blocks = JSON.parse(draft.bodyBlocks) as EditorBlock[];
			if (blocks.length > 0) {
				const html = renderEmailHtml(blocks, renderOptions);
				const text = resolvePlainText(blocks, draft.bodyText);
				const amp = blocks.some((b) => b.type === 'accordion' || b.type === 'carousel')
					? renderAmpEmail(blocks, { title: draft.subject })
					: undefined;
				return { html, text, amp };
			}
		} catch (err) {
			options.onBlockParseError?.(err);
		}
	}

	// Simple mode (or an empty designer): wrap bodyHtml in a single text block.
	const wrapped: EditorBlock = {
		id: 'postbox-body',
		type: 'text',
		content: { html: draft.bodyHtml || '' },
	} as unknown as EditorBlock;
	return {
		html: renderEmailHtml([wrapped], renderOptions),
		text: resolvePlainText([wrapped], draft.bodyText),
	};
}
