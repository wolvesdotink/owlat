/**
 * Data for the `::arch-security-model` diagram on the vision page: the four
 * security layers and the icon for each item state.
 */

export const layers = [
	{
		id: 'tenant',
		label: 'Tenant Isolation',
		icon: 'M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
		color: 'brand',
		detail: 'Every operation scoped by organizationId',
		items: [
			{ label: 'Org A', state: 'active' },
			{ label: 'Org B', state: 'blocked' },
			{ label: 'Org C', state: 'blocked' },
		],
	},
	{
		id: 'sandbox',
		label: 'Agent Sandboxing',
		icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
		color: 'accent',
		detail: 'Credential-scoped, minimum permissions',
		items: [
			{ label: 'Booking API', state: 'scoped' },
			{ label: 'CRM read', state: 'scoped' },
			{ label: 'Admin API', state: 'denied' },
		],
	},
	{
		id: 'audit',
		label: 'Audit & Explainability',
		icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
		color: 'info',
		detail: 'Full provenance on every action',
		items: [
			{ label: 'Knowledge retrieved', state: 'logged' },
			{ label: 'Reasoning trace', state: 'logged' },
			{ label: 'Approval chain', state: 'logged' },
		],
	},
	{
		id: 'autonomy',
		label: 'Graduated Autonomy',
		icon: 'M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4',
		color: 'success',
		detail: 'Organizations control the trust boundary',
		items: [
			{ label: 'Auto-approve simple', state: 'auto' },
			{ label: 'Review complex', state: 'human' },
			{ label: 'Escalate sensitive', state: 'human' },
		],
	},
];

export const stateIcons: Record<string, string> = {
	active: 'M5 13l4 4L19 7',
	blocked:
		'M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636',
	scoped:
		'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z',
	denied: 'M6 18L18 6M6 6l12 12',
	logged:
		'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2',
	auto: 'M13 10V3L4 14h7v7l9-11h-7z',
	human: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
};
