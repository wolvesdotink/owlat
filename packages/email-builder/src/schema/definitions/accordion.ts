import type { BlockAttributeSchema } from '../types';
import { backgroundColorField, borderRadiusField, sharedGroupsNoBorderRadius } from './_shared';

export const accordionSchema: BlockAttributeSchema = {
	type: 'accordion',
	label: 'Accordion',
	groups: [
		{
			label: 'Sections',
			fields: [
				{
					key: 'sections',
					label: 'Sections',
					type: 'array',
					itemSchema: [
						{ key: 'title', label: 'Title', type: 'text' },
					],
					itemDefault: () => ({ id: '', title: 'New Section', items: [] }),
					helpText: 'Each section contains child blocks. Click a section to edit its content.',
				},
			],
		},
		{
			label: 'Behavior',
			fields: [
				{ key: 'allowMultiple', label: 'Allow Multiple Open', type: 'toggle' },
				{ key: 'initialExpanded', label: 'Initially Expanded', type: 'number', min: -1, max: 20, helpText: '-1 = all collapsed' },
			],
		},
		{
			label: 'Style',
			fields: [
				{ key: 'headerBackgroundColor', label: 'Header Background', type: 'color' },
				{ key: 'headerTextColor', label: 'Header Text Color', type: 'color' },
				{ key: 'headerFontSize', label: 'Header Font Size', type: 'number', min: 10, max: 32, unit: 'px' },
				{ key: 'contentBackgroundColor', label: 'Content Background', type: 'color' },
				{ key: 'iconColor', label: 'Icon Color', type: 'color' },
				{ key: 'sectionBorderColor', label: 'Section Border', type: 'color' },
				borderRadiusField,
				backgroundColorField,
			],
		},
		...sharedGroupsNoBorderRadius,
	],
};
