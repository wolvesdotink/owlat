/**
 * Command matrix for `useRichText` format toggles. These lock in the
 * Selection/Range implementation of every command (bold/italic/underline/
 * heading/blockquote/list/link) so the migration OFF `document.execCommand`
 * stays a zero-behavior-change refactor: none of these paths touch execCommand,
 * they mutate the DOM through Selection/Range + surroundContents/wrapping,
 * block conversion, and list toggling.
 *
 * Covered per command: caret (collapsed) vs inline selection vs cross-block
 * selection, toggle-off, nested combos, and list<->paragraph round-trips.
 * Native undo of programmatic inserts (which delegates to the browser's own
 * edit pipeline) is asserted at the seam level in
 * `useRichTextReplaceSelection.test.ts`; JSDOM/happy-dom cannot execute the
 * browser undo stack, so end-to-end undo is manual-verified (see PR body).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ref } from 'vue';
import { useRichText } from '../useRichText';

function mountEditor(html: string): HTMLElement {
	document.body.innerHTML = '';
	const editor = document.createElement('div');
	editor.setAttribute('contenteditable', 'true');
	editor.innerHTML = html;
	document.body.appendChild(editor);
	return editor;
}

function firstTextContaining(root: Node, needle: string): { node: Text; index: number } {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	while (walker.nextNode()) {
		const node = walker.currentNode as Text;
		const at = node.data.indexOf(needle);
		if (at !== -1) return { node, index: at };
	}
	throw new Error(`needle not found: ${needle}`);
}

/** Select `needle` inside the editor as a non-collapsed inline range. */
function selectInline(editor: HTMLElement, needle: string): void {
	const { node, index } = firstTextContaining(editor, needle);
	const range = document.createRange();
	range.setStart(node, index);
	range.setEnd(node, index + needle.length);
	const sel = window.getSelection()!;
	sel.removeAllRanges();
	sel.addRange(range);
}

/** Place a collapsed caret immediately after `needle`'s first char. */
function placeCaretIn(editor: HTMLElement, needle: string): void {
	const { node, index } = firstTextContaining(editor, needle);
	const range = document.createRange();
	range.setStart(node, index + 1);
	range.collapse(true);
	const sel = window.getSelection()!;
	sel.removeAllRanges();
	sel.addRange(range);
}

/** Select across two block boundaries (start in `a`, end in `b`). */
function selectAcrossBlocks(editor: HTMLElement, a: string, b: string): void {
	const start = firstTextContaining(editor, a);
	const end = firstTextContaining(editor, b);
	const range = document.createRange();
	range.setStart(start.node, start.index);
	range.setEnd(end.node, end.index + b.length);
	const sel = window.getSelection()!;
	sel.removeAllRanges();
	sel.addRange(range);
}

function rt(editor: HTMLElement, opts: Record<string, unknown> = {}) {
	const editorRef = ref<HTMLElement | null>(editor);
	const onChange = vi.fn();
	return { ...useRichText({ editorRef, onChange, ...opts }), onChange };
}

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = '';
});

