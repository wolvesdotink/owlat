import type { BlockAttributeSchema } from '../types';
import { standardSharedGroups } from './_shared';

export const buttonSchema: BlockAttributeSchema = {
	type: 'button',
	label: 'Button',
	groups: [
		{
			label: 'Content',
			fields: [
				{ key: 'text', label: 'Button Text', type: 'text' },
				{ key: 'url', label: 'Link URL', type: 'url', placeholder: 'https://' },
				{
					key: 'target',
					label: 'Open In',
					type: 'select',
					options: [
						{ label: 'New Tab', value: '_blank' },
						{ label: 'Same Tab', value: '_self' },
					],
				},
			],
		},
		{
			label: 'Style',
			fields: [
				{ key: 'backgroundColor', label: 'Button Color', type: 'color' },
				{ key: 'textColor', label: 'Text Color', type: 'color' },
				{ key: 'backgroundGradient', label: 'Gradient', type: 'gradient' },
				{ key: 'borderRadius', label: 'Border Radius', type: 'number', min: 0, max: 50, unit: 'px' },
				{ key: 'paddingX', label: 'Horizontal Padding', type: 'number', min: 0, max: 60, unit: 'px' },
				{ key: 'paddingY', label: 'Vertical Padding', type: 'number', min: 0, max: 40, unit: 'px' },
				{ key: 'buttonWidth', label: 'Button Width', type: 'text', placeholder: 'auto' },
			],
		},
		{
			label: 'Typography',
			collapsed: true,
			fields: [
				{ key: 'fontFamily', label: 'Font Family', type: 'fontFamily' },
				{ key: 'fontSize', label: 'Font Size', type: 'number', min: 10, max: 48, unit: 'px' },
				{
					key: 'fontWeight',
					label: 'Weight',
					type: 'select',
					options: [
						{ label: 'Normal', value: 400 },
						{ label: 'Bold', value: 700 },
					],
				},
				{ key: 'letterSpacing', label: 'Letter Spacing', type: 'number', min: -2, max: 10, unit: 'px' },
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
			],
		},
		{
			label: 'Button Border',
			collapsed: true,
			fields: [
				{ key: 'buttonBorderWidth', label: 'Width', type: 'number', min: 0, max: 10, unit: 'px' },
				{ key: 'buttonBorderColor', label: 'Color', type: 'color' },
				{
					key: 'buttonBorderStyle',
					label: 'Style',
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
		{
			label: 'Layout',
			fields: [
				{ key: 'align', label: 'Alignment', type: 'align', alignOptions: ['left', 'center', 'right', 'full'], toolbar: true },
				{ key: 'blockBackgroundColor', label: 'Block Background', type: 'color' },
			],
		},
		...standardSharedGroups,
	],
};
