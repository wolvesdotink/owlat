import type { BlockAttributeSchema } from '../types';
import { backgroundColorField, sharedGroupsNoBorderRadius } from './_shared';

export const socialSchema: BlockAttributeSchema = {
	type: 'social',
	label: 'Social Icons',
	groups: [
		{
			label: 'Links',
			fields: [
				{
					key: 'links',
					label: 'Social Links',
					type: 'array',
					itemSchema: [
						{
							key: 'platform',
							label: 'Platform',
							type: 'select',
							options: [
								{ label: 'Twitter / X', value: 'twitter' },
								{ label: 'Facebook', value: 'facebook' },
								{ label: 'Instagram', value: 'instagram' },
								{ label: 'LinkedIn', value: 'linkedin' },
								{ label: 'YouTube', value: 'youtube' },
								{ label: 'TikTok', value: 'tiktok' },
								{ label: 'GitHub', value: 'github' },
								{ label: 'WhatsApp', value: 'whatsapp' },
								{ label: 'Telegram', value: 'telegram' },
								{ label: 'Threads', value: 'threads' },
								{ label: 'Pinterest', value: 'pinterest' },
								{ label: 'Discord', value: 'discord' },
								{ label: 'Mastodon', value: 'mastodon' },
								{ label: 'Bluesky', value: 'bluesky' },
								{ label: 'Vimeo', value: 'vimeo' },
								{ label: 'Medium', value: 'medium' },
								{ label: 'Snapchat', value: 'snapchat' },
							],
						},
						{ key: 'url', label: 'URL', type: 'url' },
						{ key: 'enabled', label: 'Enabled', type: 'toggle' },
						{ key: 'iconUrl', label: 'Custom Icon', type: 'url', placeholder: 'Optional custom icon URL' },
					],
					itemDefault: () => ({ platform: 'twitter', url: '', enabled: true }),
				},
			],
		},
		{
			label: 'Style',
			fields: [
				{
					key: 'iconStyle',
					label: 'Icon Style',
					type: 'select',
					options: [
						{ label: 'Filled', value: 'filled' },
						{ label: 'Outline', value: 'outline' },
					],
				},
				{ key: 'iconSize', label: 'Icon Size', type: 'number', min: 16, max: 128, unit: 'px' },
				{ key: 'iconSpacing', label: 'Icon Spacing', type: 'number', min: 0, max: 32, unit: 'px' },
				{ key: 'iconColor', label: 'Icon Color', type: 'color' },
				{ key: 'align', label: 'Alignment', type: 'align' },
				{
					key: 'mode',
					label: 'Layout',
					type: 'select',
					options: [
						{ label: 'Horizontal', value: 'horizontal' },
						{ label: 'Vertical', value: 'vertical' },
					],
				},
				{ key: 'showLabels', label: 'Show Labels', type: 'toggle' },
				backgroundColorField,
			],
		},
		...sharedGroupsNoBorderRadius,
	],
};
