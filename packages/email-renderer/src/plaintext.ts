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
	return mod?.plaintext?.({
		block,
		content: block.content,
		walk: renderBlockPlainText,
	}) ?? '';
};

/**
 * Render an array of EditorBlocks to plain text.
 * Useful for multipart email (text/plain) which improves deliverability.
 */
export const renderPlainText = (blocks: EditorBlock[], _options?: RenderOptions): string => {
	return blocks
		.map((block) => renderBlockPlainText(block))
		.filter(Boolean)
		.join('\n\n');
};
