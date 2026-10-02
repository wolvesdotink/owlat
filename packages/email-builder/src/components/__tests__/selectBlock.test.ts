// @vitest-environment happy-dom
//
// `selectBlock` is how a host points at a Block from outside the builder: the
// pre-send checks' "Show me" opens the editor on the Block a problem was found
// in. It has to select the right Block, scroll it into view and leave a
// preview for the canvas, and say so when the Block no longer exists.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import EmailBuilder from '../EmailBuilder.vue';
import { EmailBuilderHandlersKey } from '../../composables/useEmailBuilderHandlers';
import { createBlock } from '../../utils/blocks';
import { defaultTheme } from '../../defaults';
import type { EditorBlock, TextBlockContent } from '../../types';

function text(id: string, html: string): EditorBlock {
	const block = createBlock('text', defaultTheme);
	block.id = id;
	(block.content as TextBlockContent).html = html;
	return block;
}

let wrapper: VueWrapper | null = null;
const originalScrollIntoView = Element.prototype.scrollIntoView;

type Exposed = { selectBlock: (id: string) => boolean };

async function mountBuilder(blocks: EditorBlock[]) {
	wrapper = mount(EmailBuilder, {
		props: { blocks, subject: 'Subject', name: 'Name', variables: [] },
		global: {
			provide: {
				[EmailBuilderHandlersKey as symbol]: {
					uploadImage: async () => ({ url: '', storageId: '' }),
				},
			},
			stubs: { EditorHeader: true, PreviewPanel: true, FloatingBlockSidebar: true },
		},
		attachTo: document.body,
	});
	await flushPromises();
	return wrapper;
}

afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
	document.body.innerHTML = '';
	Element.prototype.scrollIntoView = originalScrollIntoView;
});

describe('EmailBuilder selectBlock', () => {
	it('selects the Block and scrolls it into view', async () => {
		const scrollIntoView = vi.fn();
		Element.prototype.scrollIntoView = scrollIntoView;
		const w = await mountBuilder([text('b-1', '<p>First</p>'), text('b-2', '<p>Second</p>')]);

		expect((w.vm as unknown as Exposed).selectBlock('b-2')).toBe(true);
		await flushPromises();

		const current = w.find('[aria-current="true"]');
		expect(current.exists()).toBe(true);
		expect(current.text()).toContain('Second');
		expect(scrollIntoView).toHaveBeenCalled();
	});

	it('answers false for a Block that is not on the canvas', async () => {
		const w = await mountBuilder([text('b-1', '<p>First</p>')]);

		expect((w.vm as unknown as Exposed).selectBlock('gone')).toBe(false);
		await flushPromises();

		expect(w.find('[aria-current="true"]').exists()).toBe(false);
	});
});
