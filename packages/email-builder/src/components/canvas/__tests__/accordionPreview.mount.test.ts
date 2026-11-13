// @vitest-environment happy-dom

/**
 * An accordion section on the canvas shows the Blocks it holds, and any
 * section can be opened there, not only the one the email starts with.
 */
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import AccordionPreview from '../previews/AccordionPreview.vue';
import { createBlock } from '../../../utils/blocks';
import { defaultTheme } from '../../../defaults';
import type { AccordionBlockContent, EditorBlock } from '../../../types';

function accordion(): EditorBlock {
	const block = createBlock('accordion', defaultTheme);
	const content = block.content as AccordionBlockContent;
	const text = createBlock('text', defaultTheme);
	(text.content as { html: string }).html = '<p>Shipping takes three days</p>';
	content.sections = [
		{ id: 's1', title: 'Shipping', items: [{ id: text.id, type: 'text', content: text.content }] },
		{ id: 's2', title: 'Returns', items: [] },
	] as AccordionBlockContent['sections'];
	content.initialExpanded = 0;
	return block;
}

describe('AccordionPreview', () => {
	it('renders the Blocks inside the open section', async () => {
		const w = mount(AccordionPreview, {
			props: { block: accordion(), theme: defaultTheme as never },
		});
		// The nested DocumentBlock is an async component (it imports this preview).
		await vi.dynamicImportSettled();
		await flushPromises();

		expect(w.text()).toContain('Shipping takes three days');
	});

	it('opens another section from its header and reports the state', async () => {
		const w = mount(AccordionPreview, {
			props: { block: accordion(), theme: defaultTheme as never },
		});
		const [first, second] = w.findAll('button');

		expect(first!.attributes('aria-expanded')).toBe('true');
		expect(second!.attributes('aria-expanded')).toBe('false');

		await second!.trigger('click');
		await flushPromises();

		expect(second!.attributes('aria-expanded')).toBe('true');
		expect(first!.attributes('aria-expanded')).toBe('false');
		expect(w.text()).not.toContain('Shipping takes three days');
	});
});
