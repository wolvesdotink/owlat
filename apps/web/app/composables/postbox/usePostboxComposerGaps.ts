/**
 * The `[[...]]` gaps an AI draft leaves where a fact is missing (Answer mode,
 * plan §05): counted, painted, and one click away from being replaced.
 *
 *  - `gaps`: the placeholders in what was written (not in the quote). While
 *    the AI wrote them, the composer holds Send back until none is left and
 *    the footer says how many (policy in usePostboxComposerAnswerApi).
 *  - painting: a CSS Custom Highlight over each placeholder, so the body HTML
 *    (and so the draft row and the sent message) never gains a wrapper element.
 *    Browsers without the API show the brackets unpainted; the count and the
 *    preflight line still say what is left.
 *  - clicking inside a placeholder selects all of it, so typing replaces it.
 *
 * All composers share one highlight (`owlat-draft-gap`, styled in
 * assets/css/answer-mode.css); each instance keeps its own ranges in it.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, watch, type Ref } from 'vue';
import { freshDraftGaps } from '~/utils/answerDraft';

const HIGHLIGHT_NAME = 'owlat-draft-gap';
/** A placeholder inside one text node (a gap never spans a line break). */
const GAP_IN_TEXT = /\[\[[^[\]\n]{1,160}\]\]/g;

const rangesByComposer = new Map<symbol, Range[]>();

function highlightsSupported(): boolean {
	return (
		typeof CSS !== 'undefined' &&
		'highlights' in CSS &&
		typeof (globalThis as { Highlight?: unknown }).Highlight === 'function'
	);
}

function paintAll() {
	if (!highlightsSupported()) return;
	const all = [...rangesByComposer.values()].flat();
	const registry = (CSS as unknown as { highlights: Map<string, unknown> }).highlights;
	if (all.length === 0) {
		registry.delete(HIGHLIGHT_NAME);
		return;
	}
	const HighlightCtor = (globalThis as unknown as { Highlight: new (...r: Range[]) => unknown })
		.Highlight;
	registry.set(HIGHLIGHT_NAME, new HighlightCtor(...all));
}

/** Every placeholder's range in the editor's text, the quoted original left out. */
export function gapRangesIn(editor: HTMLElement): Range[] {
	const ranges: Range[] = [];
	const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (node.parentElement?.closest('.gmail_quote')) continue;
		const text = node.textContent ?? '';
		for (const match of text.matchAll(GAP_IN_TEXT)) {
			const range = document.createRange();
			range.setStart(node, match.index ?? 0);
			range.setEnd(node, (match.index ?? 0) + match[0].length);
			ranges.push(range);
		}
	}
	return ranges;
}

/** The placeholder a caret sits in: its text node and offsets, or null. */
export function gapAtCaret(node: Node, offset: number): { start: number; end: number } | null {
	if (node.nodeType !== Node.TEXT_NODE) return null;
	for (const match of (node.textContent ?? '').matchAll(GAP_IN_TEXT)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		if (offset >= start && offset <= end) return { start, end };
	}
	return null;
}

export function usePostboxComposerGaps(opts: {
	rootEl: Ref<HTMLElement | null>;
	bodyHtml: Ref<string>;
}) {
	const gaps = computed(() => freshDraftGaps(opts.bodyHtml.value));
	const id = Symbol('composer-gaps');

	function editor(): HTMLElement | null {
		return opts.rootEl.value?.querySelector<HTMLElement>('[contenteditable="true"]') ?? null;
	}

	function repaint() {
		const el = editor();
		const ranges = el && gaps.value.length > 0 ? gapRangesIn(el) : [];
		if (ranges.length === 0 && !rangesByComposer.has(id)) return;
		if (ranges.length === 0) rangesByComposer.delete(id);
		else rangesByComposer.set(id, ranges);
		paintAll();
	}

	// After the editor mirrors the new body into its DOM.
	watch(
		() => opts.bodyHtml.value,
		() => void nextTick(repaint)
	);

	// The editor can render a body after the tick above: a draft that opens
	// with its text (Answer mode's prepared reply) is painted by the editor a
	// frame or more later, and ranges taken before that point at nothing. So
	// the DOM itself also asks for a repaint, once per frame at most.
	let observer: MutationObserver | null = null;
	let frame: number | null = null;
	function schedule() {
		if (frame !== null) return;
		frame = requestAnimationFrame(() => {
			frame = null;
			repaint();
		});
	}

	function onClick() {
		const selection = document.getSelection();
		const el = editor();
		if (!selection || !selection.isCollapsed || !selection.anchorNode || !el) return;
		if (!el.contains(selection.anchorNode)) return;
		const gap = gapAtCaret(selection.anchorNode, selection.anchorOffset);
		if (!gap) return;
		selection.setBaseAndExtent(selection.anchorNode, gap.start, selection.anchorNode, gap.end);
	}

	onMounted(() => {
		opts.rootEl.value?.addEventListener('click', onClick);
		void nextTick(repaint);
		if (opts.rootEl.value && typeof MutationObserver !== 'undefined') {
			observer = new MutationObserver(schedule);
			observer.observe(opts.rootEl.value, { childList: true, subtree: true, characterData: true });
		}
	});
	onBeforeUnmount(() => {
		observer?.disconnect();
		if (frame !== null) cancelAnimationFrame(frame);
		opts.rootEl.value?.removeEventListener('click', onClick);
		if (rangesByComposer.delete(id)) paintAll();
	});

	return { gaps, gapCount: computed(() => gaps.value.length) };
}
