import type { BlockAttributeSchema } from '../types';
import { sharedGroupsNoBorderRadius } from './_shared';

export const heroSchema: BlockAttributeSchema = {
	type: 'hero',
	label: 'Hero',
	groups: [
		{
			label: 'Background',
			fields: [
				{ key: 'backgroundImage', label: 'Background Image', type: 'url', placeholder: 'https://' },
				{
					key: 'backgroundPosition',
					label: 'Position',
					type: 'select',
					options: [
						{ label: 'Top', value: 'top' },
						{ label: 'Center', value: 'center' },
						{ label: 'Bottom', value: 'bottom' },
					],
				},
				{
					key: 'backgroundSize',
					label: 'Size',
					type: 'select',
					options: [
						{ label: 'Cover', value: 'cover' },
						{ label: 'Contain', value: 'contain' },
					],
				},
				{ key: 'overlayColor', label: 'Overlay Color', type: 'color' },
				{ key: 'backgroundGradient', label: 'Gradient', type: 'gradient' },
			],
		},
		{
			label: 'Layout',
			fields: [
				{
					key: 'mode',
					label: 'Height Mode',
					type: 'select',
					options: [
						{ label: 'Fixed Height', value: 'fixed-height' },
						{ label: 'Fluid Height', value: 'fluid-height' },
					],
				},
				{ key: 'height', label: 'Height', type: 'number', min: 100, max: 800, unit: 'px', showWhen: { key: 'mode', value: 'fixed-height' } },
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
			],
		},
		...sharedGroupsNoBorderRadius,
	],
};
