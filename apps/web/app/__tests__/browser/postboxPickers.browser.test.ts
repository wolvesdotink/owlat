/**
 * The Postbox composer's caret-anchored pickers, in the real editor.
 *
 * `PostboxBasicEditor` is mounted as the composer mounts it, with the real
 * saved-reply (`;`) and `:shortcode:` emoji pickers. Playwright types into the
 * contenteditable, so the trigger comes from real `input` and `selectionchange`
 * events, the picker is placed from the caret's real client rect, and the
 * arrow keys, Enter and Escape travel the editor's own keydown pathway. The
 * editor has to keep focus throughout: the pickers drive the selection from
 * the text, never by taking focus.
 */
import { describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { mount } from '@vue/test-utils';
import PostboxBasicEditor from '~/components/postbox/PostboxBasicEditor.vue';
import PostboxEmojiPicker from '~/components/postbox/PostboxEmojiPicker.vue';
import PostboxSnippetPicker from '~/components/postbox/PostboxSnippetPicker.vue';
import PostboxSnippetSurface from '~/components/postbox/PostboxSnippetSurface.vue';
import type { EditorSnippet } from '~/composables/postbox/usePostboxSnippetPicker';

// The editor's AI helpers import the generated API; nothing here calls them
// (suggestions and rewrites stay off), so any path will do.
vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, { get: () => anyPath, apply: () => anyPath });
	return { api: anyPath };
});
vi.stubGlobal('useToast', () => ({ showToast: () => {} }));
vi.stubGlobal('requireConvex', () => {
	throw new Error('the pickers never call the backend');
});

const SNIPPETS: EditorSnippet[] = [
	{
		_id: 'thanks',
		name: 'Thanks',
		shortcut: 'thx',
		bodyHtml: 'Thanks for writing in.',
		useCount: 2,
	},
	{ _id: 'sig', name: 'Signature', shortcut: 'sig', bodyHtml: 'Best, the Owlat team', useCount: 1 },
];

