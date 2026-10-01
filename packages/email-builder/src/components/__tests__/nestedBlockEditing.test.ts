// @vitest-environment happy-dom
//
// Container nesting is offered by the Block registry, so every editor command
// has to reach a Block at any depth: selecting it on the canvas or from the
// child panel, editing its properties, adding, removing, duplicating and
// deleting children. These drive the real component two and three levels down
// and check that the emitted draft, the rendered preview and a reload agree.
//
// Duplicating a composite must also give every descendant a fresh id, so an
// edit to one copy never reaches the other, through undo and redo too.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { childBlockLists } from '@owlat/shared/blockTree';
import { renderEmailHtml } from '@owlat/email-renderer';
import EmailBuilder from '../EmailBuilder.vue';
import { EmailBuilderHandlersKey } from '../../composables/useEmailBuilderHandlers';
import { createBlock } from '../../utils/blocks';
import { locateBlock } from '../../utils/blockTree';
import { parseStoredBlocks } from '../../utils/storedBlocks';
import { defaultTheme } from '../../defaults';
import { HISTORY_DEBOUNCE_MS } from '../../constants';
import type { BlockType, EditorBlock, TextBlockContent } from '../../types';

function block(type: BlockType, id: string, patch: Record<string, unknown> = {}): EditorBlock {
	const created = createBlock(type, defaultTheme);
	return { ...created, id, content: { ...created.content, ...patch } } as EditorBlock;
}

const text = (id: string, html: string) => block('text', id, { html });

/**
 * outer (container)
 * ├── inner (container) → deep (text)            two levels down
 * └── middle (container) → cols (columns) → leaf three levels down
 */
