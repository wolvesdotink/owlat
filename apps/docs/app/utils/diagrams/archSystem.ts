/**
 * Data for the `::arch-system` diagram on the architecture page: the frontend
 * and backend layers, the default delivery card's copy, webhooks and
 * analytics. The send providers themselves come from `sendProviderDiagrams`.
 */

export const frontendLayer = {
	label: 'Frontend',
	tech: 'Nuxt 4 + Vue 3',
	color: 'brand',
	items: [
		{
			name: 'Pages',
			detail: 'Router',
			icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1',
		},
		{
			name: 'Composables',
			detail: 'State',
			icon: 'M4 7v10c0 2 1 3 3 3h10c2 0 3-1 3-3V7c0-2-1-3-3-3H7C5 4 4 5 4 7zm4 3h8m-8 4h5',
		},
		{
			name: 'Component Library',
			detail: 'UI Components',
			icon: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10',
		},
	],
};

export const backendLayer = {
	label: 'Convex Backend',
	tech: 'Serverless',
	color: 'accent',
	items: [
		{ name: 'Queries', detail: 'Real-time', icon: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z' },
		{
			name: 'Mutations',
			detail: 'ACID',
			icon: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
		},
		{ name: 'Actions', detail: 'External APIs', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
	],
	items2: [
		{
			name: 'Schema',
			detail: 'Database',
			icon: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4',
		},
		{
			name: 'BetterAuth',
			detail: 'Auth',
			icon: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z',
		},
		{
			name: 'HTTP Handlers',
			detail: 'REST API',
			icon: 'M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
		},
	],
};

export const ownDetail = 'Default — Direct SMTP delivery';
export const ownFeatures = ['Intelligence pipeline', 'IP warming', 'Bounce processing'];

export const webhooks = {
	name: 'Webhooks',
	detail: 'Events',
	icon: 'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1',
};

export const analytics = {
	name: 'PostHog',
	detail: 'Analytics & Errors',
	lines: ['Client (posthog-js)', 'Server (posthog-node)'],
};