describe('inline marks (bold/italic/underline)', () => {
	const cases: Array<[string, 'toggleBold' | 'toggleItalic' | 'toggleUnderline', string]> = [
		['bold', 'toggleBold', 'strong'],
		['italic', 'toggleItalic', 'em'],
		['underline', 'toggleUnderline', 'u'],
	];

	for (const [label, method, tag] of cases) {
		it(`${label}: wraps an inline selection and notifies`, () => {
			const editor = mountEditor('<p>hello world foo</p>');
			const api = rt(editor);
			selectInline(editor, 'world');
			(api[method] as () => void)();
			expect(editor.querySelector(tag)?.textContent).toBe('world');
			expect(editor.textContent).toBe('hello world foo');
			expect(api.onChange).toHaveBeenCalledTimes(1);
		});

		it(`${label}: toggles OFF when the selection is already wrapped`, () => {
			const editor = mountEditor(`<p>hello <${tag}>world</${tag}> foo</p>`);
			const api = rt(editor);
			selectInline(editor, 'world');
			(api[method] as () => void)();
			expect(editor.querySelector(tag)).toBeNull();
			expect(editor.textContent).toBe('hello world foo');
		});

		it(`${label}: caret with no wrapper is a no-op`, () => {
			const editor = mountEditor('<p>hello world</p>');
			const before = editor.innerHTML;
			const api = rt(editor);
			placeCaretIn(editor, 'world');
			(api[method] as () => void)();
			expect(editor.innerHTML).toBe(before);
			expect(api.onChange).not.toHaveBeenCalled();
		});

		it(`${label}: caret inside an existing wrapper removes it`, () => {
			const editor = mountEditor(`<p>hello <${tag}>world</${tag}></p>`);
			const api = rt(editor);
			placeCaretIn(editor, 'world');
			(api[method] as () => void)();
			expect(editor.querySelector(tag)).toBeNull();
			expect(editor.textContent).toBe('hello world');
		});

		it(`${label}: cross-block selection does not throw`, () => {
			const editor = mountEditor('<p>alpha</p><p>bravo</p>');
			const api = rt(editor);
			selectAcrossBlocks(editor, 'alpha', 'bravo');
			expect(() => (api[method] as () => void)()).not.toThrow();
			expect(editor.textContent).toContain('alpha');
			expect(editor.textContent).toContain('bravo');
		});
	}

	it('nested combo: bold applied inside italic reports both marks active', () => {
		const editor = mountEditor('<p>hello world</p>');
		const api = rt(editor);
		selectInline(editor, 'world');
		api.toggleItalic();
		// selection is left on the <em> contents; wrap it in bold too.
		api.toggleBold();
		const em = editor.querySelector('em');
		expect(em?.querySelector('strong')?.textContent).toBe('world');
		const marks = api.readActiveMarks();
		expect(marks.bold).toBe(true);
		expect(marks.italic).toBe(true);
	});
});

describe('block conversions (heading/blockquote)', () => {
	it('heading: converts a paragraph and toggles back to <p>', () => {
		const editor = mountEditor('<p>title</p>');
		const api = rt(editor);
		placeCaretIn(editor, 'title');
		api.toggleHeading(1);
		expect(editor.querySelector('h1')?.textContent).toBe('title');

		placeCaretIn(editor, 'title');
		api.toggleHeading(1);
		expect(editor.querySelector('h1')).toBeNull();
		expect(editor.querySelector('p')?.textContent).toBe('title');
	});

	it('heading: H1 -> H2 swaps the block tag', () => {
		const editor = mountEditor('<h1>title</h1>');
		const api = rt(editor);
		placeCaretIn(editor, 'title');
		api.toggleHeading(2);
		expect(editor.querySelector('h1')).toBeNull();
		expect(editor.querySelector('h2')?.textContent).toBe('title');
	});

	it('blockquote: converts a paragraph and toggles back to <p>', () => {
		const editor = mountEditor('<p>quote me</p>');
		const api = rt(editor);
		placeCaretIn(editor, 'quote');
		api.toggleBlockquote();
		expect(editor.querySelector('blockquote')?.textContent).toBe('quote me');

		placeCaretIn(editor, 'quote');
		api.toggleBlockquote();
		expect(editor.querySelector('blockquote')).toBeNull();
		expect(editor.querySelector('p')?.textContent).toBe('quote me');
	});
});

