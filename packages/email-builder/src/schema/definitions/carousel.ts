import type { BlockAttributeSchema } from '../types';
import { backgroundColorField, borderRadiusField, standardSharedGroups } from './_shared';

export const carouselSchema: BlockAttributeSchema = {
	type: 'carousel',
	label: 'Carousel',
	groups: [
		{
			label: 'Images',
			fields: [
				{
					key: 'images',
					label: 'Images',
					type: 'array',
					itemSchema: [
						{ key: 'src', label: 'Image URL', type: 'url' },
						{ key: 'alt', label: 'Alt Text', type: 'text' },
						{ key: 'linkUrl', label: 'Link URL', type: 'url', placeholder: 'Optional link' },
						{ key: 'thumbnailSrc', label: 'Thumbnail URL', type: 'url', placeholder: 'Optional thumbnail' },
					],
					itemDefault: () => ({ src: '', alt: '', linkUrl: '', thumbnailSrc: '' }),
				},
			],
		},
		{
			label: 'Style',
			fields: [
				{ key: 'iconWidth', label: 'Nav Dot Size', type: 'number', min: 6, max: 24, unit: 'px' },
				{ key: 'iconColor', label: 'Active Dot Color', type: 'color' },
				{ key: 'iconInactiveColor', label: 'Inactive Dot Color', type: 'color' },
				{ key: 'thumbnailWidth', label: 'Thumbnail Strip Width', type: 'number', min: 0, max: 120, unit: 'px', helpText: '0 = hidden' },
				borderRadiusField,
				backgroundColorField,
			],
		},
		...standardSharedGroups,
	],
};
