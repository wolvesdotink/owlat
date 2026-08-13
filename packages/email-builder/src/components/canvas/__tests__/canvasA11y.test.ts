// @vitest-environment happy-dom
//
// Accessibility contract for the block canvas.
//
// The canvas used to be an unnamed pile of divs: no structure a screen reader
// could report ("list of 5 blocks, item 2 of 5"), no names on the blocks, and
// no way to move between them from the keyboard. It is now a list — one list
// item per draggable unit, each block inside it a named `group` with an
// accessible name of the form "<type label>: <content excerpt>", `aria-current`
// wired to the editor's existing selection model, a roving tabindex so the
// whole canvas is a single Tab stop, and focus that follows selection.
//
// It is deliberately NOT a listbox: a block owns real controls (drag handle,
// detach button, the inline text editor's contenteditable), and `option` — like
// `button` and `tab` — makes every descendant presentational, which would strip
// all of them from the accessibility tree.
//
// Alt+Arrow stays out of this file on purpose: that shortcut *moves* the
// selected block and is owned by the editor's global keydown routing
// (utils/editorKeyboard, covered by its own test). Here we only assert the
// canvas does not also steal it.
import { describe, it, expect, afterEach } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { Trash2 } from '@lucide/vue';
import DocumentCanvas from '../DocumentCanvas.vue';
import IconButton from '../../ui/IconButton.vue';
import { defaultTheme } from '../../../defaults';
import { createBlock } from '../../../utils/blocks';
import { blockAccessibleLabel } from '../../../utils/blockLabel';
import { getBlock, getRegisteredTypes } from '../../../registry';
import { EDITOR_SHORTCUTS } from '../../../composables/editorShortcuts';
import type {
	BlockType,
	ButtonBlockContent,
	EditorBlock,
	EmailTheme,
	TextBlockContent,
} from '../../../types';

function text(id: string, html: string): EditorBlock {
	const block = createBlock('text', defaultTheme);
	block.id = id;
	(block.content as TextBlockContent).html = html;
	return block;
}

function button(id: string, label: string): EditorBlock {
	const block = createBlock('button', defaultTheme);
	block.id = id;
	(block.content as ButtonBlockContent).text = label;
	return block;
}

const blocks = (): EditorBlock[] => [
	text('b-1', '<p>Welcome aboard</p>'),
	text('b-2', '<p>Second paragraph</p>'),
	button('b-3', 'Shop the sale'),
];

let wrapper: VueWrapper | null = null;

function mountCanvas(props: { blocks: EditorBlock[]; selectedBlockId: string | null }) {
	wrapper = mount(DocumentCanvas, {
		attachTo: document.body,
		props: { theme: defaultTheme as Required<EmailTheme>, ...props },
	});
	return wrapper;
}

afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
	document.body.innerHTML = '';
});

