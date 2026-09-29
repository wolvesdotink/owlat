// @vitest-environment happy-dom
//
// The builder emits `update:blocks` from one block-tree counter instead of a
// deep watcher. An edit the counter misses is an edit the host never saves, so
// these drive the real component through edits of each kind and check that
// every one reaches the host exactly once.
import { describe, it, expect, afterEach } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import EmailBuilder from '../EmailBuilder.vue';
import DocumentCanvas from '../canvas/DocumentCanvas.vue';
import { EmailBuilderHandlersKey } from '../../composables/useEmailBuilderHandlers';
import { createBlock } from '../../utils/blocks';
import { defaultTheme } from '../../defaults';
import type { ColumnsBlockContent, EditorBlock, TextBlockContent } from '../../types';

function text(id: string, html: string): EditorBlock {
	const block = createBlock('text', defaultTheme);
	block.id = id;
	(block.content as TextBlockContent).html = html;
	return block;
}

function columns(id: string): EditorBlock {
	const block = createBlock('columns', defaultTheme);
	block.id = id;
	return block;
}

let wrapper: VueWrapper | null = null;

async function mountBuilder(blocks: EditorBlock[]) {
	wrapper = mount(EmailBuilder, {
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
	await flushPromises();
	return wrapper;
}

const emits = (w: VueWrapper) => (w.emitted('update:blocks') ?? []) as [EditorBlock[]][];

afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
	document.body.innerHTML = '';
});

describe('EmailBuilder update:blocks', () => {
	it('does not emit for the blocks it was mounted with', async () => {
		const w = await mountBuilder([text('b-1', '<p>Hi</p>')]);
		expect(emits(w)).toHaveLength(0);
	});

	it('emits a property edit once', async () => {
		const w = await mountBuilder([text('b-1', '<p>Hi</p>')]);
		const canvas = w.findComponent(DocumentCanvas);
		canvas.vm.$emit('select', 'b-1');
		await flushPromises();

		w.findComponent({ name: 'UnifiedToolbar' }).vm.$emit('update', 'b-1', 'html', '<p>Edited</p>');
		await flushPromises();

		expect(emits(w)).toHaveLength(1);
		const [blocks] = emits(w)[0]!;
		expect((blocks[0]!.content as TextBlockContent).html).toBe('<p>Edited</p>');
	});

	it('emits an item added inside a columns block, which is an in-place edit', async () => {
		const w = await mountBuilder([columns('cols')]);
		const before = (columns('cols').content as ColumnsBlockContent).columns[0]!.length;
		w.findComponent(DocumentCanvas).vm.$emit('select', 'cols');
		await flushPromises();

		w.findComponent({ name: 'UnifiedToolbar' }).vm.$emit('add-child', 'cols', 'text');
		await flushPromises();

		expect(emits(w)).toHaveLength(1);
		const [blocks] = emits(w)[0]!;
		expect((blocks[0]!.content as ColumnsBlockContent).columns[0]).toHaveLength(before + 1);
	});

	it('emits a reorder handed back by the canvas', async () => {
		const w = await mountBuilder([text('b-1', '<p>One</p>'), text('b-2', '<p>Two</p>')]);
		const canvas = w.findComponent(DocumentCanvas);
		const current = canvas.props('blocks') as EditorBlock[];
		canvas.vm.$emit('update:blocks', [current[1], current[0]]);
		await flushPromises();

		expect(emits(w)).toHaveLength(1);
		expect(emits(w)[0]![0].map((b) => b.id)).toEqual(['b-2', 'b-1']);
	});
});
