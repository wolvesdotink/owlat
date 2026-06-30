import type { BlockAttributeSchema } from '../types';
import { backgroundColorField, borderRadiusField, standardSharedGroups } from './_shared';

export const imageSchema: BlockAttributeSchema = {
	type: 'image',
	label: 'Image',
	groups: [
		{
			label: 'Content',
			fields: [
				{ key: 'src', label: 'Image', type: 'image' },
				{ key: 'alt', label: 'Alt Text', type: 'text', placeholder: 'Describe the image' },
				{ key: 'title', label: 'Title', type: 'text', placeholder: 'Tooltip text' },
				{ key: 'linkUrl', label: 'Link URL', type: 'url', placeholder: 'https://' },
			],
		},
		{
			label: 'Layout',
			fields: [
				{ key: 'width', label: 'Width', type: 'slider', min: 10, max: 100, unit: '%', toolbar: true },
				{ key: 'height', label: 'Height', type: 'number', min: 0, max: 1000, unit: 'px', helpText: 'Leave 0 for auto' },
				{ key: 'align', label: 'Alignment', type: 'align', toolbar: true },
				{ key: 'fluidOnMobile', label: 'Full Width on Mobile', type: 'toggle' },
				backgroundColorField,
				borderRadiusField,
			],
		},
		{
			label: 'Retina / Dark',
			collapsed: true,
			fields: [
				{ key: 'srcset', label: 'Srcset', type: 'text', placeholder: 'image@2x.png 2x' },
				{ key: 'sizes', label: 'Sizes', type: 'text', placeholder: '(max-width: 600px) 100vw' },
				{ key: 'darkSrc', label: 'Dark Mode Image', type: 'image' },
			],
		},
		...standardSharedGroups,
	],
};