describe('canvas list semantics', () => {
	it('exposes the block list as a named list with one item per block', () => {
		const w = mountCanvas({ blocks: blocks(), selectedBlockId: null });

		const list = w.find('[role="list"]');
		expect(list.exists()).toBe(true);
		expect(list.attributes('aria-label')).toBe('Email blocks');

		const items = w.findAll('[role="listitem"]');
		expect(items).toHaveLength(3);
		// A list owns only list items — the hover-only insert points ride inside
		// an item rather than dangling between them.
		for (const item of items) {
			expect(item.element.parentElement).toBe(list.element);
		}
		expect(w.findAll('[role="group"]')).toHaveLength(3);
	});

	it('never uses a role that makes the block content presentational', () => {
		// `option`, `button` and `tab` strip every descendant from the a11y tree,
		// which would silently hide the drag handle, the detach button and the
		// inline text editor living inside each block.
		const w = mountCanvas({
			blocks: blocks(),
			selectedBlockId: 'b-1',
			inlineEditBlockId: 'b-1',
		} as never);

		for (const role of ['option', 'button', 'tab']) {
			expect(w.findAll(`[role="${role}"]`)).toHaveLength(0);
		}
		// The editable surface inside the block is exposed, not swallowed.
		const editable = w.find('[data-block-id="b-1"] [contenteditable="true"]');
		expect(editable.exists()).toBe(true);
		expect(editable.element.closest('[aria-hidden="true"]')).toBeNull();
	});

	it('names each block "<block type>: <content excerpt>"', () => {
		const w = mountCanvas({ blocks: blocks(), selectedBlockId: null });
		const labels = w.findAll('[role="group"]').map((o) => o.attributes('aria-label'));

		expect(labels).toEqual([
			'Text: Welcome aboard',
			'Text: Second paragraph',
			'Button: Shop the sale',
		]);
	});

	it('mirrors the selection model onto aria-current', async () => {
		const w = mountCanvas({ blocks: blocks(), selectedBlockId: 'b-2' });

		const currentStates = () =>
			w.findAll('[role="group"]').map((o) => o.attributes('aria-current'));
		expect(currentStates()).toEqual([undefined, 'true', undefined]);

		await w.setProps({ selectedBlockId: 'b-3' });
		expect(currentStates()).toEqual([undefined, undefined, 'true']);
	});

	it('keeps the canvas to a single Tab stop with a roving tabindex', async () => {
		const w = mountCanvas({ blocks: blocks(), selectedBlockId: null });
		const tabIndexes = () => w.findAll('[role="group"]').map((o) => o.attributes('tabindex'));

		// Nothing selected: the first block is the entry point.
		expect(tabIndexes()).toEqual(['0', '-1', '-1']);

		await w.setProps({ selectedBlockId: 'b-3' });
		expect(tabIndexes()).toEqual(['-1', '-1', '0']);
	});

	it('does not expose the hover-only insert points as list items or tab stops', () => {
		const w = mountCanvas({ blocks: blocks(), selectedBlockId: null });

		for (const insertPoint of w.findAll('[aria-hidden="true"]')) {
			expect(insertPoint.attributes('role')).toBeUndefined();
			for (const hidden of insertPoint.findAll('button')) {
				expect(hidden.attributes('tabindex')).toBe('-1');
			}
		}
	});
});

describe('canvas list keyboard navigation', () => {
	async function press(w: VueWrapper, key: string, modifiers: Record<string, boolean> = {}) {
		await w.find('[role="list"]').trigger('keydown', { key, ...modifiers });
	}

	it('moves the selection with the arrow keys, Home and End', async () => {
		const w = mountCanvas({ blocks: blocks(), selectedBlockId: 'b-1' });

		await press(w, 'ArrowDown');
		expect(w.emitted('select')?.at(-1)).toEqual(['b-2']);

		await w.setProps({ selectedBlockId: 'b-2' });
		await press(w, 'ArrowUp');
		expect(w.emitted('select')?.at(-1)).toEqual(['b-1']);

		await press(w, 'End');
		expect(w.emitted('select')?.at(-1)).toEqual(['b-3']);

		await w.setProps({ selectedBlockId: 'b-3' });
		await press(w, 'Home');
		expect(w.emitted('select')?.at(-1)).toEqual(['b-1']);
	});

	it('stops at the ends instead of wrapping', async () => {
		const w = mountCanvas({ blocks: blocks(), selectedBlockId: 'b-1' });

		await press(w, 'ArrowUp');
		expect(w.emitted('select')).toBeUndefined();

		await w.setProps({ selectedBlockId: 'b-3' });
		await press(w, 'ArrowDown');
		expect(w.emitted('select')).toBeUndefined();
	});

	it('is discoverable from the keyboard shortcuts help sheet', () => {
		const descriptions = EDITOR_SHORTCUTS.map((shortcut) => shortcut.description);
		expect(descriptions).toContain('Select the block above');
		expect(descriptions).toContain('Select the block below');
		// The move shortcut it shares the arrow keys with must stay listed too.
		expect(descriptions).toContain('Move selected block up');
	});

	it('leaves Alt+Arrow to the block-move shortcut', async () => {
		const w = mountCanvas({ blocks: blocks(), selectedBlockId: 'b-1' });

		await press(w, 'ArrowDown', { altKey: true });
		expect(w.emitted('select')).toBeUndefined();
	});

	it('ignores arrow keys typed inside an editable target', async () => {
		const w = mountCanvas({ blocks: blocks(), selectedBlockId: 'b-1' });

		// A real event from a real input: vue-test-utils cannot fake `target`, and
		// the guard is about where the keystroke originated, not where it lands.
		const input = document.createElement('input');
		w.find('[role="list"]').element.appendChild(input);
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		await flushPromises();

		expect(w.emitted('select')).toBeUndefined();
	});
});

