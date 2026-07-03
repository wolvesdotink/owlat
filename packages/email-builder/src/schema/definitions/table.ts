import type { BlockAttributeSchema } from '../types';
import { backgroundColorField, sharedGroupsNoBorderRadius } from './_shared';

export const tableSchema: BlockAttributeSchema = {
	type: 'table',
	label: 'Table',
	groups: [
		{
			label: 'Data',
			fields: [
				{
					key: 'headers',
					label: 'Headers',
					type: 'array',
					// `headers` is a string[] — append plain strings, not objects.
					itemType: 'string',
				},
				{
					key: 'rows',
					label: 'Rows',
					type: 'array',
					// `rows` is a string[][] — each row is an array of cell strings.
					itemType: 'string[]',
				},
				{
					key: 'footerRow',
					label: 'Footer Row',
					type: 'array',
					// `footerRow` is a string[] — append plain strings, not objects.
					itemType: 'string',
				},
				{ key: 'captionText', label: 'Caption', type: 'text', placeholder: 'Table description for accessibility' },
			],
		},
		{
			label: 'Style',
			fields: [
				{ key: 'headerBackgroundColor', label: 'Header Background', type: 'color' },
				{ key: 'headerTextColor', label: 'Header Text Color', type: 'color' },
				{ key: 'borderColor', label: 'Border Color', type: 'color' },
				{ key: 'striped', label: 'Striped Rows', type: 'toggle' },
				{ key: 'stripeColor', label: 'Stripe Color', type: 'color', showWhen: { key: 'striped', value: true } },
				{ key: 'cellPadding', label: 'Cell Padding', type: 'number', min: 0, max: 24, unit: 'px' },
				{
					key: 'textAlign',
					label: 'Text Alignment',
					type: 'align',
				},
				backgroundColorField,
			],
		},
		{
			label: 'Responsive',
			collapsed: true,
			fields: [
				{
					key: 'responsiveMode',
					label: 'Mobile Mode',
					type: 'select',
					options: [
						{ label: 'Default', value: 'default' },
						{ label: 'Stack', value: 'stack' },
						{ label: 'Scroll', value: 'scroll' },
						{ label: 'Hide Columns', value: 'hide-columns' },
					],
				},
			],
		},
		...sharedGroupsNoBorderRadius,
	],
};
