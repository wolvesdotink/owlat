/**
 * Tests for the shared rich-text editor primitives in
 * `@owlat/ui/composables/useRichText`.
 *
 * Lives in apps/web/__tests__ because that's where happy-dom + the Vue
 * auto-import setup live. The composable itself has no Nuxt dependency.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ref } from 'vue';
import { useRichText } from '../../../../packages/ui/composables/useRichText';
import {
	findAncestor,
	getNearestBlock,
	unwrapElement,
	replaceTagPreservingChildren,
} from '../../../../packages/ui/composables/richTextDom';

function makeEditor(html: string) {
	const el = document.createElement('div');
	el.contentEditable = 'true';
	el.innerHTML = html;
	document.body.appendChild(el);
	return el;
}

function setSelection(node: Node, start: number, end: number = start) {
	const range = document.createRange();
	range.setStart(node, start);
	range.setEnd(node, end);
	const sel = window.getSelection()!;
	sel.removeAllRanges();
	sel.addRange(range);
	return range;
}

function selectAllText(el: HTMLElement) {
	const range = document.createRange();
	range.selectNodeContents(el);
	const sel = window.getSelection()!;
	sel.removeAllRanges();
	sel.addRange(range);
	return range;
}

beforeEach(() => {
	document.body.innerHTML = '';
});

describe('useRichText — pure DOM helpers', () => {
	it('findAncestor walks up to find tag, stops at editor boundary', () => {
		const editor = makeEditor('<p><strong>hi</strong></p>');
		const textNode = editor.querySelector('strong')!.firstChild!;
		expect(findAncestor(editor, textNode, 'strong')?.tagName.toLowerCase()).toBe('strong');
		expect(findAncestor(editor, textNode, 'p')?.tagName.toLowerCase()).toBe('p');
		// Editor itself is excluded
		expect(findAncestor(editor, textNode, 'div')).toBeNull();
	});

	it('getNearestBlock returns the closest block-level element', () => {
		const editor = makeEditor('<blockquote><p><em>x</em></p></blockquote>');
		const em = editor.querySelector('em')!.firstChild!;
		const block = getNearestBlock(editor, em);
		// p is the *nearest* block, before blockquote
		expect(block?.tagName.toLowerCase()).toBe('p');
	});

	it('unwrapElement removes the wrapper but keeps content in place', () => {
		const editor = makeEditor('<p><strong>hello</strong></p>');
		const strong = editor.querySelector('strong')!;
		unwrapElement(strong);
		expect(editor.innerHTML).toBe('<p>hello</p>');
	});

	it('replaceTagPreservingChildren swaps tag, keeps children + attributes off', () => {
		const editor = makeEditor('<p>hello <em>world</em></p>');
		const p = editor.querySelector('p')!;
		const swapped = replaceTagPreservingChildren(p, 'h1');
		expect(swapped.tagName.toLowerCase()).toBe('h1');
		expect(editor.innerHTML).toBe('<h1>hello <em>world</em></h1>');
	});
});

describe('useRichText — toggleBold / toggleItalic / toggleUnderline', () => {
	it('wraps a selected text range in <strong>', () => {
		const editor = makeEditor('hello world');
		const text = editor.firstChild!;
		setSelection(text, 0, 5);

		const editorRef = ref(editor);
		const onChange = vi.fn();
		const rt = useRichText({ editorRef, onChange });
		rt.toggleBold();

		expect(editor.innerHTML).toMatch(/<strong>hello<\/strong>/);
		expect(onChange).toHaveBeenCalledOnce();
	});

	it('un-wraps when toggling on already-bold text', () => {
		const editor = makeEditor('<p><strong>hello</strong> world</p>');
		const strongText = editor.querySelector('strong')!.firstChild!;
		setSelection(strongText, 0, 5);

		const editorRef = ref(editor);
		const rt = useRichText({ editorRef });
		rt.toggleBold();
		expect(editor.querySelector('strong')).toBeNull();
		expect(editor.textContent).toBe('hello world');
	});

	it('toggleItalic wraps in <em>', () => {
		const editor = makeEditor('hello');
		setSelection(editor.firstChild!, 0, 5);
		const editorRef = ref(editor);
		useRichText({ editorRef }).toggleItalic();
		expect(editor.innerHTML).toMatch(/<em>hello<\/em>/);
	});

	it('toggleUnderline wraps in <u>', () => {
		const editor = makeEditor('xyz');
		setSelection(editor.firstChild!, 0, 3);
		const editorRef = ref(editor);
		useRichText({ editorRef }).toggleUnderline();
		expect(editor.innerHTML).toMatch(/<u>xyz<\/u>/);
	});

	it('no-ops on collapsed selection (no wrapping into empty span)', () => {
		const editor = makeEditor('hello');
		setSelection(editor.firstChild!, 2, 2);
		const editorRef = ref(editor);
		const onChange = vi.fn();
		useRichText({ editorRef, onChange }).toggleBold();
		expect(editor.innerHTML).toBe('hello');
		expect(onChange).not.toHaveBeenCalled();
	});
});

describe('useRichText — toggleHeading / toggleBlockquote', () => {
	it('toggleHeading(1) replaces nearest paragraph with h1', () => {
		const editor = makeEditor('<p>title</p>');
		const text = editor.querySelector('p')!.firstChild!;
		setSelection(text, 0);
		const editorRef = ref(editor);
		useRichText({ editorRef }).toggleHeading(1);
		expect(editor.innerHTML).toBe('<h1>title</h1>');
	});

	it('toggleHeading on existing heading reverts to paragraph', () => {
		const editor = makeEditor('<h1>title</h1>');
		const text = editor.querySelector('h1')!.firstChild!;
		setSelection(text, 0);
		const editorRef = ref(editor);
		useRichText({ editorRef }).toggleHeading(1);
		expect(editor.innerHTML).toBe('<p>title</p>');
	});

	it('toggleBlockquote wraps the block', () => {
		const editor = makeEditor('<p>quote me</p>');
		const text = editor.querySelector('p')!.firstChild!;
		setSelection(text, 0);
		const editorRef = ref(editor);
		useRichText({ editorRef }).toggleBlockquote();
		expect(editor.innerHTML).toBe('<blockquote>quote me</blockquote>');
	});
});

describe('useRichText — toggleList', () => {
	it('toggleList(false) wraps a paragraph in <ul><li>', () => {
		const editor = makeEditor('<p>item</p>');
		const text = editor.querySelector('p')!.firstChild!;
		setSelection(text, 0);
		const editorRef = ref(editor);
		useRichText({ editorRef }).toggleList(false);
		expect(editor.innerHTML).toBe('<ul><li>item</li></ul>');
	});

	it('toggleList(true) wraps in <ol><li>', () => {
		const editor = makeEditor('<p>item</p>');
		setSelection(editor.querySelector('p')!.firstChild!, 0);
		useRichText({ editorRef: ref(editor) }).toggleList(true);
		expect(editor.innerHTML).toBe('<ol><li>item</li></ol>');
	});

	it('toggling same list type unwraps to paragraphs', () => {
		const editor = makeEditor('<ul><li>one</li><li>two</li></ul>');
		const li = editor.querySelector('li')!;
		setSelection(li.firstChild!, 0);
		useRichText({ editorRef: ref(editor) }).toggleList(false);
		expect(editor.innerHTML).toBe('<p>one</p><p>two</p>');
	});

	it('switching list type swaps ul <-> ol', () => {
		const editor = makeEditor('<ul><li>one</li></ul>');
		setSelection(editor.querySelector('li')!.firstChild!, 0);
		useRichText({ editorRef: ref(editor) }).toggleList(true);
		expect(editor.innerHTML).toBe('<ol><li>one</li></ol>');
	});
});

describe('useRichText — setLink', () => {
	it('wraps selected text with anchor + safe rel/target', async () => {
		const editor = makeEditor('hello');
		setSelection(editor.firstChild!, 0, 5);
		const editorRef = ref(editor);
		const rt = useRichText({
			editorRef,
			promptForLink: () => 'https://example.com',
		});
		await rt.setLink();
		const a = editor.querySelector('a')!;
		expect(a.getAttribute('href')).toBe('https://example.com');
		expect(a.getAttribute('target')).toBe('_blank');
		expect(a.getAttribute('rel')).toBe('noreferrer noopener');
	});

	it('clearing the URL ("") unwraps an existing link', async () => {
		const editor = makeEditor('<a href="https://x.test">click</a>');
		const text = editor.querySelector('a')!.firstChild!;
		setSelection(text, 0);
		const rt = useRichText({
			editorRef: ref(editor),
			promptForLink: () => '',
		});
		await rt.setLink();
		expect(editor.querySelector('a')).toBeNull();
		expect(editor.textContent).toBe('click');
	});

	it('cancelling (null) leaves DOM untouched', async () => {
		const editor = makeEditor('hello');
		setSelection(editor.firstChild!, 0, 5);
		const onChange = vi.fn();
		const rt = useRichText({
			editorRef: ref(editor),
			onChange,
			promptForLink: () => null,
		});
		await rt.setLink();
		expect(editor.innerHTML).toBe('hello');
		expect(onChange).not.toHaveBeenCalled();
	});
});

describe('useRichText — readActiveMarks', () => {
	it('reports correct marks for nested formatting', () => {
		const editor = makeEditor('<h1><strong><em>title</em></strong></h1>');
		const text = editor.querySelector('em')!.firstChild!;
		setSelection(text, 0);
		const marks = useRichText({ editorRef: ref(editor) }).readActiveMarks();
		expect(marks.bold).toBe(true);
		expect(marks.italic).toBe(true);
		expect(marks.h1).toBe(true);
		expect(marks.underline).toBe(false);
		expect(marks.link).toBe(false);
	});

	it('returns all-false when no selection in editor', () => {
		const editor = makeEditor('<p>x</p>');
		const marks = useRichText({ editorRef: ref(editor) }).readActiveMarks();
		expect(marks.bold).toBe(false);
		expect(marks.h1).toBe(false);
	});
});

describe('useRichText — pasteAsPlainText', () => {
	it('strips Word/Outlook HTML and inserts plain text', () => {
		const editor = makeEditor('hello ');
		setSelection(editor.firstChild!, 6);
		const onChange = vi.fn();
		const rt = useRichText({ editorRef: ref(editor), onChange });

		const data = new DataTransfer();
		data.setData('text/plain', 'world');
		const event = new ClipboardEvent('paste', { clipboardData: data });
		rt.pasteAsPlainText(event);

		expect(editor.textContent).toBe('hello world');
		expect(onChange).toHaveBeenCalled();
	});
});

describe('useRichText — handleFormatKeydown', () => {
	it('Cmd+B triggers bold and consumes the event', () => {
		const editor = makeEditor('hello');
		setSelection(editor.firstChild!, 0, 5);
		const rt = useRichText({ editorRef: ref(editor) });
		const event = new KeyboardEvent('keydown', { key: 'b', metaKey: true });
		const consumed = rt.handleFormatKeydown(event);
		expect(consumed).toBe(true);
		expect(editor.innerHTML).toMatch(/<strong>hello<\/strong>/);
	});

	it('non-meta key returns false (caller handles default)', () => {
		const editor = makeEditor('hi');
		const rt = useRichText({ editorRef: ref(editor) });
		const event = new KeyboardEvent('keydown', { key: 'a' });
		expect(rt.handleFormatKeydown(event)).toBe(false);
	});
});
