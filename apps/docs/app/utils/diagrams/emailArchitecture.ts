/**
 * Data for the `::email-architecture` diagram on the email system page: the
 * inline editor features, block types, renderer guarantees and the delivery
 * card copy. The send providers themselves come from `sendProviderDiagrams`.
 */

export const builderFeatures = [
	{
		name: 'Slash Commands',
		detail: '/text, /image, /button ...',
		icon: 'M7 20l4-16m2 16l4-16M6 9h14M4 15h14',
	},
	{
		name: 'Format Bar',
		detail: 'Floating text styling',
		icon: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
	},
	{
		name: 'Media Library',
		detail: 'Image integration',
		icon: 'M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z',
	},
	{
		name: 'Focus Mode',
		detail: 'Cmd+Shift+F',
		icon: 'M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4',
	},
	{
		name: 'Auto-save',
		detail: 'Every 30 seconds',
		icon: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
	},
];

export const blockTypes = [
	'Text',
	'Image',
	'Button',
	'Divider',
	'Spacer',
	'Columns',
	'Social',
	'Container',
];

export const renderFeatures = [
	'Responsive layouts',
	'Cross-client compatible',
	'Dark mode ready',
	'A11y audits',
];

export const ownDetail = 'Direct SMTP · Intelligence pipeline · IP warming';
