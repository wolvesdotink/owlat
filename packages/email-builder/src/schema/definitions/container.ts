import type { BlockAttributeSchema } from '../types';
import { spacingGroup, darkModeGroup, responsiveGroup } from './_shared';

export const containerSchema: BlockAttributeSchema = {
	type: 'container',
	label: 'Container',
	groups: [
		{
			label: 'Layout',
			fields: [
				{ key: 'maxWidth', label: 'Max Width', type: 'slider', min: 50, max: 100, unit: '%' },
			],
		},
		{
			label: 'Style',
			fields: [
				{ key: 'backgroundColor', label: 'Background Color', type: 'color' },
				{ key: 'backgroundImage', label: 'Background Image', type: 'url', placeholder: 'https://' },
				{
					key: 'backgroundPosition',
					label: 'Image Position',
					type: 'select',
					options: [
						{ label: 'Top', value: 'top' },
						{ label: 'Center', value: 'center' },
						{ label: 'Bottom', value: 'bottom' },
					],
					showWhen: { key: 'backgroundImage', value: true },
				},
				{
					key: 'backgroundSize',
					label: 'Image Size',
					type: 'select',
					options: [
						{ label: 'Cover', value: 'cover' },
						{ label: 'Contain', value: 'contain' },
					],
					showWhen: { key: 'backgroundImage', value: true },
				},
				{ key: 'backgroundGradient', label: 'Gradient', type: 'gradient' },
				{ key: 'borderRadius', label: 'Border Radius', type: 'number', min: 0, max: 50, unit: 'px' },
				{ key: 'borderWidth', label: 'Border Width', type: 'number', min: 0, max: 10, unit: 'px' },
				{ key: 'borderColor', label: 'Border Color', type: 'color' },
				{
					key: 'borderStyle',
					label: 'Border Style',
					type: 'select',
					options: [
						{ label: 'Solid', value: 'solid' },
						{ label: 'Dashed', value: 'dashed' },
						{ label: 'Dotted', value: 'dotted' },
						{ label: 'None', value: 'none' },
					],
				},
			],
		},
		spacingGroup,
		darkModeGroup,
		responsiveGroup,
	],
};
