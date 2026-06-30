/**
 * AMP Email renderer.
 * Generates AMP4Email-compatible HTML as a third format alongside HTML and plain text.
 * Replaces CSS-only interactive components with AMP equivalents.
 *
 * @see https://amp.dev/documentation/guides-and-tutorials/learn/email-spec/amp-email-format
 */

import type { EditorBlock } from '@owlat/shared';
import type { RenderOptions } from './types';
import { escapeHtml, escapeAttr } from './sanitize';
import { moduleFor } from './blocks/_registry';
import { DEFAULT_BASE_WIDTH } from './renderer';
// Side-effect: ensure built-in modules are registered when AMP rendering runs
// even if `blocks/index.ts` was never imported by the caller.
import './blocks/_builtin-modules';

/**
 * Render blocks to AMP4Email HTML.
 *
 * Every block module supplies its own `amp()` variant: layout blocks
 * (columns/hero/container) recurse into their children, table-based blocks
 * (table/list/progressBar/menu) reuse their AMP-valid markup, and image-bearing
 * blocks (image/social/video/carousel) emit `<amp-img>`. The only block without
 * an AMP equivalent is `rawHtml` (AMP forbids arbitrary HTML), which emits a
 * skipped-block comment so the output stays valid AMP4Email.
 */
export const renderAmpEmail = (blocks: EditorBlock[], options?: RenderOptions): string => {
	const lang = escapeAttr(options?.lang ?? 'en');
	const title = escapeHtml(options?.title ?? '');

	const bodyContent = blocks
		.map((block) => renderAmpBlock(block))
		.filter(Boolean)
		.join('\n');

	return `<!doctype html>
<html ⚡4email lang="${lang}">
<head>
<meta charset="utf-8">
<script async src="https://cdn.ampproject.org/v0.js"></script>
${needsAccordion(blocks) ? '<script async custom-element="amp-accordion" src="https://cdn.ampproject.org/v0/amp-accordion-0.1.js"></script>' : ''}
${needsCarousel(blocks) ? '<script async custom-element="amp-carousel" src="https://cdn.ampproject.org/v0/amp-carousel-0.2.js"></script>' : ''}
${needsFit(blocks) ? '<script async custom-element="amp-fit-text" src="https://cdn.ampproject.org/v0/amp-fit-text-0.1.js"></script>' : ''}
<style amp4email-boilerplate>body{visibility:hidden}</style>
<style amp-custom>
body{margin:0;padding:0;font-family:Arial,sans-serif}
.owlat-container{max-width:${options?.baseWidth ?? DEFAULT_BASE_WIDTH}px;margin:0 auto;padding:0 16px}
.owlat-btn{display:inline-block;text-decoration:none;text-align:center;border-radius:4px;padding:12px 24px}
</style>
<title>${title}</title>
</head>
<body>
<div class="owlat-container">
${bodyContent}
</div>
</body>
</html>`;
};

const needsAccordion = (blocks: EditorBlock[]): boolean =>
	blocks.some((b) => b.type === 'accordion');

const needsCarousel = (blocks: EditorBlock[]): boolean =>
	blocks.some((b) => b.type === 'carousel');

const needsFit = (_blocks: EditorBlock[]): boolean => false;

/**
 * Dispatch a single block to its Block module's `amp` method. Blocks without
 * an AMP renderer (`rawHtml`) or unknown types emit an HTML comment so the
 * output stays valid AMP4Email.
 *
 * Composite blocks recurse through `walk: renderAmpBlock`.
 */
const renderAmpBlock = (block: EditorBlock): string => {
	const mod = moduleFor(block.type);
	return mod?.amp?.({
		block,
		content: block.content,
		walk: renderAmpBlock,
	}) ?? `<!-- AMP: ${escapeHtml(block.type)} block not supported -->`;
};
