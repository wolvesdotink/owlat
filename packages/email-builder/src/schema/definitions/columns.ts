import type { BlockAttributeSchema } from '../types';
import { backgroundColorField, borderRadiusField, standardSharedGroups } from './_shared';

export const columnsSchema: BlockAttributeSchema = {
	type: 'columns',
	label: 'Columns',
	groups: [
		{
			label: 'Layout',
			fields: [
				{
					key: 'columnCount',
					label: 'Columns',
					type: 'select',
					toolbar: true,
					options: [
						{ label: '1', value: 1 },
						{ label: '2', value: 2 },
						{ label: '3', value: 3 },
						{ label: '4', value: 4 },
					],
				},
				{
					key: 'ratio',
					label: 'Ratio',
					type: 'select',
					options: [
						{ label: 'Equal', value: 'equal' },
						{ label: 'Left Wide', value: 'left-wide' },
						{ label: 'Right Wide', value: 'right-wide' },
						{ label: 'Left Narrow', value: 'left-narrow' },
						{ label: 'Right Narrow', value: 'right-narrow' },
					],
				},
				{ key: 'columnGap', label: 'Column Gap', type: 'number', min: 0, max: 40, unit: 'px' },
				{
					key: 'verticalAlign',
					label: 'Vertical Align',
					type: 'select',
					options: [
						{ label: 'Top', value: 'top' },
						{ label: 'Middle', value: 'middle' },
						{ label: 'Bottom', value: 'bottom' },
					],
				},
				{
					key: 'direction',
					label: 'Direction',
					type: 'select',
					options: [
						{ label: 'LTR', value: 'ltr' },
						{ label: 'RTL', value: 'rtl' },
					],
				},
			],
		},
		{
			label: 'Mobile',
			collapsed: true,
			fields: [
				{ key: 'mobileStacking', label: 'Stack on Mobile', type: 'toggle' },
				{
					key: 'mobileStackOrder',
					label: 'Mobile Stack Order',
					type: 'select',
					options: [
						{ label: 'Normal', value: 'normal' },
						{ label: 'Reverse', value: 'reverse' },
					],
					showWhen: { key: 'mobileStacking', value: true },
				},
			],
		},
		{
			label: 'Style',
			fields: [backgroundColorField, borderRadiusField],
		},
		...standardSharedGroups,
	],
};
