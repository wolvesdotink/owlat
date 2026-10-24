/**
 * Incremental Markdown parsing for one streaming renderer.
 *
 * A streaming answer arrives as the whole text so far on every flush, so parsing
 * it whole each time costs O(n²) over the answer. The parser here keeps the
 * blocks that can no longer change (see `parseMarkdownSettled`) together with the
 * source text they came from, and on the next flush parses only what follows
 * that text. Parsing per flush is then bounded by the unsettled tail: the block
 * the stream is extending, plus at most the complete block before it (a block
 * settles only once the line after it is complete, so a just-closed fence stays
 * in the tail until the next line ends). One growing paragraph, list or unclosed
 * fence is still parsed again in full on every flush until it ends. The settled
 * prefix is not parsed again, but each flush still does linear work over it: a
 * prefix compare of the settled source, and copying and identity-comparing the
 * settled block array. Those are cheap next to parsing.
 *
 * The result shares structure with the previous one (settled blocks are the very
 * same objects, the tail is matched by position), so a renderer re-renders only
 * the blocks the new text changed, and gets the previous array back when nothing
 * changed.
 */
import { shareStructure } from '~/lib/structuralSharing';
import { parseMarkdown, parseMarkdownSettled, type Block } from '~/utils/markdown';

/**
 * A line that starts like a reference or footnote definition (`[id]: …`). A
 * definition applies to the whole document, so it can change how text before
 * it renders: settled blocks would no longer be independent of what follows.
 * The parser renders such lines as text today, so the fallback changes no
 * output; it keeps the incremental result equal to a full parse if definitions
 * ever gain meaning.
 */
const DEFINITION = /^ {0,3}\[[^\]\n]+\]:/m;

/** Index just past the `count`-th `\n` in `text`. */
function offsetAfterLines(text: string, count: number): number {
	let offset = 0;
	for (let n = 0; n < count; n++) offset = text.indexOf('\n', offset) + 1;
	return offset;
}

/**
 * A parser that returns `parseMarkdown(source)` for every source it is given,
 * reusing the settled part of the previous source when the new one extends it.
 * Any other source (an edit, a truncation, a replacement, an empty string)
 * drops the cache and parses from the start. Create one per rendered answer.
 */
export function createIncrementalMarkdown(): (source: string) => Block[] {
	// The source text the settled blocks were parsed from; it always ends at a
	// line break, so a CRLF can never straddle it.
	let settledSource = '';
	let settled: Block[] = [];
	let previous: Block[] = [];

	return (source) => {
		if (!source.startsWith(settledSource)) {
			settledSource = '';
			settled = [];
		}
		// The settled source was checked for definitions while it was the tail,
		// so only the tail needs checking now.
		const tail = source.slice(settledSource.length);
		if (DEFINITION.test(tail)) {
			settledSource = '';
			settled = [];
			previous = shareStructure(previous, parseMarkdown(source));
			return previous;
		}

		const parsed = parseMarkdownSettled(tail);
		// `settled` holds the same objects as the head of `previous`, so sharing
		// compares those by identity and walks only the tail's blocks.
		previous = shareStructure(previous, settled.concat(parsed.blocks));
		if (parsed.settledLines > 0) {
			settledSource += tail.slice(0, offsetAfterLines(tail, parsed.settledLines));
			settled = previous.slice(0, settled.length + parsed.settledBlocks);
		}
		return previous;
	};
}
