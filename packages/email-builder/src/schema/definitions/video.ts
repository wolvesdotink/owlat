import type { BlockAttributeSchema } from '../types';
import { backgroundColorField, borderRadiusField, standardSharedGroups } from './_shared';

export const videoSchema: BlockAttributeSchema = {
	type: 'video',
	label: 'Video',
	groups: [
		{
			label: 'Content',
			fields: [
				{ key: 'videoUrl', label: 'Video URL', type: 'url', placeholder: 'https://youtube.com/watch?v=...' },
				{ key: 'thumbnailUrl', label: 'Thumbnail URL', type: 'url', placeholder: 'https://' },
				{ key: 'alt', label: 'Alt Text', type: 'text', placeholder: 'Video description' },
			],
		},
		{
			label: 'Layout',
			fields: [
				{ key: 'width', label: 'Width', type: 'slider', min: 10, max: 100, unit: '%' },
				{ key: 'align', label: 'Alignment', type: 'align' },
				{ key: 'playButtonColor', label: 'Play Button Color', type: 'color' },
				{ key: 'playButtonSize', label: 'Play Button Size', type: 'number', min: 24, max: 128, unit: 'px' },
				backgroundColorField,
				borderRadiusField,
			],
		},
		...standardSharedGroups,
	],
};
