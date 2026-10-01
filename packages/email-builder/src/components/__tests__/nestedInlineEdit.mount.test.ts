// @vitest-environment happy-dom
//
// Double-clicking a text Block opens the inline editor in place at any depth:
// inside a Container, a Hero, a Columns column, and composites nested in each
// other. Enter and the slash menu insert into the list that holds the edited
// Block, closing the editor commits to that nested Block as one undo step, and
// text inside a linked Block stays read-only.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { childBlockLists } from '@owlat/shared/blockTree';
import EmailBuilder from '../EmailBuilder.vue';
import InlineTextEditor from '../canvas/InlineTextEditor.vue';
import { EmailBuilderHandlersKey } from '../../composables/useEmailBuilderHandlers';
import { createBlock, createDefaultColumnItemContent } from '../../utils/blocks';
import { locateBlock } from '../../utils/blockTree';
import { parseStoredBlocks } from '../../utils/storedBlocks';
import { defaultTheme } from '../../defaults';
import { HISTORY_DEBOUNCE_MS } from '../../constants';
import type { BlockType, EditorBlock, SlashCommand, TextBlockContent } from '../../types';

function block(type: BlockType, id: string, patch: Record<string, unknown> = {}): EditorBlock {
	const created = createBlock(type, defaultTheme);
	return { ...created, id, content: { ...created.content, ...patch } } as EditorBlock;
}

const text = (id: string, html: string) => block('text', id, { html });

/**
 * box (container) → inBox (text), boxAfter (text)          one level down
 * banner (hero) → inHero (text)                             one level down
 * grid (columns) → [inColumn (text)], [right (text)]        one level down
 * outer (container)
 * └── inner (container) → deep (text)                       two levels down
 *     └── cols (columns) → [leaf (text)]                     three levels down
 */
const nestedDocument = (): EditorBlock[] => [
	block('container', 'box', {
		items: [text('inBox', '<p>Box</p>'), text('boxAfter', '<p>After</p>')],
	}),
	block('hero', 'banner', { items: [text('inHero', '<p>Hero</p>')] }),
	block('columns', 'grid', {
		columns: [[text('inColumn', '<p>Column</p>')], [text('right', '<p>Right</p>')]],
	}),
	block('container', 'outer', {
		items: [
			block('container', 'inner', {
				items: [
					text('deep', '<p>Deep</p>'),
					block('columns', 'cols', { columns: [[text('leaf', '<p>Leaf</p>')], []] }),
				],
			}),
		],
	}),
];

let wrapper: VueWrapper | null = null;

