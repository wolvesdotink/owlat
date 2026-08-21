// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { defaultTheme } from '../../../defaults';
import { imageSchema } from '../../../schema/definitions/image';
import type { EditorBlock, ImageBlockContent } from '../../../types';
import PropertyField from '../PropertyField.vue';

function altField() {
	const field = imageSchema.groups
		.flatMap((group) => group.fields)
		.find((item) => item.key === 'alt');
	if (!field) throw new Error('Missing alt property in the image schema');
	return field;
}

function block(content: Partial<ImageBlockContent>): EditorBlock {
	return {
		id: 'image-1',
		type: 'image',
		content: {
			src: 'https://example.com/a.png',
			alt: '',
			width: 100,
			align: 'center',
			...content,
		} as ImageBlockContent,
	};
}

function mountAltField(content: Partial<ImageBlockContent>) {
	const editorBlock = block(content);
	return mount(PropertyField, {
		props: {
			field: altField(),
			value: (editorBlock.content as ImageBlockContent).alt,
			block: editorBlock,
			theme: defaultTheme as never,
		},
	});
}

const NUDGE_TEXT = 'Missing alt text — screen readers will skip this image';

describe('image alt text nudge', () => {
	it('uses the nudge-capable field type for the image alt property', () => {
		expect(altField().type).toBe('altText');
	});

	it('warns when alt is empty and the image is not decorative', () => {
		const wrapper = mountAltField({ alt: '' });
		expect(wrapper.text()).toContain(NUDGE_TEXT);
	});

	it('stays quiet once alt text is filled in', () => {
		const wrapper = mountAltField({ alt: 'Company logo' });
		expect(wrapper.text()).not.toContain(NUDGE_TEXT);
	});

	it('stays quiet for an image explicitly marked decorative', () => {
		const wrapper = mountAltField({ alt: '', decorative: true });
		expect(wrapper.text()).not.toContain(NUDGE_TEXT);
	});

	it('focuses the alt input from the "Add alt text" action', async () => {
		const wrapper = mountAltField({ alt: '' });
		document.body.appendChild(wrapper.element as HTMLElement);

		const action = wrapper.findAll('button').find((b) => b.text() === 'Add alt text');
		expect(action).toBeDefined();
		await action!.trigger('click');

		expect(document.activeElement).toBe(wrapper.find('input').element);
		wrapper.unmount();
	});

	it('writes the decorative flag from the "Mark decorative" action', async () => {
		const wrapper = mountAltField({ alt: '' });
		const action = wrapper.findAll('button').find((b) => b.text() === 'Mark decorative');
		expect(action).toBeDefined();
		await action!.trigger('click');

		expect(wrapper.emitted('update-keyed')).toEqual([['decorative', true]]);
		// The alt value itself is untouched — decorative is the intent marker.
		expect(wrapper.emitted('update')).toBeUndefined();
	});

	it('still edits the alt value through the input', async () => {
		const wrapper = mountAltField({ alt: '' });
		await wrapper.find('input').setValue('A red bicycle');
		expect(wrapper.emitted('update')).toEqual([['A red bicycle']]);
	});

	it('exposes a decorative toggle in the image schema so it can be turned off again', () => {
		const decorativeField = imageSchema.groups
			.flatMap((group) => group.fields)
			.find((item) => item.key === 'decorative');
		expect(decorativeField?.type).toBe('toggle');
	});
});
