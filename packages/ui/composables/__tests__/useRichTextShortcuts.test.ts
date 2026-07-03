/**
 * DOM tests for `useRichText`'s Notion-style markdown typing shortcuts
 * (`patternShortcuts: true`). Each pattern converts on its trigger key, the
 * conversion is a single Cmd+Z away from the literal typed text, mid-line
 * markers stay inert, and the whole feature is off unless opted in.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ref } from 'vue';
import { useRichText } from '../useRichText';

function mount(html: string): HTMLElement {
	document.body.innerHTML = '';
	const editor = document.createElement('div');
	editor.setAttribute('contenteditable', 'true');
	editor.innerHTML = html;
	document.body.appendChild(editor);
	return editor;
}

/** Collapse the caret at the end of `node`'s text. */
function caretAtEndOf(node: Text): void {
	const sel = window.getSelection()!;
	const range = document.createRange();
	range.setStart(node, node.data.length);
	range.collapse(true);
	sel.removeAllRanges();
	sel.addRange(range);
}

function firstText(el: Element): Text {
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	const node = walker.nextNode();
	if (!node) throw new Error('no text node');
	return node as Text;
}

function beforeInput(inputType: string, data: string | null): InputEvent {
	let prevented = false;
	return {
		inputType,
		data,
		preventDefault() {
			prevented = true;
		},
		get defaultPrevented() {
			return prevented;
		},
	} as unknown as InputEvent;
}

function cmdZ(): KeyboardEvent {
	let prevented = false;
	return {
		key: 'z',
		metaKey: true,
		ctrlKey: false,
		shiftKey: false,
		preventDefault() {
			prevented = true;
		},
		get defaultPrevented() {
			return prevented;
		},
	} as unknown as KeyboardEvent;
}

type AsciiReplace = NonNullable<Parameters<typeof useRichText>[0]['asciiReplace']>;

function makeEditor(
	html: string,
	opts?: { patternShortcuts?: boolean; asciiReplace?: AsciiReplace },
) {
	const editor = mount(html);
	const editorRef = ref<HTMLElement | null>(editor);
	const onChange = vi.fn();
	const rt = useRichText({
		editorRef,
		onChange,
		patternShortcuts: opts?.patternShortcuts ?? true,
		asciiReplace: opts?.asciiReplace,
	});
	return { editor, onChange, ...rt };
}

/** A minimal `:)` → 🙂 matcher (only fires at a word boundary), for the tests. */
const smileyReplace: AsciiReplace = (before) => {
	if (!before.endsWith(':)')) return null;
	const start = before.length - 2;
	const prev = start > 0 ? before[start - 1]! : '';
	if (start !== 0 && !/\s/.test(prev)) return null;
	return { spanLen: 2, replacement: '🙂', literal: ':)' };
};

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = '';
});

describe('block shortcuts (trigger: space)', () => {
	it('"- " at line start becomes a bullet list', () => {
		const { editor, handleBeforeInput } = makeEditor('<p>-</p>');
		caretAtEndOf(firstText(editor.querySelector('p')!));
		const ev = beforeInput('insertText', ' ');
		expect(handleBeforeInput(ev)).toBe(true);
		expect(ev.defaultPrevented).toBe(true);
		expect(editor.querySelector('ul > li')).not.toBeNull();
		expect(editor.querySelector('p')).toBeNull();
	});

	it('"* " also becomes a bullet list', () => {
		const { editor, handleBeforeInput } = makeEditor('<p>*</p>');
		caretAtEndOf(firstText(editor.querySelector('p')!));
		expect(handleBeforeInput(beforeInput('insertText', ' '))).toBe(true);
		expect(editor.querySelector('ul > li')).not.toBeNull();
	});

	it('"1. " becomes an ordered list', () => {
		const { editor, handleBeforeInput } = makeEditor('<p>1.</p>');
		caretAtEndOf(firstText(editor.querySelector('p')!));
		expect(handleBeforeInput(beforeInput('insertText', ' '))).toBe(true);
		expect(editor.querySelector('ol > li')).not.toBeNull();
	});

	it('"# " becomes an H1 and "## " an H2', () => {
		const h1 = makeEditor('<p>#</p>');
		caretAtEndOf(firstText(h1.editor.querySelector('p')!));
		expect(h1.handleBeforeInput(beforeInput('insertText', ' '))).toBe(true);
		expect(h1.editor.querySelector('h1')).not.toBeNull();

		const h2 = makeEditor('<p>##</p>');
		caretAtEndOf(firstText(h2.editor.querySelector('p')!));
		expect(h2.handleBeforeInput(beforeInput('insertText', ' '))).toBe(true);
		expect(h2.editor.querySelector('h2')).not.toBeNull();
	});

	it('"> " becomes a blockquote', () => {
		const { editor, handleBeforeInput } = makeEditor('<p>&gt;</p>');
		caretAtEndOf(firstText(editor.querySelector('p')!));
		expect(handleBeforeInput(beforeInput('insertText', ' '))).toBe(true);
		expect(editor.querySelector('blockquote')).not.toBeNull();
	});

	it('Cmd+Z restores the literal "- " as a single undo step', () => {
		const { editor, handleBeforeInput, handleShortcutUndoKeydown } =
			makeEditor('<p>-</p>');
		caretAtEndOf(firstText(editor.querySelector('p')!));
		handleBeforeInput(beforeInput('insertText', ' '));
		expect(editor.querySelector('ul')).not.toBeNull();

		const undo = cmdZ();
		expect(handleShortcutUndoKeydown(undo)).toBe(true);
		expect(undo.defaultPrevented).toBe(true);
		expect(editor.querySelector('ul')).toBeNull();
		expect(editor.querySelector('p')).not.toBeNull();
		expect(editor.textContent).toBe('- ');
	});

	it('mid-line "- " does NOT convert', () => {
		const { editor, handleBeforeInput } = makeEditor('<p>hello -</p>');
		caretAtEndOf(firstText(editor.querySelector('p')!));
		expect(handleBeforeInput(beforeInput('insertText', ' '))).toBe(false);
		expect(editor.querySelector('ul')).toBeNull();
	});

	it('does not convert inside an existing list item (loop guard)', () => {
		const { editor, handleBeforeInput } = makeEditor('<ul><li>-</li></ul>');
		caretAtEndOf(firstText(editor.querySelector('li')!));
		expect(handleBeforeInput(beforeInput('insertText', ' '))).toBe(false);
		// still exactly one list, unchanged
		expect(editor.querySelectorAll('ul').length).toBe(1);
	});
});

