import type { BlockAttributeSchema } from '../types';
import { backgroundColorField, sharedGroupsNoBorderRadius } from './_shared';

export const spacerSchema: BlockAttributeSchema = {
	type: 'spacer',
	label: 'Spacer',
	groups: [
		{
			label: 'Content',
			fields: [
				{ key: 'height', label: 'Height', type: 'slider', min: 4, max: 120, unit: 'px', toolbar: true },
				backgroundColorField,
			],
		},
		...sharedGroupsNoBorderRadius,
	],
};
