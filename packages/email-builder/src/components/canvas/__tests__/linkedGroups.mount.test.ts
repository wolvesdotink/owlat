// @vitest-environment happy-dom
//
// Linked (saved-block) groups on the canvas: one draggable list item per
// group at its first Block's position, a header naming the group on its first
// Block, one drag handle per group, and top/bottom borders on the first/last
// Block. The canvas answers these from one linked-block index (#922), shared
// by EmailBuilder when provided and built from its own props otherwise.
import { describe, it, expect, afterEach } from 'vitest';
import { computed, ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import DocumentCanvas from '../DocumentCanvas.vue';
import { defaultTheme } from '../../../defaults';
import { createBlock } from '../../../utils/blocks';
import {
	buildLinkedBlockIndex,
	LINKED_BLOCK_INDEX_KEY,
} from '../../../composables/useLinkedBlocks';
import type { EditorBlock, EmailTheme, TextBlockContent } from '../../../types';

function text(id: string, groupId?: string): EditorBlock {
	const block = createBlock('text', defaultTheme);
	block.id = id;
	(block.content as TextBlockContent).html = `<p>${id}</p>`;
	if (groupId)
		block.savedBlockRef = { groupId, blockId: `sb-${groupId}`, blockName: `Saved ${groupId}` };
	return block;
}

const blocks = () => [
	text('a', 'g1'),
	text('x'),
	text('b', 'g2'),
	text('c', 'g1'),
	text('d', 'g2'),
];

let wrapper: VueWrapper | null = null;
afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

function render(list: EditorBlock[], provide?: Record<symbol, unknown>) {
	wrapper = mount(DocumentCanvas, {
		props: { theme: defaultTheme as Required<EmailTheme>, blocks: list, selectedBlockId: null },
		global: provide ? { provide } : undefined,
	});
	const w = wrapper;
	return {
		items: w
			.findAll('[role="listitem"]')
			.map((li) => li.findAll('[data-block-id]').map((b) => b.attributes('data-block-id'))),
		headers: w.findAll('button[title="Detach"]').map((b) => b.attributes('aria-label')),
		cls: (id: string) => w.find(`[data-block-id="${id}"]`).classes(),
	};
}

describe.each([
	['own index', () => undefined],
	[
		'shared index',
		(list: EditorBlock[]) => ({
			[LINKED_BLOCK_INDEX_KEY]: computed(() => buildLinkedBlockIndex(list)),
		}),
	],
])('linked groups on the canvas (%s)', (_name, provideFor) => {
	it('groups members into one unit at the first member, in first-appearance order', () => {
		const list = blocks();
		const r = render(list, provideFor(list));
		expect(r.items).toEqual([['a', 'c'], ['x'], ['b', 'd']]);
		expect(r.headers).toEqual(['Detach Saved g1', 'Detach Saved g2']);
		expect(r.cls('a')).toContain('border-t-2');
		expect(r.cls('a')).not.toContain('border-b-2');
		expect(r.cls('c')).toContain('border-b-2');
		expect(r.cls('c')).not.toContain('border-t-2');
		expect(r.cls('x')).toContain('border-2');
		expect(wrapper!.findAll('.drag-handle')).toHaveLength(3);
	});
});

it('ignores a shared index built from a different array', async () => {
	const other = ref([text('q', 'g7')]);
	const r = render(blocks(), {
		[LINKED_BLOCK_INDEX_KEY]: computed(() => buildLinkedBlockIndex(other.value)),
	});
	expect(r.items).toEqual([['a', 'c'], ['x'], ['b', 'd']]);
});
