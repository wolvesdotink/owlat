import type { BlockAttributeSchema } from '../types';
import { backgroundColorField, standardSharedGroups } from './_shared';

export const dividerSchema: BlockAttributeSchema = {
	type: 'divider',
	label: 'Divider',
	groups: [
		{
			label: 'Style',
			fields: [
				{ key: 'color', label: 'Color', type: 'color' },
				{ key: 'thickness', label: 'Thickness', type: 'number', min: 1, max: 20, unit: 'px' },
				{ key: 'width', label: 'Width', type: 'slider', min: 10, max: 100, unit: '%' },
				{
					key: 'style',
					label: 'Style',
					type: 'select',
					options: [
						{ label: 'Solid', value: 'solid' },
						{ label: 'Dashed', value: 'dashed' },
						{ label: 'Dotted', value: 'dotted' },
					],
				},
				{ key: 'align', label: 'Alignment', type: 'align', toolbar: true },
			],
		},
		{
			label: 'Layout',
			fields: [backgroundColorField],
		},
		...standardSharedGroups,
	],
};
