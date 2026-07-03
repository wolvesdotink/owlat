/**
 * DOM tests for `useRichText().replaceSelection` — the seam the Postbox AI
 * selection-rewrite "Apply" uses to swap the selected text. It must (a) replace
 * exactly the selected range and (b) prefer the browser's own edit pipeline
 * (`execCommand('insertText')`) so the swap is undo-able as one native step,
 * falling back to a manual range replace when that is unavailable.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ref } from 'vue';
import { useRichText } from '../useRichText';

/** Mount a contenteditable editor and select the substring `needle`. */
function mountAndSelect(html: string, needle: string) {
	document.body.innerHTML = '';
	const editor = document.createElement('div');
	editor.setAttribute('contenteditable', 'true');
	editor.innerHTML = html;
	document.body.appendChild(editor);

	const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
	let textNode: Text | null = null;
	let index = -1;
	while (walker.nextNode()) {
		const node = walker.currentNode as Text;
		const at = node.data.indexOf(needle);
		if (at !== -1) {
			textNode = node;
			index = at;
			break;
		}
	}
	if (!textNode) throw new Error(`needle not found: ${needle}`);
	const range = document.createRange();
	range.setStart(textNode, index);
	range.setEnd(textNode, index + needle.length);
	const sel = window.getSelection()!;
	sel.removeAllRanges();
	sel.addRange(range);
	return editor;
}

// happy-dom does not implement document.execCommand at all, so tests install a
// controllable stub and remove it afterwards.
const originalExec = (document as { execCommand?: unknown }).execCommand;
afterEach(() => {
	vi.restoreAllMocks();
	if (originalExec === undefined) {
		delete (document as { execCommand?: unknown }).execCommand;
	} else {
		(document as { execCommand?: unknown }).execCommand = originalExec;
	}
	document.body.innerHTML = '';
});

describe('replaceSelection', () => {
	it('prefers execCommand("insertText") so the swap is one native undo step', () => {
		const editor = mountAndSelect('<p>hello world foo</p>', 'world');
		const editorRef = ref<HTMLElement | null>(editor);
		const onChange = vi.fn();
		const exec = vi.fn().mockReturnValue(true);
		(document as { execCommand?: unknown }).execCommand = exec;

		const { replaceSelection } = useRichText({ editorRef, onChange });
		const ok = replaceSelection('WORLD');

		expect(ok).toBe(true);
		expect(exec).toHaveBeenCalledWith('insertText', false, 'WORLD');
		// On the native path the input event drives the host re-emit, so the
		// composable must NOT double-emit via onChange.
		expect(onChange).not.toHaveBeenCalled();
	});

	it('falls back to a manual range replace that swaps exactly the selection', () => {
		const editor = mountAndSelect('<p>hello world foo</p>', 'world');
		const editorRef = ref<HTMLElement | null>(editor);
		const onChange = vi.fn();
		// Simulate an engine without execCommand (happy-dom/JSDOM/older browsers).
		delete (document as { execCommand?: unknown }).execCommand;

		const { replaceSelection } = useRichText({ editorRef, onChange });
		const ok = replaceSelection('WORLD');

		expect(ok).toBe(true);
		expect(editor.textContent).toBe('hello WORLD foo');
		// The fallback path is not observed by a native input event, so it emits.
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it('falls back to a manual range replace when execCommand exists but throws', () => {
		const editor = mountAndSelect('<p>hello world foo</p>', 'world');
		const editorRef = ref<HTMLElement | null>(editor);
		const onChange = vi.fn();
		// execCommand is present but throws (some engines reject insertText on a
		// detached/unsupported context); the composable must fail soft.
		const exec = vi.fn(() => {
			throw new Error('insertText unsupported');
		});
		(document as { execCommand?: unknown }).execCommand = exec;

		const { replaceSelection } = useRichText({ editorRef, onChange });
		const ok = replaceSelection('WORLD');

		expect(exec).toHaveBeenCalledWith('insertText', false, 'WORLD');
		expect(ok).toBe(true);
		expect(editor.textContent).toBe('hello WORLD foo');
		// The manual fallback is not observed by a native input event, so it emits once.
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it('no-ops (returns false) with no selection inside the editor', () => {
		document.body.innerHTML = '';
		const editor = document.createElement('div');
		editor.innerHTML = '<p>untouched</p>';
		document.body.appendChild(editor);
		window.getSelection()!.removeAllRanges();

		const editorRef = ref<HTMLElement | null>(editor);
		const { replaceSelection } = useRichText({ editorRef });
		expect(replaceSelection('X')).toBe(false);
		expect(editor.textContent).toBe('untouched');
	});
});
