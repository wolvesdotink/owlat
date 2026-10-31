/**
 * Link targets for the docs home page: the five section cards and the popular
 * guides. Paths are locale-neutral; the page maps them through `localePath`.
 * Card copy comes from the `home.sections.<key>` and `home.guides.<key>` i18n
 * keys.
 */

export interface DocsHomeLink {
	key: string;
	path: string;
}

export interface DocsHomeSection extends DocsHomeLink {
	/** `d` attribute of a single 24×24 stroked path. */
	icon: string;
}

export const docsHomeSections: DocsHomeSection[] = [
	{
		key: 'guide',
		path: '/guide/getting-started',
		icon: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253',
	},
	{
		key: 'api',
		path: '/api',
		icon: 'M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
	},
	{
		key: 'developer',
		path: '/developer',
		icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
	},
	{
		key: 'sdks',
		path: '/api/sdk',
		icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
	},
	{
		key: 'examples',
		path: '/examples',
		icon: 'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z',
	},
];

export const docsHomePopularGuides: DocsHomeLink[] = [
	{ key: 'quickStart', path: '/guide/quick-start' },
	{ key: 'emailEditor', path: '/guide/email-editor' },
	{ key: 'campaigns', path: '/guide/campaigns' },
	{ key: 'transactional', path: '/guide/transactional' },
	{ key: 'contacts', path: '/guide/contacts' },
	{ key: 'deliverability', path: '/guide/deliverability' },
];