/** Let the lazily loaded nested previews mount. */
async function settle() {
	for (let i = 0; i < 5; i++) {
		await flushPromises();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

async function mountBuilder(blocks: EditorBlock[]) {
	wrapper = mount(EmailBuilder, {
		attachTo: document.body,
		props: { blocks, subject: 'Subject', name: 'Name', variables: [] },
		global: {
			provide: {
				[EmailBuilderHandlersKey as symbol]: {
					uploadImage: async () => ({ url: '', storageId: '' }),
				},
			},
			stubs: {
				EditorHeader: true,
				PreviewPanel: true,
				FloatingBlockSidebar: true,
				UnifiedToolbar: true,
			},
		},
	});
	await settle();
	return wrapper;
}

const lastDraft = (w: VueWrapper) => {
	const emitted = (w.emitted('update:blocks') ?? []) as [EditorBlock[]][];
	return emitted[emitted.length - 1]![0];
};
const find = (blocks: readonly EditorBlock[], id: string) => locateBlock(blocks, id)?.block ?? null;
const htmlOf = (blocks: readonly EditorBlock[], id: string) =>
	(find(blocks, id)?.content as TextBlockContent | undefined)?.html;
/** The ids of the list that holds `id`. */
const siblingIds = (blocks: readonly EditorBlock[], id: string) =>
	locateBlock(blocks, id)!.list.map((b) => b.id);
const siblingTypes = (blocks: readonly EditorBlock[], id: string) =>
	locateBlock(blocks, id)!.list.map((b) => b.type);

const itemEl = (w: VueWrapper, id: string) => w.find(`[data-block-id="${id}"]`);
const inlineEditorIn = (w: VueWrapper, id: string) =>
	w.find(`[data-block-id="${id}"] [data-inline-text]`);
const openEditor = (w: VueWrapper) => w.findComponent(InlineTextEditor);

/** Click then double-click, as a real double-click does. */
async function doubleClick(w: VueWrapper, id: string) {
	await itemEl(w, id).trigger('click');
	await settle();
	await itemEl(w, id).trigger('dblclick');
	await settle();
}

/** Type into the open inline editor, leaving the caret at the end. */
function typeInto(el: HTMLElement, html: string) {
	el.innerHTML = html;
	const range = document.createRange();
	range.selectNodeContents(el);
	range.collapse(false);
	const selection = window.getSelection()!;
	selection.removeAllRanges();
	selection.addRange(range);
}

const command = (id: string): SlashCommand => ({
	id,
	name: id,
	description: id,
	icon: null,
	category: 'text',
});

afterEach(() => {
	vi.useRealTimers();
	wrapper?.unmount();
	wrapper = null;
	document.body.innerHTML = '';
});

describe('EmailBuilder inline editing of nested text Blocks', () => {
	it.each([
		['a Container', 'inBox'],
		['a Hero', 'inHero'],
		['a Columns column', 'inColumn'],
		['a Container in a Container', 'deep'],
		['Columns in a Container in a Container', 'leaf'],
	])('opens the inline editor in place for text inside %s and saves to it', async (_, id) => {
		const w = await mountBuilder(nestedDocument());

		await doubleClick(w, id);
		const editor = inlineEditorIn(w, id);
		expect(editor.exists()).toBe(true);
		expect(w.findAll('[data-inline-text]')).toHaveLength(1);

		typeInto(editor.element as HTMLElement, '<p>Edited inline</p>');
		await editor.trigger('keydown', { key: 'Escape' });
		await settle();

		expect(inlineEditorIn(w, id).exists()).toBe(false);
		const draft = lastDraft(w);
		expect(htmlOf(draft, id)).toBe('<p>Edited inline</p>');
		// Only that Block changed.
		const before = nestedDocument();
		for (const other of ['inBox', 'inHero', 'inColumn', 'deep', 'leaf'].filter((o) => o !== id)) {
			expect(htmlOf(draft, other)).toBe(htmlOf(before, other));
		}

		// The stored JSON reloads the same.
		const reloaded = parseStoredBlocks(JSON.stringify(draft));
		expect(reloaded).toEqual(JSON.parse(JSON.stringify(draft)));
		expect(htmlOf(reloaded, id)).toBe('<p>Edited inline</p>');
	});

	it('commits the nested edit as one undo step', async () => {
		const w = await mountBuilder(nestedDocument());
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const commit = async () => {
			await nextTick();
			await nextTick();
			vi.advanceTimersByTime(HISTORY_DEBOUNCE_MS);
			await nextTick();
			await flushPromises();
		};

		await itemEl(w, 'deep').trigger('click');
		await commit();
		await itemEl(w, 'deep').trigger('dblclick');
		await commit();
		const editor = inlineEditorIn(w, 'deep');
		typeInto(editor.element as HTMLElement, '<p>First</p>');
		await editor.trigger('keydown', { key: 'Escape' });
		await commit();
		expect(htmlOf(lastDraft(w), 'deep')).toBe('<p>First</p>');

		w.findComponent({ name: 'EditorHeader' }).vm.$emit('undo');
		await commit();
		expect(htmlOf(lastDraft(w), 'deep')).toBe('<p>Deep</p>');

		w.findComponent({ name: 'EditorHeader' }).vm.$emit('redo');
		await commit();
		expect(htmlOf(lastDraft(w), 'deep')).toBe('<p>First</p>');
	});

	it.each([
		['a Container', 'inBox', ['inBox', '*', 'boxAfter']],
		['a Columns column', 'inColumn', ['inColumn', '*']],
		['a Container in a Container', 'deep', ['deep', '*', 'cols']],
	])(
		'Enter at the end of text in %s inserts a text Block right after it in the same list',
		async (_, id, expected) => {
			const w = await mountBuilder(nestedDocument());
			await doubleClick(w, id);
			const editor = inlineEditorIn(w, id);
			typeInto(editor.element as HTMLElement, '<p>Typed</p>');
			await editor.trigger('keydown', { key: 'Enter' });
			await settle();

			const draft = lastDraft(w);
			expect(htmlOf(draft, id)).toBe('<p>Typed</p>');
			const siblings = siblingIds(draft, id);
			const added = siblings[siblings.indexOf(id) + 1]!;
			expect(siblings).toEqual(expected.map((e) => (e === '*' ? added : e)));
			expect(find(draft, added)!.type).toBe('text');
			expect(htmlOf(draft, added)).toBe('');
			// The root list is untouched.
			expect(draft.map((b) => b.id)).toEqual(['box', 'banner', 'grid', 'outer']);

			// The editor moves on to the new Block, in place.
			expect(inlineEditorIn(w, added).exists()).toBe(true);
			expect(inlineEditorIn(w, id).exists()).toBe(false);
		}
	);

	it('gives a text Block inserted into a column the column defaults', async () => {
		const w = await mountBuilder(nestedDocument());
		await doubleClick(w, 'inColumn');
		const editor = inlineEditorIn(w, 'inColumn');
		typeInto(editor.element as HTMLElement, '<p>Typed</p>');
		await editor.trigger('keydown', { key: 'Enter' });
		await settle();

		const draft = lastDraft(w);
		const added = siblingIds(draft, 'inColumn')[1]!;
		// Column items take the compact column defaults, not the root ones.
		expect(find(draft, added)!.content).toEqual(
			createDefaultColumnItemContent('text', defaultTheme)
		);
	});

	it('removes a nested text Block left empty when the editor closes', async () => {
		const w = await mountBuilder(nestedDocument());
		await doubleClick(w, 'inBox');
		const editor = inlineEditorIn(w, 'inBox');
		typeInto(editor.element as HTMLElement, '');
		await editor.trigger('keydown', { key: 'Escape' });
		await settle();

		expect(siblingIds(lastDraft(w), 'boxAfter')).toEqual(['boxAfter']);
	});

	it('inserts a slash-command Block right after the nested source', async () => {
		const w = await mountBuilder(nestedDocument());
		await doubleClick(w, 'inBox');
		openEditor(w).vm.$emit('slash-command-select', command('button'));
		await settle();

		const draft = lastDraft(w);
		expect(siblingTypes(draft, 'inBox')).toEqual(['text', 'button', 'text']);
		expect(siblingIds(draft, 'inBox')[0]).toBe('inBox');
		expect(siblingIds(draft, 'inBox')[2]).toBe('boxAfter');
		expect(draft.map((b) => b.id)).toEqual(['box', 'banner', 'grid', 'outer']);
	});

	it('inserts a slash heading into a column two composites down', async () => {
		const w = await mountBuilder(nestedDocument());
		await doubleClick(w, 'leaf');
		openEditor(w).vm.$emit('slash-command-select', command('h2'));
		await settle();

		const draft = lastDraft(w);
		const column = siblingIds(draft, 'leaf');
		expect(column).toHaveLength(2);
		expect(column[0]).toBe('leaf');
		const heading = find(draft, column[1]!)!.content as TextBlockContent;
		expect(heading.blockType).toBe('h2');
	});

	it('puts a slash-command Block in place of a source the command left empty', async () => {
		const w = await mountBuilder(nestedDocument());
		await doubleClick(w, 'deep');
		// The slash text is removed before the command fires; nothing else was typed.
		typeInto(inlineEditorIn(w, 'deep').element as HTMLElement, '');
		openEditor(w).vm.$emit('slash-command-select', command('divider'));
		await settle();

		const draft = lastDraft(w);
		expect(find(draft, 'deep')).toBeNull();
		expect(childBlockLists(find(draft, 'inner')!)[0]!.map((b) => b.type)).toEqual([
			'divider',
			'columns',
		]);
	});

	it('places a Block the nested list does not accept after the nearest composite that does', async () => {
		const w = await mountBuilder(nestedDocument());
		await doubleClick(w, 'deep');
		// A list is not accepted inside a container, so it goes after the root.
		openEditor(w).vm.$emit('slash-command-select', command('list'));
		await settle();

		const draft = lastDraft(w);
		expect(draft.map((b) => b.type)).toEqual(['container', 'hero', 'columns', 'container', 'list']);
		expect(childBlockLists(find(draft, 'inner')!)[0]!.map((b) => b.id)).toEqual(['deep', 'cols']);
	});

	it('does not open the inline editor for text inside a linked Block', async () => {
		const [box, ...rest] = nestedDocument();
		const linked = {
			...box!,
			savedBlockRef: { blockId: 'saved-1', groupId: 'group-1', blockName: 'Header' },
		} as EditorBlock;
		const w = await mountBuilder([linked, ...rest]);

		await doubleClick(w, 'inBox');
		expect(w.find('[data-inline-text]').exists()).toBe(false);
		expect(w.emitted('update:blocks')).toBeUndefined();
	});
});

describe('EmailBuilder inline editing of root text Blocks', () => {
	const rootDocument = () => [text('first', '<p>First</p>'), text('second', '<p>Second</p>')];

	it('Enter inserts an empty text Block right after the root and keeps editing', async () => {
		const w = await mountBuilder(rootDocument());
		await doubleClick(w, 'first');
		const editor = inlineEditorIn(w, 'first');
		typeInto(editor.element as HTMLElement, '<p>Typed</p>');
		await editor.trigger('keydown', { key: 'Enter' });
		await settle();

		const draft = lastDraft(w);
		expect(draft).toHaveLength(3);
		expect(draft[0]!.id).toBe('first');
		expect(htmlOf(draft, 'first')).toBe('<p>Typed</p>');
		expect(htmlOf(draft, draft[1]!.id)).toBe('');
		expect(draft[2]!.id).toBe('second');
		expect(inlineEditorIn(w, draft[1]!.id).exists()).toBe(true);
	});

	it('puts a slash-command Block in place of a first root Block the command left empty', async () => {
		const w = await mountBuilder(rootDocument());
		await doubleClick(w, 'first');
		typeInto(inlineEditorIn(w, 'first').element as HTMLElement, '');
		openEditor(w).vm.$emit('slash-command-select', command('divider'));
		await settle();

		expect(lastDraft(w).map((b) => b.type)).toEqual(['divider', 'text']);
		expect(lastDraft(w)[1]!.id).toBe('second');
	});
});
