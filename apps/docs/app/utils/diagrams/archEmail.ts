/**
 * Data for the `::arch-email` diagram on the architecture page: the builder
 * entry points and the delivery card copy. The send providers themselves come
 * from `sendProviderDiagrams`.
 */

export const builderItems = [
	{
		name: 'Inline Editor',
		icon: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
	},
	{
		name: 'Blocks (JSON)',
		icon: 'M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2z',
	},
	{ name: 'Saved Blocks', icon: 'M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z' },
];

export const ownDetail = 'Direct SMTP · Intelligence pipeline · IP warming';

export const sesFeatures = [
	'Domain registration (VerifyDomainIdentity/DKIM)',
	'MAIL FROM configuration',
	'Verification status polling',
];
