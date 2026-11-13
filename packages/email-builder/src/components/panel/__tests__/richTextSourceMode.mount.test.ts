// @vitest-environment happy-dom

/**
 * Leaving HTML source mode mounts a fresh contenteditable. It has to show the
 * content again, including an edit made in the source view, rather than a
 * blank editor whose next keystroke would replace the original text.
 */
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { describe, expect, it } from 'vitest';
import RichTextEditor from '../RichTextEditor.vue';

const sourceButton = (w: ReturnType<typeof mount>) => w.get('button[aria-pressed]');

describe('RichTextEditor source mode', () => {
	it('fills the visual editor again after a round trip through source mode', async () => {
		const w = mount(RichTextEditor, { props: { value: '<p>Hello <strong>there</strong></p>' } });
		expect(w.get('[contenteditable]').element.innerHTML).toContain('there');

		await sourceButton(w).trigger('click');
		await sourceButton(w).trigger('click');
		await nextTick();

		expect(w.get('[contenteditable]').element.innerHTML).toContain('<strong>there</strong>');
	});

	it('shows an edit made in the source view once back in the visual editor', async () => {
		const w = mount(RichTextEditor, { props: { value: '<p>Before</p>' } });

		await sourceButton(w).trigger('click');
		await w.get('textarea').setValue('<p>After</p>');
		const emitted = w.emitted('update')!.at(-1)![0] as string;
		await w.setProps({ value: emitted });

		await sourceButton(w).trigger('click');
		await nextTick();

		expect(w.get('[contenteditable]').element.innerHTML).toContain('After');
		expect(w.get('[contenteditable]').element.innerHTML).not.toContain('Before');
	});
});