function mountEditor() {
	const emitted: string[] = [];
	const wrapper = mount(PostboxBasicEditor, {
		attachTo: document.body,
		props: {
			modelValue: '',
			snippets: SNIPPETS,
			snippetInsert: { variableContext: {} },
			emojiShortcodesEnabled: true,
			'onUpdate:modelValue': (value: string) => emitted.push(value),
		},
		global: {
			components: {
				PostboxEmojiPicker,
				PostboxSnippetPicker,
				PostboxSnippetSurface,
			},
			stubs: {
				// The toolbars and the rewrite layer are off or empty while nothing is
				// selected, and the variable dialog only opens for a reply that asks
				// for answers; none of them is under test.
				PostboxEditorToolbar: true,
				PostboxFloatingFormatBar: true,
				PostboxRewriteLayer: true,
				PostboxSnippetVariableDialog: true,
			},
		},
	});
	const editor = wrapper.get<HTMLElement>('[role="textbox"]').element;
	const listbox = () => document.querySelector<HTMLElement>('[role="listbox"]');
	/**
	 * The box the list sits in: the shared popover's panel. It is what is
	 * placed at the caret and what scrolls; its border insets the listbox.
	 */
	const panel = () => listbox()?.closest<HTMLElement>('.ui-popover') ?? null;
	const options = () => [...(listbox()?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
	const selected = () =>
		options()
			.find((option) => option.getAttribute('aria-selected') === 'true')
			?.textContent?.trim();
	/** The collapsed caret's box on screen. */
	const caret = () => {
		const range = window.getSelection()!.getRangeAt(0).cloneRange();
		range.collapse(false);
		const rects = range.getClientRects();
		return rects[rects.length - 1]!;
	};
	/** The editor's text, with the no-break space a contenteditable puts after a word as a space. */
	const text = () => (editor.textContent ?? '').replace(/\u00a0/g, ' ');
	return { editor, text, listbox, panel, options, selected, caret, emitted };
}

/**
 * The panel hangs from the caret: its left edge, 4px below its bottom. The
 * positioning engine rounds the panel to whole device pixels (the viewport
 * here is at 1x), so it lands within half a pixel of a fractional caret.
 */
function expectUnderCaret(box: DOMRect, caret: DOMRect) {
	expect(Math.abs(box.left - caret.left)).toBeLessThanOrEqual(0.5);
	expect(Math.abs(box.top - (caret.bottom + 4))).toBeLessThanOrEqual(0.5);
}

async function typeInto(editor: HTMLElement, text: string) {
	await userEvent.click(editor);
	await userEvent.keyboard(text);
}

describe('the Postbox saved-reply picker in a real browser', () => {
	it('opens under the caret and inserts the reply chosen with the arrow keys', async () => {
		const page = mountEditor();
		await typeInto(page.editor, 'Hi ;');

		expect(page.listbox()).not.toBeNull();
		expectUnderCaret(page.panel()!.getBoundingClientRect(), page.caret());
		expect(page.selected()).toContain('Thanks');

		await userEvent.keyboard('{ArrowDown}');
		expect(page.selected()).toContain('Signature');
		expect(document.activeElement).toBe(page.editor);

		await userEvent.keyboard('{Enter}');
		expect(page.listbox()).toBeNull();
		expect(page.text()).toBe('Hi Best, the Owlat team');
		expect(page.emitted.at(-1)).toContain('Best, the Owlat team');
		expect(document.activeElement).toBe(page.editor);
	});

	it('inserts a clicked reply without taking focus from the editor', async () => {
		const page = mountEditor();
		await typeInto(page.editor, ';');

		await userEvent.click(page.options()[0]!);
		expect(page.listbox()).toBeNull();
		expect(page.text()).toBe('Thanks for writing in.');
		expect(document.activeElement).toBe(page.editor);
	});

	it('closes on Escape and leaves the typed text as it was', async () => {
		const page = mountEditor();
		await typeInto(page.editor, ';sig');
		expect(page.options().map((option) => option.textContent?.trim())).toEqual(['Signature;sig']);

		await userEvent.keyboard('{Escape}');
		expect(page.listbox()).toBeNull();
		expect(page.text()).toBe(';sig');
		expect(document.activeElement).toBe(page.editor);
	});
});

describe('the Postbox emoji picker in a real browser', () => {
	it('keeps the arrow-selected emoji visible in its scrolling list and inserts it', async () => {
		const page = mountEditor();
		await typeInto(page.editor, 'Great :smi');

		const panel = page.panel()!;
		expectUnderCaret(panel.getBoundingClientRect(), page.caret());
		// The list is taller than its max height, so the last match starts out of view.
		expect(panel.scrollHeight).toBeGreaterThan(panel.clientHeight);
		expect(panel.scrollTop).toBe(0);

		// ArrowUp from the first match wraps to the last, which scrolls into view.
		await userEvent.keyboard('{ArrowUp}');
		const last = page.options().at(-1)!;
		expect(last.getAttribute('aria-selected')).toBe('true');
		const lastBox = last.getBoundingClientRect();
		const panelBox = panel.getBoundingClientRect();
		expect(lastBox.top).toBeGreaterThanOrEqual(panelBox.top);
		expect(lastBox.bottom).toBeLessThanOrEqual(panelBox.bottom);
		expect(document.activeElement).toBe(page.editor);

		const emoji = last.querySelector('span')!.textContent!.trim();
		await userEvent.keyboard('{Enter}');
		expect(page.listbox()).toBeNull();
		expect(page.text()).toBe(`Great ${emoji}`);
		expect(document.activeElement).toBe(page.editor);
	});

	it('closes on Escape and leaves the shortcode as typed', async () => {
		const page = mountEditor();
		await typeInto(page.editor, ':smi');
		expect(page.listbox()).not.toBeNull();

		await userEvent.keyboard('{Escape}');
		expect(page.listbox()).toBeNull();
		expect(page.text()).toBe(':smi');
		expect(document.activeElement).toBe(page.editor);
	});
});
