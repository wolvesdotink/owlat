// @vitest-environment happy-dom
//
// The children list in the property panel is two controls per row: "edit this
// child" and "remove this child". The row used to be a `role="button"` div
// wrapping the real Remove button — and a button makes every descendant
// presentational, so the Remove control was stripped from the accessibility
// tree: a screen-reader user could hear the row but never reach the one
// destructive action inside it.
import { describe, it, expect, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import NestedItemsEditor from '../NestedItemsEditor.vue';
import { defaultTheme } from '../../../defaults';
import '../../../blocks';
import type { EditorBlock, EmailTheme } from '../../../types';

const accordion = (): EditorBlock =>
	({
		id: 'acc-1',
		type: 'accordion',
		content: {
			sections: [
				{ id: 's1', title: 'Shipping', content: '<p>…</p>' },
				{ id: 's2', title: 'Returns', content: '<p>…</p>' },
			],
		},
	}) as unknown as EditorBlock;

let wrapper: VueWrapper | null = null;

function mountEditor() {
	wrapper = mount(NestedItemsEditor, {
		props: { block: accordion(), theme: defaultTheme as Required<EmailTheme> },
	});
	return wrapper;
}

afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

describe('NestedItemsEditor rows', () => {
	it('exposes both row controls as real, separately reachable buttons', () => {
		const w = mountEditor();

		expect(w.findAll('[role="button"]')).toHaveLength(0);

		const labels = w.findAll('button').map((b) => b.attributes('aria-label'));
		expect(labels).toEqual(['Edit Shipping', 'Remove Shipping', 'Edit Returns', 'Remove Returns']);
		// Neither control is nested inside the other.
		for (const button of w.findAll('button')) {
			expect(button.element.querySelector('button')).toBeNull();
		}
	});

	it('still selects and removes the child it names', async () => {
		const w = mountEditor();
		const buttons = w.findAll('button');

		await buttons[0]!.trigger('click');
		expect(w.emitted('select-child')?.at(-1)).toEqual(['s1']);

		await buttons[3]!.trigger('click');
		expect(w.emitted('remove-child')?.at(-1)).toEqual(['s2']);
	});
});
