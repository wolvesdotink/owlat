import type { BlockAttributeSchema } from '../types';
import { backgroundColorField, borderRadiusField, standardSharedGroups } from './_shared';

export const listSchema: BlockAttributeSchema = {
	type: 'list',
	label: 'List',
	groups: [
		{
			label: 'Items',
			fields: [
				{
					key: 'items',
					label: 'List Items',
					type: 'array',
					// `items` is a string[] — new items must be plain strings, not objects.
					itemType: 'string',
				},
			],
		},
		{
			label: 'Style',
			fields: [
				{
					key: 'listType',
					label: 'List Type',
					type: 'select',
					options: [
						{ label: 'Bullet', value: 'bullet' },
						{ label: 'Numbered', value: 'numbered' },
						{ label: 'Check', value: 'check' },
						{ label: 'Icon', value: 'icon' },
					],
				},
				{ key: 'bulletColor', label: 'Bullet Color', type: 'color' },
				{ key: 'bulletSize', label: 'Bullet Size', type: 'number', min: 8, max: 32, unit: 'px' },
				{ key: 'iconUrl', label: 'Custom Icon', type: 'url', showWhen: { key: 'listType', value: 'icon' } },
				{ key: 'fontSize', label: 'Font Size', type: 'number', min: 10, max: 32, unit: 'px' },
				{ key: 'textColor', label: 'Text Color', type: 'color' },
				{ key: 'itemSpacing', label: 'Item Spacing', type: 'number', min: 0, max: 24, unit: 'px' },
				backgroundColorField,
				borderRadiusField,
			],
		},
		...standardSharedGroups,
	],
};