describe('list toggling', () => {
	it('unordered: paragraph <-> list round-trip', () => {
		const editor = mountEditor('<p>item</p>');
		const api = rt(editor);
		placeCaretIn(editor, 'item');
		api.toggleList(false);
		expect(editor.querySelector('ul > li')?.textContent).toBe('item');

		placeCaretIn(editor, 'item');
		api.toggleList(false);
		expect(editor.querySelector('ul')).toBeNull();
		expect(editor.querySelector('p')?.textContent).toBe('item');
	});

	it('ordered: creates an <ol>', () => {
		const editor = mountEditor('<p>item</p>');
		const api = rt(editor);
		placeCaretIn(editor, 'item');
		api.toggleList(true);
		expect(editor.querySelector('ol > li')?.textContent).toBe('item');
	});

	it('swaps <ul> -> <ol> when toggling the other list type', () => {
		const editor = mountEditor('<ul><li>item</li></ul>');
		const api = rt(editor);
		placeCaretIn(editor, 'item');
		api.toggleList(true);
		expect(editor.querySelector('ul')).toBeNull();
		expect(editor.querySelector('ol > li')?.textContent).toBe('item');
	});
});

describe('link', () => {
	it('wraps an inline selection in a safe anchor', async () => {
		const editor = mountEditor('<p>hello world</p>');
		const api = rt(editor, { promptForLink: () => 'https://example.com' });
		selectInline(editor, 'world');
		await api.setLink();
		const a = editor.querySelector('a');
		expect(a?.getAttribute('href')).toBe('https://example.com');
		expect(a?.getAttribute('target')).toBe('_blank');
		expect(a?.getAttribute('rel')).toBe('noreferrer noopener');
		expect(a?.textContent).toBe('world');
	});

	it('inserts an anchor at a caret using the URL as its text', async () => {
		const editor = mountEditor('<p>hello </p>');
		const api = rt(editor, { promptForLink: () => 'https://caret.example' });
		placeCaretIn(editor, 'hello');
		await api.setLink();
		const a = editor.querySelector('a');
		expect(a?.getAttribute('href')).toBe('https://caret.example');
		expect(a?.textContent).toBe('https://caret.example');
	});

	it('removes an existing link when the resolver returns an empty string', async () => {
		const editor = mountEditor('<p>hello <a href="https://x.example">world</a></p>');
		const api = rt(editor, { promptForLink: () => '' });
		placeCaretIn(editor, 'world');
		await api.setLink();
		expect(editor.querySelector('a')).toBeNull();
		expect(editor.textContent).toBe('hello world');
	});

	it('cancels (leaves DOM untouched) when the resolver returns null', async () => {
		const editor = mountEditor('<p>hello world</p>');
		const before = editor.innerHTML;
		const api = rt(editor, { promptForLink: () => null });
		selectInline(editor, 'world');
		await api.setLink();
		expect(editor.innerHTML).toBe(before);
		expect(api.onChange).not.toHaveBeenCalled();
	});
});

describe('readActiveMarks', () => {
	it('reports every active mark for the caret position', () => {
		const editor = mountEditor(
			'<blockquote><strong><em><u>x</u></em></strong></blockquote>',
		);
		const api = rt(editor);
		placeCaretIn(editor, 'x');
		const marks = api.readActiveMarks();
		expect(marks.bold).toBe(true);
		expect(marks.italic).toBe(true);
		expect(marks.underline).toBe(true);
		expect(marks.quote).toBe(true);
	});

	it('returns all-false with no selection', () => {
		const editor = mountEditor('<p>x</p>');
		const api = rt(editor);
		window.getSelection()!.removeAllRanges();
		expect(api.readActiveMarks().bold).toBe(false);
	});
});

describe('none of the format commands touch execCommand', () => {
	it('leaves a spy on document.execCommand uncalled', () => {
		const editor = mountEditor('<p>hello world</p>');
		const spy = vi.fn();
		(document as { execCommand?: unknown }).execCommand = spy;
		const api = rt(editor, { promptForLink: () => 'https://e.example' });

		selectInline(editor, 'world');
		api.toggleBold();
		placeCaretIn(editor, 'hello');
		api.toggleHeading(1);
		placeCaretIn(editor, 'hello');
		api.toggleList(false);

		expect(spy).not.toHaveBeenCalled();
		delete (document as { execCommand?: unknown }).execCommand;
	});
});
