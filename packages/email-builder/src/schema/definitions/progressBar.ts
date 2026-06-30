import type { BlockAttributeSchema } from '../types';
import { backgroundColorField, sharedGroupsNoBorderRadius } from './_shared';

export const progressBarSchema: BlockAttributeSchema = {
	type: 'progressBar',
	label: 'Progress Bar',
	groups: [
		{
			label: 'Content',
			fields: [
				{ key: 'value', label: 'Value', type: 'slider', min: 0, max: 100 },
				{ key: 'maxValue', label: 'Max Value', type: 'number', min: 1, max: 1000 },
			],
		},
		{
			label: 'Style',
			fields: [
				{ key: 'barColor', label: 'Bar Color', type: 'color' },
				{ key: 'trackColor', label: 'Track Color', type: 'color' },
				{ key: 'height', label: 'Height', type: 'number', min: 4, max: 60, unit: 'px' },
				{ key: 'borderRadius', label: 'Border Radius', type: 'number', min: 0, max: 30, unit: 'px' },
				backgroundColorField,
			],
		},
		{
			label: 'Label',
			collapsed: true,
			fields: [
				{ key: 'showLabel', label: 'Show Label', type: 'toggle' },
				{
					key: 'labelPosition',
					label: 'Position',
					type: 'select',
					options: [
						{ label: 'Inside', value: 'inside' },
						{ label: 'Right', value: 'right' },
					],
					showWhen: { key: 'showLabel', value: true },
				},
				{ key: 'labelColor', label: 'Color', type: 'color', showWhen: { key: 'showLabel', value: true } },
				{ key: 'labelFontSize', label: 'Font Size', type: 'number', min: 8, max: 24, unit: 'px', showWhen: { key: 'showLabel', value: true } },
			],
		},
		...sharedGroupsNoBorderRadius,
	],
};
