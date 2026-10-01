// @vitest-environment happy-dom
//
// The children list in the property panel is two controls per row: "edit this
// child" and "remove this child". The row used to be a `role="button"` div
// wrapping the real Remove button — and a button makes every descendant
// presentational, so the Remove control was stripped from the accessibility
// tree: a screen-reader user could hear the row but never reach the one
// destructive action inside it.
//
// Both controls address a child Block by id. Accordion sections are not
// Blocks, so their rows show the label only: an Edit or Remove there had
// nothing to act on and silently did nothing.
import { describe, it, expect, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import NestedItemsEditor from '../NestedItemsEditor.vue';
import { defaultTheme } from '../../../defaults';
import '../../../blocks';
import type { EditorBlock, EmailTheme } from '../../../types';

const text = (id: string) => ({
	id,
	type: 'text',
	content: { html: '<p>Hi</p>', blockType: 'paragraph' },
});
const button = (id: string) => ({
	id,
	type: 'button',
	content: { text: 'Go', url: 'https://example.com' },
});

const container = (type: 'container' | 'hero'): EditorBlock =>
	({
		id: `${type}-1`,
		type,
		content: { items: [text('t1'), button('b1')] },
	}) as unknown as EditorBlock;

const columns = (): EditorBlock =>
	({
		id: 'cols-1',
		type: 'columns',
		content: { columns: [[text('t1')], [button('b1')]] },
	}) as unknown as EditorBlock;

const accordion = (): EditorBlock =>
	({
		id: 'acc-1',
		type: 'accordion',
		content: {
			sections: [
				{ id: 's1', title: 'Shipping', items: [text('t1')] },
				{ id: 's2', title: 'Returns', items: [] },
			],
		},
	}) as unknown as EditorBlock;

let wrapper: VueWrapper | null = null;

function mountEditor(block: EditorBlock) {
	wrapper = mount(NestedItemsEditor, {
		props: { block, theme: defaultTheme as Required<EmailTheme> },
	});
	return wrapper;
}

afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

describe('NestedItemsEditor rows', () => {
	it('exposes both row controls as real, separately reachable buttons', () => {
		const w = mountEditor(container('container'));

		expect(w.findAll('[role="button"]')).toHaveLength(0);

		const labels = w.findAll('button').map((b) => b.attributes('aria-label'));
		expect(labels).toEqual(['Edit Text', 'Remove Text', 'Edit Button', 'Remove Button']);
		// Neither control is nested inside the other.
		for (const control of w.findAll('button')) {
			expect(control.element.querySelector('button')).toBeNull();
		}
	});

	it.each([
		['container', () => container('container'), ['Text', 'Button']],
		['hero', () => container('hero'), ['Text', 'Button']],
		['columns', columns, ['Col 1: Text', 'Col 2: Button']],
	] as const)('selects and removes the %s child it names', async (_type, block, labels) => {
		const w = mountEditor(block());

		await w.get(`button[aria-label="Edit ${labels[0]}"]`).trigger('click');
		expect(w.emitted('select-child')?.at(-1)).toEqual(['t1']);

		await w.get(`button[aria-label="Remove ${labels[1]}"]`).trigger('click');
		expect(w.emitted('remove-child')?.at(-1)).toEqual(['b1']);
	});

	it('lists accordion sections by title without Edit or Remove controls', async () => {
		const w = mountEditor(accordion());

		expect(w.text()).toContain('Shipping');
		expect(w.text()).toContain('Returns');
		expect(w.findAll('button')).toHaveLength(0);
		expect(w.findAll('[role="button"]')).toHaveLength(0);

		for (const row of w.findAll('span')) await row.trigger('click');
		expect(w.emitted('select-child')).toBeUndefined();
		expect(w.emitted('remove-child')).toBeUndefined();
	});
});