describe('inline shortcuts (trigger: closing char)', () => {
	it('**bold** becomes <strong>; Cmd+Z restores the literal', () => {
		const { editor, handleBeforeInput, handleShortcutUndoKeydown } =
			makeEditor('<p>**bold*</p>');
		caretAtEndOf(firstText(editor.querySelector('p')!));
		expect(handleBeforeInput(beforeInput('insertText', '*'))).toBe(true);
		expect(editor.querySelector('strong')?.textContent).toBe('bold');
		expect(editor.textContent).toBe('bold');

		expect(handleShortcutUndoKeydown(cmdZ())).toBe(true);
		expect(editor.querySelector('strong')).toBeNull();
		expect(editor.textContent).toBe('**bold**');
	});

	it('*italic* becomes <em>', () => {
		const { editor, handleBeforeInput } = makeEditor('<p>*italic</p>');
		caretAtEndOf(firstText(editor.querySelector('p')!));
		expect(handleBeforeInput(beforeInput('insertText', '*'))).toBe(true);
		expect(editor.querySelector('em')?.textContent).toBe('italic');
		expect(editor.querySelector('strong')).toBeNull();
	});

	it('`code` becomes inline <code>', () => {
		const { editor, handleBeforeInput } = makeEditor('<p>`code</p>');
		caretAtEndOf(firstText(editor.querySelector('p')!));
		expect(handleBeforeInput(beforeInput('insertText', '`'))).toBe(true);
		expect(editor.querySelector('code')?.textContent).toBe('code');
	});

	it('does not re-convert inside an existing code span (loop guard)', () => {
		const { editor, handleBeforeInput } = makeEditor('<p><code>*x</code></p>');
		caretAtEndOf(firstText(editor.querySelector('code')!));
		expect(handleBeforeInput(beforeInput('insertText', '*'))).toBe(false);
		expect(editor.querySelector('em')).toBeNull();
	});
});

describe('asciiReplace (convert-on-space, shared one-shot undo)', () => {
	it('converts a boundary `:) ` to the emoji + the pressed space', () => {
		const { editor, handleBeforeInput } = makeEditor('<p>ok :)</p>', {
			asciiReplace: smileyReplace,
		});
		caretAtEndOf(firstText(editor.querySelector('p')!));
		const ev = beforeInput('insertText', ' ');
		expect(handleBeforeInput(ev)).toBe(true);
		expect(ev.defaultPrevented).toBe(true);
		expect(editor.textContent).toBe('ok 🙂 ');
	});

	it('first Cmd+Z restores the literal smiley + space as one step', () => {
		const { editor, handleBeforeInput, handleShortcutUndoKeydown } = makeEditor(
			'<p>ok :)</p>',
			{ asciiReplace: smileyReplace },
		);
		caretAtEndOf(firstText(editor.querySelector('p')!));
		handleBeforeInput(beforeInput('insertText', ' '));
		expect(editor.textContent).toBe('ok 🙂 ');

		const undo = cmdZ();
		expect(handleShortcutUndoKeydown(undo)).toBe(true);
		expect(undo.defaultPrevented).toBe(true);
		expect(editor.textContent).toBe('ok :) ');
	});

	it('does not fire mid-word (matcher rejects a glued `:)`)', () => {
		const { editor, handleBeforeInput } = makeEditor('<p>http:)</p>', {
			asciiReplace: smileyReplace,
		});
		caretAtEndOf(firstText(editor.querySelector('p')!));
		expect(handleBeforeInput(beforeInput('insertText', ' '))).toBe(false);
		expect(editor.textContent).toBe('http:)');
	});

	it('is inert without a matcher (default: no ASCII conversion)', () => {
		const { editor, handleBeforeInput } = makeEditor('<p>ok :)</p>');
		caretAtEndOf(firstText(editor.querySelector('p')!));
		expect(handleBeforeInput(beforeInput('insertText', ' '))).toBe(false);
		expect(editor.textContent).toBe('ok :)');
	});
});

describe('opt-out (patternShortcuts: false)', () => {
	it('leaves every pattern inert', () => {
		const { editor, handleBeforeInput, handleShortcutUndoKeydown } = makeEditor(
			'<p>-</p>',
			{ patternShortcuts: false },
		);
		caretAtEndOf(firstText(editor.querySelector('p')!));
		expect(handleBeforeInput(beforeInput('insertText', ' '))).toBe(false);
		expect(editor.querySelector('ul')).toBeNull();
		expect(editor.querySelector('p')?.textContent).toBe('-');
		// and the undo hook is a no-op too
		expect(handleShortcutUndoKeydown(cmdZ())).toBe(false);
	});
});
