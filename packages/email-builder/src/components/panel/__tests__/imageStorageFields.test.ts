// @vitest-environment happy-dom

import { flushPromises, mount, shallowMount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { defaultTheme } from '../../../defaults';
import { EmailBuilderHandlersKey } from '../../../composables/useEmailBuilderHandlers';
import { imageSchema } from '../../../schema/definitions/image';
import type { EditorBlock, EmailBuilderHandlers, ImageBlockContent } from '../../../types';
import PropertyField from '../PropertyField.vue';
import ImageField from '../fields/ImageField.vue';

const imageBlock: EditorBlock = {
	id: 'image-1',
	type: 'image',
	content: {
		src: '',
		alt: '',
		width: 100,
		align: 'center',
	} as ImageBlockContent,
};

function actualImageProperty(key: 'src' | 'darkSrc') {
	const field = imageSchema.groups
		.flatMap((group) => group.fields)
		.find((item) => item.key === key);
	if (!field) throw new Error(`Missing ${key} image property`);
	return field;
}

describe('image property storage identity', () => {
	it('persists a library selection URL and storage ID through the real image field', async () => {
		const pickFromMediaLibrary = vi.fn();
		const handlers: EmailBuilderHandlers = {
			uploadImage: vi.fn(),
			pickFromMediaLibrary,
		};
		const wrapper = mount(ImageField, {
			props: { value: '' },
			global: {
				provide: {
					[EmailBuilderHandlersKey as symbol]: handlers,
				},
			},
		});

		await wrapper.get('button[title="Browse or upload images"]').trigger('click');
		const select = pickFromMediaLibrary.mock.calls[0]![0]!;
		select({
			url: 'https://capability.example/library-image',
			storageId: 'storage-library-1',
			mediaAssetId: 'asset-library-1',
		});
		await nextTick();

		expect(wrapper.emitted('select')).toEqual([
			[
				{
					url: 'https://capability.example/library-image',
					storageId: 'storage-library-1',
					mediaAssetId: 'asset-library-1',
				},
			],
		]);
		expect(wrapper.emitted('update')).toBeUndefined();
	});

	it('keeps storage identity in the direct-upload selection result', async () => {
		const file = new File(['image bytes'], 'photo.png', { type: 'image/png' });
		const uploadImage = vi.fn().mockResolvedValue({
			url: 'https://capability.example/uploaded-image',
			storageId: 'storage-upload-1',
			mediaAssetId: 'asset-upload-1',
		});
		const wrapper = mount(ImageField, {
			props: { value: '' },
			global: {
				provide: {
					[EmailBuilderHandlersKey as symbol]: { uploadImage },
				},
			},
		});
		const input = wrapper.get('input[type="file"]');
		Object.defineProperty(input.element, 'files', { value: [file] });

		await input.trigger('change');
		await flushPromises();

		expect(uploadImage).toHaveBeenCalledWith(file);
		expect(wrapper.emitted('select')).toEqual([
			[
				{
					url: 'https://capability.example/uploaded-image',
					storageId: 'storage-upload-1',
					mediaAssetId: 'asset-upload-1',
				},
			],
		]);
	});

	it.each([
		{
			sourceKey: 'src' as const,
			storageKey: 'storageId',
			assetKey: 'mediaAssetId',
			storageId: 'storage-primary-1',
		},
		{
			sourceKey: 'darkSrc' as const,
			storageKey: 'darkStorageId',
			assetKey: 'darkMediaAssetId',
			storageId: 'storage-dark-1',
		},
	])(
		'writes and clears $storageKey through the real $sourceKey property schema',
		async ({ sourceKey, storageKey, assetKey, storageId }) => {
			const wrapper = shallowMount(PropertyField, {
				props: {
					field: actualImageProperty(sourceKey),
					value: '',
					block: imageBlock,
					theme: defaultTheme,
				},
			});
			const imageField = wrapper.findComponent(ImageField);

			imageField.vm.$emit('select', {
				url: `https://capability.example/${sourceKey}`,
				storageId,
				mediaAssetId: `asset-${sourceKey}`,
			});
			await nextTick();

			expect(wrapper.emitted('update')).toEqual([[`https://capability.example/${sourceKey}`]]);
			expect(wrapper.emitted('update-keyed')).toEqual([
				[storageKey, storageId],
				[assetKey, `asset-${sourceKey}`],
			]);

			imageField.vm.$emit('update', `https://images.example/manual-${sourceKey}.png`);
			await nextTick();

			expect(wrapper.emitted('update')?.at(-1)).toEqual([
				`https://images.example/manual-${sourceKey}.png`,
			]);
			expect(wrapper.emitted('update-keyed')?.slice(-2)).toEqual([
				[storageKey, undefined],
				[assetKey, undefined],
			]);
		}
	);
});