const nestedDocument = (): EditorBlock[] => [
	block('container', 'outer', {
		items: [
			block('container', 'inner', { items: [text('deep', '<p>Deep</p>')] }),
			block('container', 'middle', {
				items: [block('columns', 'cols', { columns: [[text('leaf', '<p>Leaf</p>')], []] })],
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

const toolbar = (w: VueWrapper) => w.findComponent({ name: 'UnifiedToolbar' });
const toolbarBlockId = (w: VueWrapper) =>
	toolbar(w).exists() ? (toolbar(w).props('block') as EditorBlock).id : null;
const lastDraft = (w: VueWrapper) => {
	const emitted = (w.emitted('update:blocks') ?? []) as [EditorBlock[]][];
	return emitted[emitted.length - 1]![0];
};
const find = (blocks: readonly EditorBlock[], id: string) => locateBlock(blocks, id)?.block ?? null;
const allIds = (blocks: readonly EditorBlock[]): string[] =>
	blocks.flatMap((b) => [b.id, ...allIds(childBlockLists(b).flat())]);

async function clickItem(w: VueWrapper, id: string, nth = 0) {
	await w.findAll(`[data-block-id="${id}"]`)[nth]!.trigger('click');
	await settle();
}

afterEach(() => {
	vi.useRealTimers();
	wrapper?.unmount();
	wrapper = null;
	document.body.innerHTML = '';
});

describe('EmailBuilder nested editing', () => {
	it('selects a text two levels down on the canvas and edits it from the toolbar', async () => {
		const w = await mountBuilder(nestedDocument());

		await clickItem(w, 'deep');
		expect(toolbarBlockId(w)).toBe('deep');

		toolbar(w).vm.$emit('update', 'deep', 'textColor', '#ab1234');
		await settle();

		const draft = lastDraft(w);
		expect((find(draft, 'deep')!.content as TextBlockContent).textColor).toBe('#ab1234');
		// The sibling subtree is untouched.
		expect((find(draft, 'leaf')!.content as TextBlockContent).html).toBe('<p>Leaf</p>');
		// The preview renders what the draft holds.
		expect(renderEmailHtml(draft).toLowerCase()).toContain('#ab1234');

		// Save and reload: the stored JSON round-trips, and the reloaded document
		// can be edited at the same depth.
		const reloaded = parseStoredBlocks(JSON.stringify(draft));
		expect(reloaded).toEqual(JSON.parse(JSON.stringify(draft)));
		wrapper!.unmount();
		const again = await mountBuilder(reloaded);
		await clickItem(again, 'deep');
		toolbar(again).vm.$emit('update', 'deep', 'html', '<p>Reloaded</p>');
		await settle();
		const second = lastDraft(again);
		expect((find(second, 'deep')!.content as TextBlockContent).html).toBe('<p>Reloaded</p>');
		expect((find(second, 'deep')!.content as TextBlockContent).textColor).toBe('#ab1234');
	});

	it('adds, selects and removes children of a container nested in a container', async () => {
		const w = await mountBuilder(nestedDocument());

		await clickItem(w, 'inner');
		expect(toolbarBlockId(w)).toBe('inner');

		toolbar(w).vm.$emit('add-child', 'inner', 'button');
		await settle();
		const added = childBlockLists(find(lastDraft(w), 'inner')!)[0]!;
		expect(added.map((c) => c.type)).toEqual(['text', 'button']);

		// "Edit child" in the panel selects the child and keeps the toolbar.
		toolbar(w).vm.$emit('select-child', 'inner', added[1]!.id);
		await settle();
		expect(toolbarBlockId(w)).toBe(added[1]!.id);

		toolbar(w).vm.$emit('remove-child', 'inner', 'deep');
		await settle();
		expect(find(lastDraft(w), 'deep')).toBeNull();
		expect(childBlockLists(find(lastDraft(w), 'inner')!)[0]).toHaveLength(1);
	});

	it('edits a columns block three levels down and the column item inside it', async () => {
		const w = await mountBuilder(nestedDocument());

		await clickItem(w, 'cols');
		expect(toolbarBlockId(w)).toBe('cols');
		toolbar(w).vm.$emit('add-child', 'cols', 'text');
		await settle();
		const firstColumn = childBlockLists(find(lastDraft(w), 'cols')!)[0]!;
		expect(firstColumn).toHaveLength(2);

		await clickItem(w, 'leaf');
		expect(toolbarBlockId(w)).toBe('leaf');
		toolbar(w).vm.$emit('duplicate');
		await settle();
		const afterDuplicate = childBlockLists(find(lastDraft(w), 'cols')!)[0]!;
		expect(afterDuplicate).toHaveLength(3);
		expect(new Set(allIds(lastDraft(w))).size).toBe(allIds(lastDraft(w)).length);

		await clickItem(w, 'leaf');
		toolbar(w).vm.$emit('delete');
		await settle();
		expect(find(lastDraft(w), 'leaf')).toBeNull();
		expect(childBlockLists(find(lastDraft(w), 'cols')!)[0]).toHaveLength(2);
	});

	it('treats a linked Block as a whole: a child click selects the root, and nested edits are refused', async () => {
		const [outer] = nestedDocument();
		const linked = {
			...outer!,
			savedBlockRef: { blockId: 'saved-1', groupId: 'group-1', blockName: 'Header' },
		} as EditorBlock;
		const w = await mountBuilder([linked]);

		await clickItem(w, 'deep');
		expect(toolbarBlockId(w)).toBe('outer');

		toolbar(w).vm.$emit('update', 'deep', 'textColor', '#ab1234');
		toolbar(w).vm.$emit('add-child', 'inner', 'button');
		toolbar(w).vm.$emit('remove-child', 'inner', 'deep');
		await settle();
		expect(w.emitted('update:blocks')).toBeUndefined();
	});
});

describe('EmailBuilder duplication', () => {
	it('keeps two copies of a columns block independent through undo and redo', async () => {
		const original = block('columns', 'cols', {
			columns: [[text('child', '<p>Hi</p>')], []],
		});
		const w = await mountBuilder([original]);
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const commit = async () => {
			await nextTick();
			await nextTick();
			vi.advanceTimersByTime(HISTORY_DEBOUNCE_MS);
			await nextTick();
			await flushPromises();
		};

		await w.find('[data-block-id="cols"]').trigger('click');
		await commit();
		toolbar(w).vm.$emit('duplicate');
		await commit();

		const duplicated = lastDraft(w);
		expect(duplicated).toHaveLength(2);
		const ids = allIds(duplicated);
		expect(new Set(ids).size).toBe(ids.length);
		const copyChildId = childBlockLists(duplicated[1]!)[0]![0]!.id;
		expect(copyChildId).not.toBe('child');

		// Edit the copy's child: the original's child keeps its color.
		await w.findAll(`[data-block-id="${copyChildId}"]`)[0]!.trigger('click');
		await commit();
		expect(toolbarBlockId(w)).toBe(copyChildId);
		toolbar(w).vm.$emit('update', copyChildId, 'textColor', '#ab1234');
		await commit();

		const colorOf = (blocks: readonly EditorBlock[], id: string) =>
			(find(blocks, id)!.content as TextBlockContent).textColor;
		const edited = lastDraft(w);
		expect(colorOf(edited, copyChildId)).toBe('#ab1234');
		expect(colorOf(edited, 'child')).not.toBe('#ab1234');

		w.findComponent({ name: 'EditorHeader' }).vm.$emit('undo');
		await commit();
		expect(colorOf(lastDraft(w), copyChildId)).not.toBe('#ab1234');
		expect(colorOf(lastDraft(w), 'child')).not.toBe('#ab1234');

		w.findComponent({ name: 'EditorHeader' }).vm.$emit('redo');
		await commit();
		const redone = lastDraft(w);
		expect(colorOf(redone, copyChildId)).toBe('#ab1234');
		expect(colorOf(redone, 'child')).not.toBe('#ab1234');
		expect(new Set(allIds(redone)).size).toBe(allIds(redone).length);
	});
});
