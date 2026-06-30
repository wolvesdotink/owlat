import type { BlockAttributeSchema } from '../types';
import { spacingGroup, responsiveGroup } from './_shared';

export const rawHtmlSchema: BlockAttributeSchema = {
	type: 'rawHtml',
	label: 'HTML',
	groups: [
		{
			label: 'Content',
			fields: [
				{ key: 'html', label: 'HTML Code', type: 'textarea', helpText: 'Enter raw HTML. No sanitization is applied.' },
			],
		},
		spacingGroup,
		responsiveGroup,
	],
};
