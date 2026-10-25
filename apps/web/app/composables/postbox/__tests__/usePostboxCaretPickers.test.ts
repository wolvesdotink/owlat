/**
 * The Postbox editor's caret pickers (`;` saved replies, `:` emoji) keep the
 * trigger, the matching and the insertion; the list on screen owns the
 * highlight and ↑ ↓ Enter Tab. These pin the hand-off: the controllers hang
 * the list from the caret, forward the editor's keys to the rendered list,
 * take nothing when no list is on screen, and leave an IME's keys alone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { usePostboxEmojiPicker } from '../usePostboxEmojiPicker';
import { usePostboxSnippetPicker, type EditorSnippet } from '../usePostboxSnippetPicker';

let editor: HTMLDivElement;

/** An editor holding `text` with the caret at its end. */
function editorWith(text: string) {
	editor = document.createElement('div');
	editor.contentEditable = 'true';
	editor.textContent = text;
	document.body.appendChild(editor);
	const node = editor.firstChild!;
	const range = document.createRange();
	range.setStart(node, text.length);
	range.collapse(true);
	// happy-dom reports no geometry: give the caret a box to hang the list from.
	range.getClientRects = () => [new DOMRect(40, 20, 1, 16)] as unknown as DOMRectList;
	vi.spyOn(Range.prototype, 'cloneRange').mockImplementation(() => range);
	const selection = window.getSelection()!;
	selection.removeAllRanges();
	selection.addRange(range);
	return ref(editor);
}

afterEach(() => {
	vi.restoreAllMocks();
	editor?.remove();
});

const key = (k: string) => new KeyboardEvent('keydown', { key: k, cancelable: true });
const composing = (k: string) =>
	new KeyboardEvent('keydown', { key: k, cancelable: true, isComposing: true });

const SNIPPETS: EditorSnippet[] = [
	{ _id: 's1', name: 'Refund policy', shortcut: 'refund', bodyHtml: '<p>30 days.</p>' },
	{ _id: 's2', name: 'Shipping times', shortcut: 'ship', bodyHtml: '<p>2 days.</p>' },
];

describe('usePostboxSnippetPicker', () => {
	function mountPicker(text: string) {
		const editorRef = editorWith(text);
		return usePostboxSnippetPicker({
			editorRef,
			snippets: () => SNIPPETS,
			insertOptions: () => undefined,
			emitContent: () => {},
		});
	}

	it('opens under the caret on ";" and forwards the editor keys to the list', () => {
		const picker = mountPicker('Hello ;re');
		picker.update();
		expect(picker.open.value).toBe(true);
		expect(picker.items.value.map((s) => s._id)).toEqual(['s1']);
		expect(picker.anchor.value?.getBoundingClientRect()).toMatchObject({ x: 40, y: 20 });

		const list = { handleKeydown: vi.fn(() => true), fieldAttrs: {} };
		picker.bindList(list);
		const down = key('ArrowDown');
		expect(picker.handleKeydown(down)).toBe(true);
		expect(list.handleKeydown).toHaveBeenCalledWith(down);
	});

	it('stays closed after a dismiss until the ";token" changes', () => {
		const picker = mountPicker('Hello ;re');
		picker.update();
		picker.dismiss();
		expect(picker.open.value).toBe(false);
		picker.update();
		expect(picker.open.value).toBe(false);
	});

	it('takes Escape itself when the list could not be placed, and leaves other keys', () => {
		const picker = mountPicker('Hello ;re');
		picker.update();
		picker.bindList(null);
		expect(picker.handleKeydown(key('Enter'))).toBe(false);
		const escape = key('Escape');
		expect(picker.handleKeydown(escape)).toBe(true);
		expect(escape.defaultPrevented).toBe(true);
		expect(picker.open.value).toBe(false);
	});

	it('leaves a composing key to the IME, Escape included', () => {
		const picker = mountPicker('Hello ;re');
		picker.update();
		const list = { handleKeydown: vi.fn(() => true), fieldAttrs: {} };
		picker.bindList(list);
		for (const k of ['ArrowDown', 'Enter', 'Escape']) {
			const event = composing(k);
			expect(picker.handleKeydown(event)).toBe(false);
			expect(event.defaultPrevented).toBe(false);
		}
		expect(list.handleKeydown).not.toHaveBeenCalled();
		expect(picker.open.value).toBe(true);
	});
});

describe('usePostboxEmojiPicker', () => {
	function mountPicker(text: string) {
		const editorRef = editorWith(text);
		return usePostboxEmojiPicker({
			editorRef,
			enabled: () => true,
			replaceSelection: () => true,
			emitContent: () => {},
		});
	}

	it('opens under the caret on ":sm" and forwards the editor keys to the list', () => {
		const picker = mountPicker('Nice :sm');
		picker.refresh();
		expect(picker.open.value).toBe(true);
		expect(picker.items.value.length).toBeGreaterThan(0);
		expect(picker.anchor.value?.getBoundingClientRect()).toMatchObject({ x: 40, y: 20 });

		const list = { handleKeydown: vi.fn(() => true), fieldAttrs: {} };
		picker.bindList(list);
		expect(picker.handleKeydown(key('Tab'))).toBe(true);
		expect(list.handleKeydown).toHaveBeenCalledOnce();
	});

	it('never inserts through a list that is not on screen', () => {
		const picker = mountPicker('Nice :sm');
		picker.refresh();
		const enter = key('Enter');
		expect(picker.handleKeydown(enter)).toBe(false);
		expect(enter.defaultPrevented).toBe(false);
		expect(picker.handleKeydown(key('Escape'))).toBe(true);
		expect(picker.open.value).toBe(false);
		expect(picker.anchor.value).toBeNull();
	});

	it('leaves a composing key to the IME, Escape included', () => {
		const picker = mountPicker('Nice :sm');
		picker.refresh();
		const list = { handleKeydown: vi.fn(() => true), fieldAttrs: {} };
		picker.bindList(list);
		for (const k of ['ArrowDown', 'Enter', 'Escape']) {
			const event = composing(k);
			expect(picker.handleKeydown(event)).toBe(false);
			expect(event.defaultPrevented).toBe(false);
		}
		expect(list.handleKeydown).not.toHaveBeenCalled();
		expect(picker.open.value).toBe(true);
	});
});
