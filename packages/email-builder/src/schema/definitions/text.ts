import type { BlockAttributeSchema } from '../types';
import { backgroundColorField, borderRadiusField, standardSharedGroups } from './_shared';

export const textSchema: BlockAttributeSchema = {
	type: 'text',
	label: 'Text',
	groups: [
		{
			label: 'Content',
			fields: [
				{ key: 'html', label: 'Text Content', type: 'richtext' },
				{
					key: 'blockType',
					label: 'Type',
					type: 'select',
					options: [
						{ label: 'Paragraph', value: 'paragraph' },
						{ label: 'Heading 1', value: 'h1' },
						{ label: 'Heading 2', value: 'h2' },
						{ label: 'Heading 3', value: 'h3' },
					],
				},
			],
		},
		{
			label: 'Typography',
			fields: [
				{ key: 'fontFamily', label: 'Font Family', type: 'fontFamily' },
				{ key: 'fontSize', label: 'Font Size', type: 'number', min: 8, max: 72, unit: 'px' },
				{ key: 'mobileFontSize', label: 'Mobile Font Size', type: 'number', min: 8, max: 72, unit: 'px' },
				{ key: 'textColor', label: 'Text Color', type: 'color' },
				{
					key: 'fontWeight',
					label: 'Weight',
					type: 'select',
					options: [
						{ label: 'Normal', value: 400 },
						{ label: 'Bold', value: 700 },
					],
				},
				{ key: 'lineHeight', label: 'Line Height', type: 'number', min: 1, max: 3, step: 0.1 },
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
				{
					key: 'textDecoration',
					label: 'Decoration',
					type: 'select',
					options: [
						{ label: 'None', value: 'none' },
						{ label: 'Underline', value: 'underline' },
						{ label: 'Strikethrough', value: 'line-through' },
					],
				},
			],
		},
		{
			label: 'Layout',
			fields: [
				{ key: 'textAlign', label: 'Alignment', type: 'align', toolbar: true },
				backgroundColorField,
				borderRadiusField,
			],
		},
		...standardSharedGroups,
	],
};
