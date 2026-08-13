import type { EditorBlock } from '@owlat/shared';
import type { RenderOptions } from './types';
import { moduleFor } from './blocks/_registry';
// Side-effect: ensure built-in modules are registered when plaintext rendering
// runs even if `blocks/index.ts` was never imported by the caller.
import './blocks/_builtin-modules';

/**
 * Dispatch a single block to its Block module's `plaintext` method. Blocks
 * without a `plaintext` method (or unknown types) produce an empty string.
 *
 * Composite blocks recurse through `walk: renderBlockPlainText` in their
 * args, so the entire plaintext output is a single tree walk.
 */
const renderBlockPlainText = (block: EditorBlock): string => {
	const mod = moduleFor(block.type);
	return (
		mod?.plaintext?.({
			block,
			content: block.content,
			walk: renderBlockPlainText,
		}) ?? ''
	);
};

/**
 * Normalize the joined body: strip trailing spaces, collapse runs of blank
 * lines to one, and trim the ends. Block modules emit their own internal
 * spacing, so a decorative block that resolves to '' cannot leave a hole.
 */
const normalize = (text: string): string =>
	text
		.replace(/\r\n/g, '\n')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();

/**
 * Render an array of EditorBlocks to plain text.
 * Useful for multipart email (text/plain) which improves deliverability.
 */
export const renderPlainText = (blocks: EditorBlock[], _options?: RenderOptions): string =>
	normalize(
		blocks
			.map((block) => renderBlockPlainText(block))
			.filter(Boolean)
			.join('\n\n')
	);

/**
 * Whether a stored manual override actually carries content. Whitespace-only
 * overrides (a cleared editor) fall back to the generated body.
 */
export const hasPlainTextOverride = (override: string | null | undefined): boolean =>
	typeof override === 'string' && override.trim().length > 0;

/**
 * The text/plain body to ship: the author's manual override when they wrote
 * one, otherwise the body generated from the block document. Every send path
 * resolves through this so "override wins" is stated once.
 *
 * An override is shipped as written. Only line endings are canonicalized and
 * the document ends trimmed — `normalize()`'s blank-line collapsing belongs to
 * the generated branch, where the holes it closes are the renderer's own; in a
 * hand-written body the spacing is the author's, and quietly rewriting it
 * (ASCII rules, stanza breaks, an indented signature) is not ours to do.
 */
export const resolvePlainText = (
	blocks: EditorBlock[],
	override: string | null | undefined,
	options?: RenderOptions
): string =>
	hasPlainTextOverride(override)
		? override!.replace(/\r\n/g, '\n').trim()
		: renderPlainText(blocks, options);
