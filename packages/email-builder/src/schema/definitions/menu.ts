import type { BlockAttributeSchema } from '../types';
import { backgroundColorField, borderRadiusField, standardSharedGroups } from './_shared';

export const menuSchema: BlockAttributeSchema = {
	type: 'menu',
	label: 'Menu',
	groups: [
		{
			label: 'Links',
			fields: [
				{
					key: 'items',
					label: 'Menu Items',
					type: 'array',
					itemSchema: [
						{ key: 'label', label: 'Label', type: 'text' },
						{ key: 'url', label: 'URL', type: 'url' },
					],
					itemDefault: () => ({ label: 'Link', url: '#' }),
				},
			],
		},
		{
			label: 'Style',
			fields: [
				{ key: 'align', label: 'Alignment', type: 'align' },
				{ key: 'fontSize', label: 'Font Size', type: 'number', min: 10, max: 32, unit: 'px' },
				{ key: 'fontFamily', label: 'Font Family', type: 'fontFamily' },
				{
					key: 'fontWeight',
					label: 'Weight',
					type: 'select',
					options: [
						{ label: 'Normal', value: 400 },
						{ label: 'Bold', value: 700 },
					],
				},
				{ key: 'textColor', label: 'Text Color', type: 'color' },
				{
					key: 'textTransform',
					label: 'Transform',
					type: 'select',
					options: [
						{ label: 'None', value: 'none' },
						{ label: 'Uppercase', value: 'uppercase' },
						{ label: 'Lowercase', value: 'lowercase' },
						{ label: 'Capitalize', value: 'capitalize' },
					],
				},
				{ key: 'itemSpacing', label: 'Item Spacing', type: 'number', min: 0, max: 32, unit: 'px' },
				{ key: 'separator', label: 'Separator', type: 'text', placeholder: '|' },
				{ key: 'separatorColor', label: 'Separator Color', type: 'color' },
				{ key: 'hamburgerOnMobile', label: 'Hamburger on Mobile', type: 'toggle' },
				backgroundColorField,
				borderRadiusField,
			],
		},
		...standardSharedGroups,
	],
};