describe('canvas focus tracks selection', () => {
	it('focuses the option that becomes selected', async () => {
		const w = mountCanvas({ blocks: blocks(), selectedBlockId: null });

		await w.setProps({ selectedBlockId: 'b-2' });
		await flushPromises();

		expect(document.activeElement).toBe(w.findAll('[role="group"]')[1]!.element);
	});

	it('leaves focus alone when the selection changes from outside the canvas', async () => {
		const w = mountCanvas({ blocks: blocks(), selectedBlockId: null });

		// Stand in for the floating toolbar / property panel, which live outside
		// the canvas subtree: changing the selection from there must not yank the
		// caret out of the control the user is operating.
		const outside = document.createElement('button');
		document.body.appendChild(outside);
		outside.focus();

		await w.setProps({ selectedBlockId: 'b-2' });
		await flushPromises();

		expect(document.activeElement).toBe(outside);
	});

	it('leaves focus to the inline text editor while it is open', async () => {
		const w = mountCanvas({
			blocks: blocks(),
			selectedBlockId: null,
			inlineEditBlockId: 'b-1',
		} as never);

		await w.setProps({ selectedBlockId: 'b-1' });
		await flushPromises();

		expect(document.activeElement).not.toBe(w.findAll('[role="group"]')[0]!.element);
	});
});

describe('icon-only controls carry a name', () => {
	// Every icon button in the builder's toolbars, popovers and property panel
	// goes through <IconButton>. Naming it there is what stops the "button,
	// button, button" readout the toolbars used to produce.
	it('falls back to the tooltip and lets callers override it', () => {
		const tooltipOnly = mount(IconButton, { props: { icon: Trash2, title: 'Remove' } });
		expect(tooltipOnly.attributes('aria-label')).toBe('Remove');

		const overridden = mount(IconButton, {
			props: { icon: Trash2, title: 'Remove', ariaLabel: 'Remove item 3' },
		});
		expect(overridden.attributes('aria-label')).toBe('Remove item 3');

		tooltipOnly.unmount();
		overridden.unmount();
	});

	it('accepts the override written as a plain aria-label attribute', () => {
		const w = mount(IconButton, {
			props: { icon: Trash2, title: 'Remove' },
			attrs: { 'aria-label': 'Remove stop 2' },
		});
		expect(w.attributes('aria-label')).toBe('Remove stop 2');
		w.unmount();
	});
});

describe('block accessible names', () => {
	it('gives every registered block type a non-empty name led by its type label', () => {
		for (const type of getRegisteredTypes()) {
			const block = createBlock(type as BlockType, defaultTheme);
			const label = blockAccessibleLabel(block);
			const typeLabel = getBlock(type as BlockType)?.label ?? type;

			expect(label.startsWith(typeLabel)).toBe(true);
			expect(label).not.toContain('[object Object]');
			expect(label).not.toContain('undefined');
		}
	});

	it('excerpts text content rather than markup, and truncates long copy', () => {
		expect(blockAccessibleLabel(text('b', '<p><strong>Hello</strong> world</p>'))).toBe(
			'Text: Hello world'
		);
		expect(blockAccessibleLabel(text('b', ''))).toBe('Text: empty');

		const long = blockAccessibleLabel(text('b', `<p>${'a'.repeat(200)}</p>`));
		expect(long.endsWith('…')).toBe(true);
		expect(long.length).toBeLessThan(80);
	});
});
